// Supabase edge function entry for the LibSys chat. The logic is in chat.ts.
// Deploy with Verify JWT off: chat.ts checks the caller's sign-in itself.
// Deploy ../_shared/library.ts with it (the Supabase CLI does this by itself).
// Secrets (Edge Functions → Secrets): OPENROUTER_API_KEY, SUPPORT_EMAIL.
import { library } from "../_shared/library.ts";
import chat from "./chat.ts";

const env = {
  OPENROUTER_API_KEY: Deno.env.get("OPENROUTER_API_KEY") ?? "",
  SUPABASE_URL: Deno.env.get("SUPABASE_URL")!,
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY")!,
  ALLOWED_ORIGINS: `${library.siteOrigin},http://localhost:3000`,
  OPENROUTER_MODEL: Deno.env.get("OPENROUTER_MODEL") ?? "openrouter/free",
  SUPPORT_EMAIL: Deno.env.get("SUPPORT_EMAIL"),
};

// Lets the model_usage log finish after the reply has been sent.
const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime.
    EdgeRuntime.waitUntil(promise);
  },
};

Deno.serve((request) => chat.fetch(request, env, ctx));
