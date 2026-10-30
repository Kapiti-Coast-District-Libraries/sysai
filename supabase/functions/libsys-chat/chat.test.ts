import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "./chat.ts";

const env = {
  OPENROUTER_API_KEY: "test-openrouter-key",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_test",
  ALLOWED_ORIGINS: "https://kapiti-coast-district-libraries.github.io,http://localhost:3000",
  OPENROUTER_MODEL: "openrouter/free",
  SUPPORT_EMAIL: "max@example.com",
};

const ORIGIN = "https://kapiti-coast-district-libraries.github.io";
const realFetch = globalThis.fetch;

type Call = { url: string; init: RequestInit };
let calls: Call[];
let openRouterReply: () => Response;
let signedIn: boolean;
let allowance: () => Response;
let savedSettings: () => Response;
let savedModels: () => Response;

beforeEach(() => {
  calls = [];
  signedIn = true;
  allowance = () => Response.json({ allowed: true, used: 0, limit: null });
  savedSettings = () => Response.json([]);
  savedModels = () => Response.json({});
  openRouterReply = () => Response.json({ model: "nvidia/nemotron-3-ultra-550b-a55b:free", choices: [] });
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    if (input.endsWith("/auth/v1/user")) {
      return signedIn ? Response.json({ id: "user-1" }) : new Response("bad jwt", { status: 401 });
    }
    if (input.endsWith("/rest/v1/model_usage")) return new Response(null, { status: 201 });
    if (input.endsWith("/rest/v1/rpc/request_allowance")) return allowance();
    if (input.includes("/rest/v1/user_settings")) return savedSettings();
    if (input.endsWith("/rest/v1/rpc/chat_models")) return savedModels();
    if (input.startsWith("https://openrouter.ai/")) return openRouterReply();
    throw new Error(`Unexpected fetch: ${input}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function send(body: unknown, headers: Record<string, string> = { Authorization: "Bearer staff-token" }) {
  const pending: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request("https://example.supabase.co/functions/v1/libsys-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

function answer(message: Record<string, unknown>) {
  return () =>
    Response.json({
      model: "thinkingmachines/inkling:free",
      choices: [{ message }],
      usage: { prompt_tokens: 1200, completion_tokens: 80 },
    });
}

const openRouterCall = () => calls.find((c) => c.url.startsWith("https://openrouter.ai/"));
const logCall = () => calls.find((c) => c.url.endsWith("/rest/v1/model_usage"));

test("answers CORS preflight for the GitHub Pages site", async () => {
  const res = await worker.fetch(
    new Request("https://w.example/", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/);
});

test("doesn't allow other sites to read replies", async () => {
  const res = await worker.fetch(
    new Request("https://w.example/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("rejects requests with no sign-in token, without calling OpenRouter", async () => {
  const res = await send({ message: "hi" }, {});
  assert.equal(res.status, 401);
  assert.equal(openRouterCall(), undefined);
});

test("rejects tokens Supabase doesn't recognise", async () => {
  signedIn = false;
  const res = await send({ message: "hi" });
  assert.equal(res.status, 401);
  assert.equal(openRouterCall(), undefined);
  const auth = calls.find((c) => c.url.endsWith("/auth/v1/user"))!;
  assert.equal((auth.init.headers as Record<string, string>).Authorization, "Bearer staff-token");
});

test("sends the chat to the free router and returns the answer", async () => {
  openRouterReply = answer({ content: "Use **Circulation > Loans**." });
  const res = await send({
    message: "How do I renew a loan?",
    instructions: "You are LibSys Support AI.",
    history: [
      { role: "model", content: "Hi! How can I help?" },
      { role: "model", content: "" },
      { role: "user", content: "Question about loans" },
    ],
    tools: [{ functionDeclarations: [{ name: "something_else" }] }],
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Use **Circulation > Loans**." });

  const sent = JSON.parse(openRouterCall()!.init.body as string);
  assert.equal(sent.model, "openrouter/free");
  assert.deepEqual(sent.messages, [
    { role: "system", content: "You are LibSys Support AI." },
    { role: "assistant", content: "Hi! How can I help?" },
    { role: "user", content: "Question about loans" },
    { role: "user", content: "How do I renew a loan?" },
  ]);
  // Neither action is offered for a question about loans.
  assert.equal(sent.tools, undefined);
  assert.deepEqual(sent.reasoning, { effort: "low", exclude: true });
  assert.equal((openRouterCall()!.init.headers as Record<string, string>).Authorization, "Bearer test-openrouter-key");

  const logged = JSON.parse(logCall()!.init.body as string);
  assert.deepEqual(logged, {
    model: "thinkingmachines/inkling:free",
    tool: null,
    prompt_tokens: 1200,
    completion_tokens: 80,
    error: null,
  });
  assert.equal((logCall()!.init.headers as Record<string, string>).Authorization, "Bearer staff-token");
});

test("turns an ink request into an email for staff to copy", async () => {
  openRouterReply = answer({
    content: null,
    tool_calls: [{ function: { name: "send_ink_request", arguments: '{"color":"Cyan","location":"Waikanae"}' } }],
  });
  const res = await send({
    message: "Waikanae",
    history: [
      { role: "user", content: "I would like to request printer ink." },
      { role: "model", content: "What colour toner do you need? [[Black]] [[Cyan]]" },
      { role: "user", content: "Cyan" },
      { role: "model", content: "Which library is this for? [[Paraparaumu]] [[Waikanae]]" },
    ],
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  const sent = JSON.parse(openRouterCall()!.init.body as string);
  assert.deepEqual(sent.tools.map((t: { function: { name: string } }) => t.function.name), ["send_ink_request"]);
  assert.match(body.text, /\*\*Cyan\*\* toner for \*\*Waikanae\*\*/);
  assert.match(body.text, /email to \*\*max@example\.com\*\*/);
  assert.ok(body.text.includes("```subject\nAI Support Toner Request - Cyan | Waikanae\n```"));
  assert.ok(body.text.includes("```message\nWaikanae library requests a Cyan 212x Toner Cartridge.\n```"));
  assert.equal(body.mailto, undefined);
  assert.equal(JSON.parse(logCall()!.init.body as string).tool, "send_ink_request");
});

test("asks the main model first, then the fallback", async () => {
  savedModels = () => Response.json({ main: "google/gemma-4-31b-it:free", fallback: "openrouter/free" });
  const replies = [answer({ content: "" }), answer({ content: "Use **Renew All**." })];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "How do I renew loans?" });

  assert.deepEqual(await res.json(), { text: "Use **Renew All**." });
  const models = calls.filter((c) => c.url.startsWith("https://openrouter.ai/")).map((c) => JSON.parse(c.init.body as string).model);
  assert.deepEqual(models, ["google/gemma-4-31b-it:free", "openrouter/free"]);
});

test("never uses a saved model that isn't free", async () => {
  savedModels = () => Response.json({ main: "openai/gpt-5", fallback: "anthropic/claude-opus" });
  openRouterReply = answer({ content: "Done." });
  await send({ message: "hi" });
  assert.equal(JSON.parse(openRouterCall()!.init.body as string).model, "openrouter/free");
});

test("uses the usual model when the saved models can't be read", async () => {
  savedModels = () => new Response("nope", { status: 500 });
  openRouterReply = answer({ content: "Done." });
  const res = await send({ message: "hi" });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(openRouterCall()!.init.body as string).model, "openrouter/free");
});

test("uses the cartridge the person set on the Settings page", async () => {
  savedSettings = () => Response.json([{ library: { printer: { cartridge: "HP 410A cartridge" } } }]);
  openRouterReply = answer({
    tool_calls: [{ function: { name: "send_ink_request", arguments: '{"color":"Black","location":"Ōtaki"}' } }],
  });
  const res = await send({ message: "Ōtaki", history: [{ role: "user", content: "I need toner" }] });
  const body = await res.json();

  assert.ok(body.text.includes("```message\nŌtaki library requests a Black HP 410A cartridge.\n```"));
  const settingsCall = calls.find((c) => c.url.includes("/rest/v1/user_settings"))!;
  assert.equal((settingsCall.init.headers as Record<string, string>).Authorization, "Bearer staff-token");
});

test("puts the chat history in an email for staff to copy", async () => {
  openRouterReply = answer({ tool_calls: [{ function: { name: "send_chat_history", arguments: "{}" } }] });
  const res = await send({
    message: "Please email this chat",
    history: [
      { role: "user", content: "Boolean query for missing items" },
      { role: "model", content: "```boolean\nITMSCDE: M\n```\nAt which branch? [[Waikanae]] [[Ōtaki]]" },
    ],
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.text, /^Here's this chat\. Copy it into an email to \*\*max@example\.com\*\*:/);
  assert.match(body.text, /```subject\nLBSYS AI Log - \d/);
  // A longer fence, so the Boolean query inside doesn't end the message early.
  assert.ok(body.text.includes("````message\nChat history:\n\nSTAFF: Boolean query for missing items\n\nAI: ```boolean\n"));
  assert.ok(body.text.endsWith("STAFF: Please email this chat\n````"));
  // Old buttons in the chat would show up again under this reply.
  assert.ok(!body.text.includes("[["));
  assert.match(body.text, /\[Waikanae\] \[Ōtaki\]/);
  assert.equal(body.mailto, undefined);
});

test("ignores an action the model wasn't offered, and asks again", async () => {
  const replies = [
    answer({ tool_calls: [{ function: { name: "send_chat_history", arguments: "{}" } }] }),
    answer({ content: "```boolean\nBRWCHRG> (CHRGAMT: > 20)\n```" }),
  ];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "Boolean query for borrowers who owe more than $20" });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.doesNotMatch(body.text, /```message/);
  assert.match(body.text, /```boolean/);
  const logged = calls.filter((c) => c.url.endsWith("/rest/v1/model_usage")).map((c) => JSON.parse(c.init.body as string).error);
  assert.deepEqual(logged, ["empty", null]);
});

test("explains when the free limit is hit, and logs it", async () => {
  openRouterReply = () => Response.json({ error: { code: 429, message: "Rate limit exceeded" } }, { status: 429 });
  const res = await send({ message: "hi" });

  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /today's limit/);
  assert.equal(JSON.parse(logCall()!.init.body as string).error, "http_429");
});

test("reports an empty reply instead of showing a blank message", async () => {
  openRouterReply = answer({ content: "   " });
  const res = await send({ message: "hi" });
  assert.equal(res.status, 502);
});

test("asks again once when a model sends back nothing", async () => {
  const replies = [answer({ content: "" }), answer({ content: "Use **Renew All**." })];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "How do I renew loans?" });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Use **Renew All**." });
  assert.equal(calls.filter((c) => c.url.startsWith("https://openrouter.ai/")).length, 2);
  // Only the answered attempt counts towards the daily limit.
  const logged = calls.filter((c) => c.url.endsWith("/rest/v1/model_usage")).map((c) => JSON.parse(c.init.body as string).error);
  assert.deepEqual(logged, ["empty", null]);
});

test("asks again when a safety classifier answers instead of a chat model", async () => {
  const replies = [
    () => Response.json({ model: "nvidia/nemotron-3.5-content-safety:free", choices: [{ message: { content: "User Safety: safe" } }] }),
    answer({ content: "Use **Manage Traps**." }),
  ];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "How do I clear a trap?" });
  assert.deepEqual(await res.json(), { text: "Use **Manage Traps**." });
});

test("drops reasoning a model leaked into its reply", async () => {
  openRouterReply = answer({
    content: "They want a query. I should ask. For example:\n\n</think>What do you need to find? [[Missing items]] [[Overdue loans]]",
  });
  const res = await send({ message: "I need help writing a Boolean query." });
  assert.deepEqual(await res.json(), { text: "What do you need to find? [[Missing items]] [[Overdue loans]]" });
});

test("asks again when a reply is only unfinished reasoning", async () => {
  const replies = [answer({ content: "<think>The staff member wants to renew loans, so" }), answer({ content: "Use **Renew All**." })];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "How do I renew loans?" });
  assert.deepEqual(await res.json(), { text: "Use **Renew All**." });
});

test("asks again once when OpenRouter has a server error", async () => {
  const replies = [() => new Response("upstream", { status: 503 }), answer({ content: "Done." })];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "hi" });
  assert.equal(res.status, 200);
});

test("gives up on a model that stalls and asks again", async () => {
  const replies = [
    () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
    answer({ content: "Use **Bulk Change Due Date**." }),
  ];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "Can I push due dates out?" });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Use **Bulk Change Due Date**." });
  assert.ok(openRouterCall()!.init.signal instanceof AbortSignal);
});

test("says so when every try takes too long", async () => {
  openRouterReply = () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };
  const res = await send({ message: "hi" });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /took too long/);
});

test("doesn't retry when the free limit is hit", async () => {
  openRouterReply = () => Response.json({ error: { code: 429 } }, { status: 429 });
  await send({ message: "hi" });
  assert.equal(calls.filter((c) => c.url.startsWith("https://openrouter.ai/")).length, 1);
});

test("asks the fallback when the main model is busy for everyone", async () => {
  savedModels = () => Response.json({ main: "google/gemma-4-31b-it:free", fallback: "openrouter/free" });
  const busy = { error: { code: 429, metadata: { raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream." } } };
  const replies = [() => Response.json(busy, { status: 429 }), answer({ content: "Done." })];
  openRouterReply = () => replies.shift()!();
  const res = await send({ message: "hi" });

  assert.deepEqual(await res.json(), { text: "Done." });
  const models = calls.filter((c) => c.url.startsWith("https://openrouter.ai/")).map((c) => JSON.parse(c.init.body as string).model);
  assert.deepEqual(models, ["google/gemma-4-31b-it:free", "openrouter/free"]);
  const logged = calls.filter((c) => c.url.endsWith("/rest/v1/model_usage")).map((c) => JSON.parse(c.init.body as string));
  assert.deepEqual(logged[0], { model: "google/gemma-4-31b-it:free", error: "http_429" });
});

test("says when the OpenRouter key hasn't been set", async () => {
  const res = await worker.fetch(
    new Request("https://w.example/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Authorization: "Bearer staff-token" },
      body: JSON.stringify({ message: "hi" }),
    }),
    { ...env, OPENROUTER_API_KEY: "" },
    { waitUntil() {} },
  );
  assert.equal(res.status, 503);
  assert.equal(openRouterCall(), undefined);
});

test("stops someone who has used today's questions, without calling OpenRouter", async () => {
  allowance = () => Response.json({ allowed: false, used: 20, limit: 20 });
  const res = await send({ message: "hi" });

  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /all 20 of today's questions/);
  assert.equal(openRouterCall(), undefined);
  const check = calls.find((c) => c.url.endsWith("/rest/v1/rpc/request_allowance"))!;
  assert.equal((check.init.headers as Record<string, string>).Authorization, "Bearer staff-token");
});

test("still answers if the limit check itself fails", async () => {
  allowance = () => new Response("boom", { status: 500 });
  openRouterReply = answer({ content: "Here you go." });
  const res = await send({ message: "hi" });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Here you go." });
});

test("refuses an oversized request without calling OpenRouter", async () => {
  const res = await send({ message: "hi", instructions: "x".repeat(1_000_001) });
  assert.equal(res.status, 413);
  assert.equal(openRouterCall(), undefined);
});

test("rejects an empty message", async () => {
  const res = await send({ message: "   " });
  assert.equal(res.status, 400);
  assert.equal(openRouterCall(), undefined);
});
