// Supabase edge function entry for SOP-Fetch, which serves the LibSysAIKB guides to the chat
// app. The logic is in kb.ts.
// Deploy with Verify JWT off: kb.ts checks the sign-in itself and works with any of the
// project's JWT signing keys.
// Deploy ../_shared/library.ts with it (the Supabase CLI does this by itself); the guides
// repo is set there.
// Secret (Edge Functions → Secrets): GITHUB_TOKEN. Needs the kb_cache table and the private
// knowledge-base bucket from schema.sql.
import { unzipSync } from "npm:fflate@0.8.2";
import kb from "./kb.ts";

const env = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL")!,
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY")!,
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN"),
  unzip: unzipSync,
};

// Lets a rebuild finish after the current copy has been sent.
const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime.
    EdgeRuntime.waitUntil(promise);
  },
};

Deno.serve((request) => kb.fetch(request, env, ctx));
