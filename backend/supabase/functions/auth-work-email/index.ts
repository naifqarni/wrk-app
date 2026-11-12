// POST { action: "request", email }       (member token) -> sends a code to the work address
// POST { action: "verify", email, code }  (member token) -> attaches the employer to the member
// For members who joined as store buyers with a personal email, and for anyone who changes jobs.
import { corsHeaders, fail, handleWorkEmail, requirePepper } from "../_shared/logic.ts";
import { callerId, env, rpc, sendCode } from "../_shared/runtime.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("not-found");
  try {
    return await handleWorkEmail(req, {
      rpc,
      pepper: requirePepper(env("EMAIL_PEPPER")),
      sendCode,
      echoCode: env("DEV_ECHO_CODE") === "true",
      callerId,
      createUser: () => Promise.reject(new Error("unused")),
      signInToken: () => Promise.reject(new Error("unused")),
      checkBuyer: () => Promise.reject(new Error("unused")),
    });
  } catch (err) {
    console.error("auth-work-email:", (err as Error).message);
    return fail("unknown");
  }
});
