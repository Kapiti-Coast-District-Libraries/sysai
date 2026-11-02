// LibSys Support AI chat backend (runs as the libsys-chat edge function; index.ts wires it up).
// Checks the staff member's Supabase sign-in, sends the chat to the free models
// set on the Usage page through OpenRouter, turns tool calls into emails for staff
// to copy, and logs which model answered to the Supabase `model_usage` table.

import { library } from "../_shared/library.ts";

export interface Env {
  OPENROUTER_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ALLOWED_ORIGINS: string;
  OPENROUTER_MODEL?: string;
  SUPPORT_EMAIL?: string;
  // For tests: how long before the fallback is asked too.
  HEDGE_AFTER_MS?: number;
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

type HistoryMessage = { role: "user" | "model"; content: string };

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ToolCall = { function?: { name?: string; arguments?: string } };

type Tool = { type: "function"; function: { name: string; description: string; parameters: unknown } };

const INK_WORDS = /\b(ink|toner|cartridges?)\b/i;
const EMAIL_WORDS = /\b(e-?mail|send|forward)\b/i;
const CHAT_WORDS = /\b(chat|history|conversation|transcript|log)\b/i;

// The free router's pool includes safety classifiers, which reply with a label
// ("User Safety: safe") instead of an answer.
const CLASSIFIER_MODEL = /safety|guard|moderat/i;
const CLASSIFIER_REPLY = /^\s*(user|response) safety:/i;

// Some free models leak their reasoning into the reply, ending it with
// </think>, sometimes without the opening tag.
const REASONING_END = "</think>";
const REASONING_START = /^\s*<think>/i;

// The heading of the Boolean query instructions in the site's constants.ts.
const BOOLEAN_INSTRUCTIONS = "### BOOLEAN QUERY PROTOCOL";
const QUERY_LABEL = /^[*_]*boolean( query)?:?[*_]*:?\s*/i;

type UsageLog = {
  model?: string | null;
  tool?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  error?: string | null;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openrouter/free";

// Free models only: an id ending in :free, or the free router. The database
// only saves these too (admin_set_chat_models).
const FREE_MODEL = /^(openrouter\/free|[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+:free)$/;

// A question plus its guide excerpts and chat history is well under this.
const MAX_REQUEST_BYTES = 1_000_000;

// Supabase recycles the function's worker 150 seconds after it starts, even
// mid-request, and a worker serves several chats. A model that stalls is
// dropped after this, so the answer can come from another.
const ATTEMPT_TIMEOUT_MS = 40_000;

// The last try only starts if the first round failed quickly (an overloaded
// model fails in a second or two), so it ends well inside the 150 seconds.
const LAST_TRY_STARTS_BY_MS = 50_000;

// How long the main model gets before the fallback is asked as well. Most
// answers take 1 to 4 seconds.
const HEDGE_AFTER_MS = 8_000;

// Tool definitions live here rather than coming from the browser, so the only
// actions the model can trigger are these two emails.
const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "send_ink_request",
      description: "Triggers the automatic email request for printer ink to the LibSys admin.",
      parameters: {
        type: "object",
        properties: {
          color: { type: "string", description: "The color of the ink/toner cartridge requested." },
          location: { type: "string", description: "The library or printer location." },
        },
        required: ["color", "location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_chat_history",
      description: "Triggers an email containing the full conversation history.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, cors);
    }

    const token = bearerToken(request);
    if (!token || !(await isSignedIn(token, env))) {
      return json({ error: "Your sign-in has expired. Please sign out and sign in again." }, 401, cors);
    }

    if (!env.OPENROUTER_API_KEY) {
      return json({ error: "The chat service isn't set up yet. Let your LibSys admin know." }, 503, cors);
    }

    const [allowance, models] = await Promise.all([checkAllowance(token, env), chatModels(token, env)]);
    if (allowance && !allowance.allowed) {
      return json(
        { error: `You've used all ${allowance.limit} of today's questions. Your limit resets at midnight.` },
        429,
        cors,
      );
    }

    let body: { message?: unknown; history?: unknown; instructions?: unknown };
    try {
      const raw = await request.text();
      if (raw.length > MAX_REQUEST_BYTES) {
        return json({ error: "That chat is too long to send. Start a new chat and try again." }, 413, cors);
      }
      body = JSON.parse(raw);
    } catch {
      return json({ error: "The request couldn't be read." }, 400, cors);
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return json({ error: "The message was empty." }, 400, cors);
    }
    const history = parseHistory(body.history);
    const instructions = typeof body.instructions === "string" ? body.instructions : "";

    const messages: ChatMessage[] = [
      ...(instructions ? [{ role: "system" as const, content: instructions }] : []),
      ...history.map((m) => ({
        role: m.role === "model" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    // The main model set on the Usage page is asked first. The fallback (often
    // the free router, which picks a model per request) is asked too only if
    // the main fails or is slow, and the first good answer wins. If both fail
    // quickly and there's time, the fallback gets one more try.
    const tools = toolsFor(message, history);
    const hedgeMs = env.HEDGE_AFTER_MS ?? HEDGE_AFTER_MS;
    const record = (entry: UsageLog) => ctx.waitUntil(logUsage(token, env, entry));
    const ask = (model: string) => (signal?: AbortSignal) => askModel(messages, tools, env, model, signal);
    const started = Date.now();
    const firstRound = models.main === models.fallback ? [ask(models.main)] : [ask(models.main), ask(models.fallback)];
    let outcome = await firstAnswer(firstRound, record, hedgeMs);
    // The account's own limits and credit problems won't clear up on a retry.
    if (!outcome.answered && !outcome.final && Date.now() - started <= LAST_TRY_STARTS_BY_MS) {
      outcome = await firstAnswer([ask(models.fallback)], record, hedgeMs);
    }

    if (!outcome.answered) {
      if (outcome.status === null) {
        return json({ error: "The AI didn't send back an answer. Please try again." }, 502, cors);
      }
      return json({ error: upstreamErrorMessage(outcome.status) }, outcome.status === 429 ? 429 : 502, cors);
    }
    const { content, toolCall } = outcome;
    const toolName = toolCall?.function?.name ?? null;

    if (toolName === "send_ink_request") {
      const args = parseArguments(toolCall?.function?.arguments);
      const color = String(args.color ?? "").trim() || "toner";
      const location = String(args.location ?? "").trim() || "the library";
      const cartridge = (await savedCartridge(token, env)) ?? library.printer.cartridge;
      // Same subject and wording as the old Gemini proxy, so the emails look the same as before.
      const email = emailToCopy(
        env.SUPPORT_EMAIL,
        `AI Support Toner Request - ${color} | ${location}`,
        `${location} library requests a ${color} ${cartridge}.`,
      );
      return json({ text: `Here's the ink request for **${color}** toner for **${location}**. ${email}` }, 200, cors);
    }

    if (toolName === "send_chat_history") {
      const transcript = [...history, { role: "user", content: message }]
        // [[Yes]] would show up as buttons again under this reply.
        .map((m) => `${m.role === "model" ? "AI" : "STAFF"}: ${m.content.replace(/\[\[(.*?)\]\]/g, "[$1]")}`)
        .join("\n\n");
      const date = new Date().toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland" });
      const email = emailToCopy(env.SUPPORT_EMAIL, `LBSYS AI Log - ${date}`, `Chat history:\n\n${transcript}`);
      return json({ text: `Here's this chat. ${email}` }, 200, cors);
    }

    return json({ text: instructions.includes(BOOLEAN_INSTRUCTIONS) ? fenceQuery(content) : content }, 200, cors);
  },
};

// Each action is only offered when the conversation is about it, so a
// question about fines can't open an ink request or a chat-history email.
function toolsFor(message: string, history: HistoryMessage[]): Tool[] {
  const recent = [...history.slice(-6).map((m) => m.content), message].join("\n");
  return TOOLS.filter((tool) => {
    if (tool.function.name === "send_ink_request") return INK_WORDS.test(recent);
    if (tool.function.name === "send_chat_history") return EMAIL_WORDS.test(message) && CHAT_WORDS.test(message);
    return false;
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Supabase confirms the access token is a live session for a real user.
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

type Allowance = { allowed: boolean; used: number; limit: number | null };

// The cartridge the person set on the Settings page, if they changed it. Their
// user_settings row is the only one they can read.
async function savedCartridge(token: string, env: Env): Promise<string | null> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_settings?select=library`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const cartridge = (await res.json())?.[0]?.library?.printer?.cartridge;
    return typeof cartridge === "string" && cartridge.trim() ? cartridge.trim() : null;
  } catch {
    return null;
  }
}

// The main and fallback models set on the Usage page. Anything missing, not
// free, or unreadable uses the OPENROUTER_MODEL secret, or the free router.
async function chatModels(token: string, env: Env): Promise<{ main: string; fallback: string }> {
  const usual = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/chat_models`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) return { main: usual, fallback: usual };
    const saved = await res.json();
    const pick = (model: unknown) => (typeof model === "string" && FREE_MODEL.test(model) ? model : usual);
    return { main: pick(saved?.main), fallback: pick(saved?.fallback) };
  } catch {
    return { main: usual, fallback: usual };
  }
}

// The daily limit set on the Usage page. If the check itself fails, the
// question goes ahead rather than locking everyone out.
async function checkAllowance(token: string, env: Env): Promise<Allowance | null> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/request_allowance`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      console.error("request_allowance failed", res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("request_allowance failed", err);
    return null;
  }
}

function parseHistory(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (m): m is HistoryMessage =>
      (m?.role === "user" || m?.role === "model") && typeof m.content === "string" && m.content.trim() !== "",
  );
}

// Only the text after the last </think> is the answer. A reply that is all
// reasoning, cut off before the tag closed, counts as empty.
function withoutReasoning(text: string): string {
  const end = text.toLowerCase().lastIndexOf(REASONING_END);
  const answer = end === -1 ? text : text.slice(end + REASONING_END.length);
  return REASONING_START.test(answer) ? "" : answer.trim();
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Staff copy the subject and message into their own email. Opening a mailto
// link for them does nothing on PCs with no mail app set up, or with Outlook
// in the browser.
function emailToCopy(to: string | undefined, subject: string, body: string): string {
  return `Copy it into an email to ${to ? `**${to}**` : "your LibSys admin"}:\n\n${codeBlock("subject", subject)}\n\n${codeBlock("message", body)}`;
}

// The fence is longer than any run of backticks inside, so a Boolean query
// quoted in the chat history doesn't end the block early.
function codeBlock(label: string, text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${label}\n${text}\n${fence}`;
}

const withoutLabel = (line: string) => line.trim().replace(QUERY_LABEL, "").replace(/^`|`$/g, "");

// A whole query starts with a variable and has no lower case outside its quoted
// dates, so "ITMLOCX: WAI finds items at Waikanae" isn't one.
function isQuery(line: string): boolean {
  return /^\(*[A-Z][A-Z0-9]+[:<>]/.test(line) && !/[a-z]/.test(line.replace(/"[^"]*"/g, ""));
}

// Code blocks get a Copy button, but models sometimes leave the fence off a
// Boolean query, often with just the word "boolean" left above it.
function fenceQuery(reply: string): string {
  // With "boolean" on the line below the fence, it would be copied with the query.
  const text = reply.replace(/^```[ \t]*\n[ \t]*boolean[ \t]*\n/gim, "```boolean\n");
  if (text.includes("```")) return text;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => isQuery(withoutLabel(line)));
  if (at === -1) return text;
  const start = at > 0 && /^boolean$/i.test(lines[at - 1].trim()) ? at - 1 : at;
  lines.splice(start, at - start + 1, "```boolean", withoutLabel(lines[at]), "```");
  return lines.join("\n");
}

type Outcome =
  | { answered: true; content: string; toolCall?: ToolCall }
  // status is null when the model replied with nothing usable.
  | { answered: false; status: number | null; final?: boolean };

// cancelled: another model answered first, so this request was dropped.
type Asked = { outcome: Outcome; log?: UsageLog; cancelled?: boolean };

// Asks one model and says what to log, without logging it yet.
async function askModel(
  messages: ChatMessage[],
  tools: Tool[],
  env: Env,
  model: string,
  signal?: AbortSignal,
): Promise<Asked> {
  const result = await askOpenRouter(messages, tools, env, model, signal);
  if (signal?.aborted) return { outcome: { answered: false, status: null }, cancelled: true };
  if ("error" in result) {
    // Logged with the model asked, so the Usage page shows which one is failing.
    return { outcome: { answered: false, status: result.status, final: result.final }, log: { model, error: result.error } };
  }
  const { data } = result;
  const choice = data.choices?.[0];
  // OpenRouter passes on some provider errors ("Service temporarily
  // overloaded") as a 200 with no reply in it.
  if (!choice) console.error("OpenRouter sent no reply", model, JSON.stringify(data).slice(0, 1000));
  const upstreamError = data.error?.metadata?.error_type ?? (data.error?.code ? `upstream_${data.error.code}` : null);
  let content = withoutReasoning(choice?.message?.content ?? "");
  if (CLASSIFIER_MODEL.test(data.model ?? "") || CLASSIFIER_REPLY.test(content)) content = "";
  let toolCall: ToolCall | undefined = choice?.message?.tool_calls?.[0];
  // Weaker models sometimes reach for an action nobody asked for.
  if (toolCall && !tools.some((t) => t.function.name === toolCall?.function?.name)) {
    console.error("Ignored a tool call that wasn't offered", toolCall.function?.name);
    toolCall = undefined;
  }
  const answered = Boolean(content || toolCall);
  return {
    outcome: answered ? { answered: true, content, toolCall } : { answered: false, status: null },
    log: {
      model: data.model ?? model,
      tool: toolCall?.function?.name ?? null,
      prompt_tokens: data.usage?.prompt_tokens ?? null,
      completion_tokens: data.usage?.completion_tokens ?? null,
      error: !choice ? upstreamError ?? "no_choice" : answered ? null : "empty",
    },
  };
}

// Asks the models in turn: the next one starts as soon as the one before it
// fails, or once it has gone hedgeMs without answering. The first answer wins
// and the rest are cancelled, so they aren't logged or counted. With no
// answer, it settles with the most telling failure. A quick answer from the
// first model costs one request.
function firstAnswer(
  asks: ((signal: AbortSignal) => Promise<Asked>)[],
  record: (entry: UsageLog) => void,
  hedgeMs: number,
): Promise<Outcome> {
  const controller = new AbortController();
  const failures: Outcome[] = [];
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    const settle = (outcome: Outcome) => {
      clearTimeout(timer);
      controller.abort();
      resolve(outcome);
    };
    const startNext = () => {
      clearTimeout(timer);
      if (started >= asks.length || controller.signal.aborted) return;
      const ask = asks[started++];
      if (started < asks.length) timer = setTimeout(startNext, hedgeMs);
      ask(controller.signal)
        .catch((): Asked => ({ outcome: { answered: false, status: 502 } }))
        .then(({ outcome, log, cancelled }) => {
          if (cancelled || controller.signal.aborted) return;
          if (log) record(log);
          if (outcome.answered) return settle(outcome);
          failures.push(outcome);
          if (failures.length === asks.length) {
            return settle(
              failures.find((f) => !f.answered && f.final) ??
                failures.find((f) => !f.answered && f.status === 504) ??
                failures.find((f) => !f.answered && f.status !== null) ??
                failures[0],
            );
          }
          // Everything asked so far has failed, so don't wait for the timer.
          if (failures.length === started) startNext();
        });
    };
    startNext();
  });
}

type OpenRouterResult = { data: any } | { error: string; status: number; final?: boolean };

async function askOpenRouter(
  messages: ChatMessage[],
  tools: Tool[],
  env: Env,
  model: string,
  cancel?: AbortSignal,
): Promise<OpenRouterResult> {
  const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
  const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
  const send = (effort: "none" | "low") =>
    fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "LibSys Support AI",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        reasoning: { effort, exclude: true },
      }),
      signal,
    });
  let res: Response;
  try {
    // Thinking is skipped: even hidden, it made free models take 30 seconds or
    // more, and often time out.
    res = await send("none");
    // Some models can't skip it ("Reasoning is mandatory"); they get a short think.
    if (res.status === 400 && /reasoning is mandatory/i.test(await res.clone().text())) res = await send("low");
  } catch (err) {
    return isTimeout(err) ? { error: "timeout", status: 504 } : { error: "network", status: 0 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("OpenRouter error", res.status, detail);
    // A model that's busy for everyone ("rate-limited upstream") is worth asking
    // the fallback about. The account's own limits and credit problems aren't.
    const final = res.status === 402 || (res.status === 429 && !/upstream/i.test(detail));
    return { error: `http_${res.status}`, status: res.status, final };
  }
  try {
    return { data: await res.json() };
  } catch (err) {
    return isTimeout(err) ? { error: "timeout", status: 504 } : { error: "bad_reply", status: 502 };
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function upstreamErrorMessage(status: number): string {
  if (status === 0) {
    return "Couldn't reach the AI service. Please try again in a minute.";
  }
  if (status === 429) {
    return "The free AI service is busy or today's limit has been reached. Please try again in a minute. If it keeps happening, the daily limit resets at midday NZ time (1pm during daylight saving).";
  }
  if (status === 402) {
    return "The AI service account needs attention. Let your LibSys admin know.";
  }
  if (status === 504) {
    return "The AI took too long to answer. Please try again.";
  }
  return "The AI service had a problem. Please try again in a minute.";
}

// Best effort: a failed log never blocks the chat.
async function logUsage(token: string, env: Env, entry: UsageLog): Promise<void> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/model_usage`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(entry),
    });
    if (!res.ok) console.error("model_usage log failed", res.status, await res.text());
  } catch (err) {
    console.error("model_usage log failed", err);
  }
}
