import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import kb, { isUsedByApp, type Unzip } from "./kb.ts";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const realFetch = globalThis.fetch;

// The fake "zip" is JSON of entry path → content; the fake unzip applies the filter like fflate.
const unzip: Unzip = (zip, { filter }) => {
  const entries: Record<string, string> = JSON.parse(new TextDecoder().decode(zip));
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([name]) => filter({ name }))
      .map(([name, content]) => [name, new TextEncoder().encode(content)]),
  );
};

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  GITHUB_TOKEN: "github-test",
  unzip,
};

const repo = {
  "LibSysAIKB-b/": "",
  "LibSysAIKB-b/SOP/": "",
  "LibSysAIKB-b/SOP/Holds.html": "<h1>Holds</h1>",
  "LibSysAIKB-b/SOP/Notes.TXT": "Notes",
  "LibSysAIKB-b/SOP/Manual.pdf": "%PDF-1.7 binary",
  "LibSysAIKB-b/SOP/DB/vqd.json": '{"vqd":1}',
  "LibSysAIKB-b/SOP/DB/lkp.json": '{"lkp":1}',
  "LibSysAIKB-b/package.json": "{}",
  "LibSysAIKB-b/.github/workflows/deploy.yml": "on: push",
};

type Call = { method: string; url: string };
let calls: Call[];
let signedIn: boolean;
let latestSha: string;
let canClaim: boolean;
let row: Record<string, unknown>;
let objects: Map<string, Uint8Array>;

beforeEach(() => {
  calls = [];
  signedIn = true;
  latestSha = NEW_SHA;
  canClaim = false;
  row = { sha: null, build: null, path: null };
  objects = new Map();
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: input });
    const headers = new Headers(init.headers);
    if (input.endsWith("/auth/v1/user")) {
      return signedIn ? Response.json({ id: "user-1" }) : new Response("bad jwt", { status: 401 });
    }
    if (input.startsWith(`${env.SUPABASE_URL}/rest/v1/`) || input.startsWith(`${env.SUPABASE_URL}/storage/v1/`)) {
      assert.equal(headers.get("Authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    }
    if (input.includes("/rest/v1/kb_cache")) {
      if (method === "PATCH") {
        Object.assign(row, JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      }
      return Response.json([{ sha: row.sha, build: row.build, path: row.path }]);
    }
    if (input.endsWith("/rest/v1/rpc/claim_kb_refresh")) {
      const claimed = canClaim;
      canClaim = false;
      return Response.json(claimed);
    }
    if (input.includes("/storage/v1/object/knowledge-base/")) {
      const path = input.split("/knowledge-base/")[1];
      if (method === "POST") {
        if (objects.has(path) && headers.get("x-upsert") !== "true") {
          return Response.json({ statusCode: "409", error: "Duplicate" }, { status: 400 });
        }
        objects.set(path, init.body as Uint8Array);
        return Response.json({ Key: `knowledge-base/${path}` });
      }
      if (method === "DELETE") {
        objects.delete(path);
        return Response.json({ message: "Successfully deleted" });
      }
      const object = objects.get(path);
      return object ? new Response(object) : Response.json({ error: "not_found" }, { status: 400 });
    }
    if (input.endsWith("/commits/main")) return new Response(latestSha);
    if (input.includes("/zipball/")) return new Response(JSON.stringify(repo));
    throw new Error(`Unexpected fetch: ${method} ${input}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function load(headers: Record<string, string> = { Authorization: "Bearer staff-token", "Accept-Encoding": "gzip, br" }) {
  const pending: Promise<unknown>[] = [];
  const res = await kb.fetch(
    new Request("https://example.supabase.co/functions/v1/SOP-Fetch", { headers }),
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  return { res, background: () => Promise.all(pending) };
}

async function files(res: Response) {
  if (res.headers.get("Content-Encoding") === "gzip") {
    return new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json();
  }
  return res.json();
}

const github = () => calls.filter((c) => c.url.startsWith("https://api.github.com/"));

test("keeps only the files the app reads", () => {
  assert.equal(isUsedByApp("root/SOP/Holds.html"), true);
  assert.equal(isUsedByApp("root/SOP/Notes.TXT"), true);
  assert.equal(isUsedByApp("root/a.md"), true);
  assert.equal(isUsedByApp("root/a.csv"), true);
  assert.equal(isUsedByApp("root/a.log"), true);
  assert.equal(isUsedByApp("root/SOP/DB/vqd.json"), true);
  assert.equal(isUsedByApp("root/SOP/DB/lkp.json"), true);
  assert.equal(isUsedByApp("root/SOP/Manual.pdf"), false);
  assert.equal(isUsedByApp("root/package.json"), false);
  assert.equal(isUsedByApp("root/SOP/"), false);
});

test("refuses callers who aren't signed in", async () => {
  signedIn = false;
  const { res } = await load();
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Sign in to load the knowledge base." });
  assert.equal(calls.length, 1);

  const { res: noToken } = await load({});
  assert.equal(noToken.status, 401);
  assert.equal(calls.length, 1);
});

test("answers the CORS preflight", async () => {
  const res = await kb.fetch(
    new Request("https://example.supabase.co/functions/v1/SOP-Fetch", { method: "OPTIONS" }),
    env,
    { waitUntil: () => {} },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(calls.length, 0);
});

test("serves the cached copy without going to GitHub", async () => {
  const cached = [{ name: "Holds.html", path: "SOP/Holds.html", content: "<h1>Holds</h1>" }];
  row = { sha: OLD_SHA, build: 1, path: "guides-old.json.gz" };
  objects.set("guides-old.json.gz", await gzip(JSON.stringify(cached)));

  const { res, background } = await load();
  await background();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.equal(res.headers.get("Content-Encoding"), "gzip");
  assert.deepEqual(await files(res), cached);
  assert.equal(github().length, 0);
});

test("sends plain JSON to a client that doesn't accept gzip", async () => {
  const cached = [{ name: "lkp.json", path: "SOP/DB/lkp.json", content: "{}" }];
  row = { sha: OLD_SHA, build: 1, path: "guides-old.json.gz" };
  objects.set("guides-old.json.gz", await gzip(JSON.stringify(cached)));

  const { res } = await load({ Authorization: "Bearer staff-token" });
  assert.equal(res.headers.get("Content-Encoding"), null);
  assert.deepEqual(await res.json(), cached);
});

test("the first load builds the copy from GitHub, keeping only the files the app reads", async () => {
  canClaim = true;
  const { res } = await load();
  assert.equal(res.status, 200);
  assert.deepEqual(await files(res), [
    { name: "Holds.html", path: "SOP/Holds.html", content: "<h1>Holds</h1>" },
    { name: "Notes.TXT", path: "SOP/Notes.TXT", content: "Notes" },
    { name: "vqd.json", path: "SOP/DB/vqd.json", content: '{"vqd":1}' },
    { name: "lkp.json", path: "SOP/DB/lkp.json", content: '{"lkp":1}' },
  ]);

  const path = `guides-${NEW_SHA}-v1.json.gz`;
  assert.ok(objects.has(path));
  assert.equal(row.sha, NEW_SHA);
  assert.equal(row.build, 1);
  assert.equal(row.path, path);
  assert.equal(row.files, 4);
  assert.equal(row.refreshing_since, null);
  assert.ok(calls.some((c) => c.url.endsWith(`/zipball/${NEW_SHA}`)));
});

test("an unchanged repo is only checked, not rebuilt", async () => {
  row = { sha: NEW_SHA, build: 1, path: "guides-current.json.gz" };
  objects.set("guides-current.json.gz", await gzip("[]"));
  canClaim = true;

  const { res, background } = await load();
  assert.deepEqual(await files(res), []);
  await background();
  assert.equal(github().length, 1);
  assert.ok(github()[0].url.endsWith("/commits/main"));
  assert.equal(row.path, "guides-current.json.gz");
  assert.ok(row.checked_at);
  assert.equal(row.refreshing_since, null);
});

test("a new commit is built in the background while the old copy is served", async () => {
  const old = [{ name: "Old.html", path: "SOP/Old.html", content: "old" }];
  row = { sha: OLD_SHA, build: 1, path: "guides-old.json.gz" };
  objects.set("guides-old.json.gz", await gzip(JSON.stringify(old)));
  canClaim = true;

  const { res, background } = await load();
  assert.deepEqual(await files(res), old);
  await background();

  const path = `guides-${NEW_SHA}-v1.json.gz`;
  assert.equal(row.sha, NEW_SHA);
  assert.equal(row.path, path);
  assert.deepEqual([...objects.keys()], [path]);

  const { res: next } = await load();
  assert.equal((await files(next)).length, 4);
});

test("a forced rebuild of the same commit replaces its copy", async () => {
  const path = `guides-${NEW_SHA}-v1.json.gz`;
  row = { sha: NEW_SHA, build: null, path };
  objects.set(path, await gzip("[]"));
  canClaim = true;

  const { res, background } = await load();
  assert.deepEqual(await files(res), []);
  await background();
  assert.equal(row.build, 1);
  assert.equal(row.refreshing_since, null);
  assert.deepEqual([...objects.keys()], [path]);

  const { res: next } = await load();
  assert.equal((await files(next)).length, 4);
});

test("a failed GitHub check keeps serving the copy and waits for the next check", async () => {
  const cached = [{ name: "Holds.html", path: "SOP/Holds.html", content: "<h1>Holds</h1>" }];
  row = { sha: OLD_SHA, build: 1, path: "guides-old.json.gz" };
  objects.set("guides-old.json.gz", await gzip(JSON.stringify(cached)));
  canClaim = true;
  latestSha = "Bad credentials";

  const { res, background } = await load();
  assert.deepEqual(await files(res), cached);
  await background();
  assert.equal(row.sha, OLD_SHA);
  assert.ok(row.checked_at);
  assert.equal(row.refreshing_since, null);
});

test("picks up the new copy if the old one was just removed", async () => {
  row = { sha: NEW_SHA, build: 1, path: "guides-new.json.gz" };
  objects.set("guides-new.json.gz", await gzip("[]"));
  const realFetchStub = globalThis.fetch;
  // The row is read once with the old path, then the rebuild has moved it on.
  let reads = 0;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if (input.includes("/rest/v1/kb_cache") && !init?.method && reads++ === 0) {
      return Response.json([{ sha: OLD_SHA, build: 1, path: "guides-gone.json.gz" }]);
    }
    return realFetchStub(input, init);
  }) as typeof fetch;

  const { res } = await load();
  assert.equal(res.status, 200);
  assert.deepEqual(await files(res), []);
});

test("says so when there's no copy and the build fails", async () => {
  canClaim = true;
  latestSha = "Bad credentials";
  const { res } = await load();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(row.refreshing_since, null);
});
