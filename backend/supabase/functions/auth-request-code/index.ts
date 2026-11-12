// POST { email, access?: "member" | "invite" | "buyer", inviteCode? }  ->  { ok, expiresInSeconds, companyName }
// member: the address must already have an account. invite: unused code + work email.
// buyer: the wrk. shop confirms an order for this address (personal mail allowed).
// Sends a 6-digit code to the address. It is used for this one
// message and is never written to the database or the logs.
import { corsHeaders, fail, handleRequestCode, requirePepper } from "../_shared/logic.ts";
import { checkBuyer, env, rpc, sendCode } from "../_shared/runtime.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("not-found");
  try {
    return await handleRequestCode(req, {
      rpc,
      pepper: requirePepper(env("EMAIL_PEPPER")),
      sendCode,
      echoCode: env("DEV_ECHO_CODE") === "true",
      createUser: () => Promise.reject(new Error("unused")),
      signInToken: () => Promise.reject(new Error("unused")),
      checkBuyer,
    });
  } catch (err) {
    console.error("auth-request-code:", (err as Error).message);
    return fail("unknown");
  }
});
