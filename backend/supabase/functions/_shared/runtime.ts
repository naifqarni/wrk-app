// Deno-side wiring shared by the edge functions.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { codeEmail, type Json, type Rpc } from "./logic.ts";

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() !== "" ? v.trim() : undefined;
}

let adminClient: SupabaseClient | null = null;
export function admin(): SupabaseClient {
  adminClient ??= createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

export const rpc: Rpc = async (fn: string, args: Json) => {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

export function isCron(req: Request): boolean {
  const secret = env("CRON_SECRET");
  return !!secret && secret.length >= 24 && req.headers.get("x-cron-secret") === secret;
}

export async function callerId(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  return error ? null : data.user?.id ?? null;
}

// Sends the sign-in code through Resend. The address goes to the mail provider and nowhere else.
export async function sendCode(to: string, code: string): Promise<void> {
  const key = env("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const mail = codeEmail(code);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("MAIL_FROM") ?? "wrk. <noreply@wrk.sa>", to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
}

// Asks the wrk. shop (Medusa, api.wrk.sa: POST /wrk/buyer) whether this address
// has a paid order. Nothing about the answer is stored here.
export async function checkBuyer(email: string): Promise<boolean> {
  const base = env("SHOP_URL")?.replace(/\/+$/, "");
  const secret = env("SHOP_BRIDGE_SECRET");
  if (!base || !secret) throw new Error("SHOP_URL / SHOP_BRIDGE_SECRET are not set");
  const res = await fetch(`${base}/wrk/buyer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Wrk-Bridge-Secret": secret },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`shop answered ${res.status}`);
  const out = await res.json();
  return out?.buyer === true;
}
