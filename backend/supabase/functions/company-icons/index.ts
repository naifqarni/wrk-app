// POST { limit? }  with x-cron-secret, or a moderator's token.
//
// Copies each reviewed company's public site icon into our own storage bucket
// ("company-icons") so the app never loads anything from a company's server,
// and deletes our copy when a company's icon has been hidden.
// The bytes are stored exactly as published: no resizing, recolouring, cropping.
import { corsHeaders, fail, handleCompanyIcons, safePublicHost, type FetchedFile } from "../_shared/logic.ts";
import { admin, callerId, env, isCron, rpc } from "../_shared/runtime.ts";

const BUCKET = "company-icons";
let bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await admin().storage.createBucket(BUCKET, {
    public: true, fileSizeLimit: 512 * 1024, allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  });
  if (error && !/exist/i.test(error.message)) throw new Error(`bucket: ${error.message}`);
  bucketReady = true;
}

async function get(url: string, maxBytes: number): Promise<FetchedFile> {
  const miss: FetchedFile = { ok: false, status: 0, url, contentType: "", bytes: new Uint8Array() };
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; icon-fetcher/1.0)", Accept: "text/html,image/png,image/webp,image/jpeg,*/*;q=0.5" },
    });
    const final = new URL(res.url || url);
    if (!res.ok || final.protocol !== "https:" || !safePublicHost(final.hostname)) {
      await res.body?.cancel();
      return { ...miss, status: res.status };
    }
    // read up to the cap and stop
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); if (/image\//.test(res.headers.get("content-type") ?? "")) return miss; break; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return { ok: true, status: res.status, url: final.toString(), contentType: res.headers.get("content-type") ?? "", bytes };
  } catch {
    return miss;
  }
}

async function store(companyId: string, file: { bytes: Uint8Array; contentType: string; ext: string }): Promise<string> {
  await ensureBucket();
  const path = `${companyId}.${file.ext}`;
  const { error } = await admin().storage.from(BUCKET).upload(path, file.bytes, {
    contentType: file.contentType, upsert: true, cacheControl: "604800",
  });
  if (error) throw new Error(`upload: ${error.message}`);
  return `${env("SUPABASE_URL")!.replace(/\/+$/, "")}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function remove(iconUrl: string): Promise<void> {
  const path = iconUrl.split(`/${BUCKET}/`)[1]?.split("?")[0];
  if (!path) return;
  const { error } = await admin().storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`remove: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("not-found");
  try {
    return await handleCompanyIcons(req, { rpc, isCron, callerId, get, store, remove });
  } catch (err) {
    console.error("company-icons:", (err as Error).message);
    return fail("unknown");
  }
});
