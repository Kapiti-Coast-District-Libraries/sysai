// Serves the LibSysAIKB guides to the chat app, for signed-in staff only (runs as the
// SOP-Fetch edge function; index.ts wires it up).
//
// Unzipping the whole repo on every page load ran into the edge runtime's CPU limit (546)
// when page loads overlapped. So the guide list is built once, gzipped and kept in the
// private `knowledge-base` Storage bucket, and the `kb_cache` row says which commit it was
// built from. Every few minutes one request asks GitHub for the latest commit; if it has
// changed, that request rebuilds the copy in the background while staff keep getting the
// current one.

import { library } from "../_shared/library.ts";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GITHUB_TOKEN?: string;
  unzip: Unzip;
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

// fflate's unzipSync: the filter decides which entries get decompressed at all.
export type Unzip = (
  zip: Uint8Array,
  opts: { filter: (file: { name: string }) => boolean },
) => Record<string, Uint8Array>;

type KbFile = { name: string; path: string; content: string };

type CacheState = { sha: string | null; build: number | null; path: string | null };

const { owner: OWNER, repo: REPO, branch: BRANCH } = library.guides;
const BUCKET = "knowledge-base";

// Bump when the files kept or their format change, so the next check rebuilds the copy.
const BUILD = 1;
// How often a page load asks GitHub whether the guides have changed.
const CHECK_EVERY = "5 minutes";
// How long a rebuild may take before another page load is allowed to try.
const LOCK_FOR = "2 minutes";

// The app reads guides as text plus the two query-config files, and skips everything else (PDFs).
const GUIDE_FILE = /\.(html|txt|md|csv|log)$/i;
const CONFIG_FILES = ["vqd.json", "lkp.json"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export function isUsedByApp(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return GUIDE_FILE.test(name) || CONFIG_FILES.includes(name);
}

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    // The public key alone isn't enough: the caller must be a signed-in user.
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token || !(await isSignedIn(token, env))) {
      return json({ error: "Sign in to load the knowledge base." }, 401);
    }

    try {
      const state = await readState(env);
      if (!state.path) return await firstBuild(request, env);

      const claimed = await claimRefresh(env).catch((err) => {
        console.error("claim_kb_refresh failed:", err);
        return false;
      });
      if (claimed) ctx.waitUntil(refresh(state, env).catch(() => {}));

      return await serveCopy(state.path, request, env);
    } catch (err) {
      console.error("SOP-Fetch error:", err);
      return json({ error: "The guides couldn't be loaded. Try again in a moment." }, 503);
    }
  },
};

// No copy yet (a new project): one page load builds it while the others wait for it.
async function firstBuild(request: Request, env: Env): Promise<Response> {
  if (await claimRefresh(env)) {
    const gz = await refresh({ sha: null, build: null, path: null }, env);
    return sendGzipped(new Blob([gz!]).stream(), request);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await readState(env);
    if (state.path) return serveCopy(state.path, request, env);
  }
  throw new Error("Timed out waiting for the first build");
}

// Only the page load that won claimRefresh gets here, and it always releases the claim.
// Returns the new gzipped copy, or null if the guides hadn't changed.
async function refresh(state: CacheState, env: Env): Promise<Uint8Array | null> {
  const now = new Date().toISOString();
  try {
    const sha = await latestCommit(env);
    if (sha === state.sha && state.build === BUILD) {
      await saveState(env, { checked_at: now, refreshing_since: null });
      return null;
    }

    const started = Date.now();
    const files = await downloadGuides(sha, env);
    const { gz, bytes } = await gzipJson(files);
    // A new name for each build, so nothing can serve a stale cached copy.
    const path = `guides-${sha}-v${BUILD}.json.gz`;
    await storage("POST", path, env, gz);
    await saveState(env, {
      sha,
      build: BUILD,
      path,
      files: files.length,
      built_at: now,
      checked_at: now,
      refreshing_since: null,
    });
    console.log(
      `Built the guides from ${sha.slice(0, 7)}: ${files.length} files, ${bytes} bytes of JSON, ` +
        `${gz.length} gzipped, in ${Date.now() - started} ms`,
    );

    if (state.path && state.path !== path) {
      await storage("DELETE", state.path, env).catch((err) => console.warn("Couldn't remove the old copy:", err));
    }
    return gz;
  } catch (err) {
    console.error("Refreshing the guides failed:", err);
    // Try again at the next check rather than on every page load.
    await saveState(env, { checked_at: now, refreshing_since: null }).catch(() => {});
    throw err;
  }
}

async function serveCopy(path: string, request: Request, env: Env): Promise<Response> {
  let res = await storage("GET", path, env).catch(() => null);
  if (!res) {
    // A rebuild may have just replaced it: look up the new copy.
    const state = await readState(env);
    if (!state.path || state.path === path) throw new Error(`Couldn't read ${path} from Storage`);
    res = await storage("GET", state.path, env);
  }
  return sendGzipped(res.body!, request);
}

function sendGzipped(body: ReadableStream<Uint8Array>, request: Request): Response {
  const headers = { "Content-Type": "application/json", Vary: "Accept-Encoding", ...corsHeaders };
  if (/\bgzip\b/i.test(request.headers.get("Accept-Encoding") ?? "")) {
    return new Response(body, { headers: { ...headers, "Content-Encoding": "gzip" } });
  }
  return new Response(body.pipeThrough(new DecompressionStream("gzip")), { headers });
}

async function downloadGuides(sha: string, env: Env): Promise<KbFile[]> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/zipball/${sha}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
  });
  if (!res.ok) throw new Error(`GitHub zip download returned ${res.status}`);

  // Only the files the app reads are decompressed; the PDFs are never unpacked.
  const entries = env.unzip(new Uint8Array(await res.arrayBuffer()), {
    filter: (file) => isUsedByApp(file.name),
  });

  const decoder = new TextDecoder();
  return Object.entries(entries).map(([entryPath, data]) => {
    // GitHub's zip puts everything in a root folder like "owner-repo-sha/".
    const path = entryPath.split("/").slice(1).join("/");
    return { name: path.split("/").pop()!, path, content: decoder.decode(data) };
  });
}

// Written a file at a time, so the whole JSON never sits in memory as one string.
async function gzipJson(files: KbFile[]): Promise<{ gz: Uint8Array; bytes: number }> {
  const gzip = new CompressionStream("gzip");
  const output = new Response(gzip.readable).arrayBuffer();
  const writer = gzip.writable.getWriter();
  const encoder = new TextEncoder();
  let bytes = 0;
  const write = (text: string) => {
    const chunk = encoder.encode(text);
    bytes += chunk.length;
    return writer.write(chunk);
  };

  await write("[");
  for (let i = 0; i < files.length; i++) {
    await write((i ? "," : "") + JSON.stringify(files[i]));
  }
  await write("]");
  await writer.close();
  return { gz: new Uint8Array(await output), bytes };
}

async function latestCommit(env: Env): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${BRANCH}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.sha" },
  });
  if (!res.ok) throw new Error(`GitHub commit check returned ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitHub commit check returned no SHA");
  return sha;
}

async function isSignedIn(token: string, env: Env): Promise<boolean> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// kb_cache and the bucket are only open to the service role.
function serviceHeaders(env: Env): Record<string, string> {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

async function readState(env: Env): Promise<CacheState> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/kb_cache?id=eq.1&select=sha,build,path`, {
    headers: serviceHeaders(env),
  });
  if (!res.ok) throw new Error(`Reading kb_cache returned ${res.status}`);
  const [row] = await res.json();
  return row ?? { sha: null, build: null, path: null };
}

async function saveState(env: Env, fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/kb_cache?id=eq.1`, {
    method: "PATCH",
    headers: { ...serviceHeaders(env), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Saving kb_cache returned ${res.status}`);
}

// True for the one page load that should check GitHub now (see claim_kb_refresh in schema.sql).
async function claimRefresh(env: Env): Promise<boolean> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_kb_refresh`, {
    method: "POST",
    headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ check_every: CHECK_EVERY, lock_for: LOCK_FOR }),
  });
  if (!res.ok) throw new Error(`claim_kb_refresh returned ${res.status}`);
  return (await res.json()) === true;
}

async function storage(method: "GET" | "POST" | "DELETE", path: string, env: Env, body?: Uint8Array): Promise<Response> {
  const headers: Record<string, string> = serviceHeaders(env);
  // A forced rebuild of the same commit (or a retry after a half-finished one) reuses the name.
  if (body) Object.assign(headers, { "Content-Type": "application/gzip", "x-upsert": "true" });
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method, headers, body });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Storage ${method} ${path} returned ${res.status}`);
  }
  return res;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
