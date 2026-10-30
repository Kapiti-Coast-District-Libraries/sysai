import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

// knowledge.ts uses the app's extensionless imports, so Vite loads it the way
// the app does. Its own cache folder and no dependency scan, so it doesn't
// disturb `npm run dev` if that's running.
let server: ViteDevServer;
let detectRequest: (message: string, history: { role: "user" | "model"; content: string }[]) => string;
let knowledge: Record<string, any>;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    cacheDir: "node_modules/.vite-test",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "silent",
  });
  knowledge = await server.ssrLoadModule("/services/knowledge.ts");
  ({ detectRequest } = knowledge);
});

after(() => server.close());

const afterBooleanQuery = [
  { role: "user" as const, content: "I need help writing a Boolean query." },
  { role: "model" as const, content: "What do you need to find? [[Missing items at a branch]] [[Loans overdue by 30+ days]]" },
  { role: "user" as const, content: "Missing items at a branch" },
  { role: "model" as const, content: "```boolean\nITMLOCX: PARA + ITMSCDE: M\n```" },
];

const afterColourQuestion = [
  { role: "user" as const, content: "I would like to request printer ink." },
  { role: "model" as const, content: "What colour toner do you need? [[Black]] [[Cyan]] [[Magenta]] [[Yellow]]" },
];

test("starts Boolean queries and ink requests", () => {
  assert.equal(detectRequest("I need help writing a Boolean query.", []), "boolean");
  assert.equal(detectRequest("What's the location code for Waikanae?", []), "boolean");
  assert.equal(detectRequest("I would like to request printer ink.", []), "ink");
  assert.equal(detectRequest("We need cyan toner for Waikanae", []), "ink");
  assert.equal(detectRequest("Cyan", afterColourQuestion), "ink");
});

test("keeps working on a Boolean query when staff refine it", () => {
  assert.equal(detectRequest("Waikanae", afterBooleanQuery), "boolean");
  assert.equal(detectRequest("Items", afterBooleanQuery), "boolean");
  assert.equal(detectRequest("now only Waikanae", afterBooleanQuery), "boolean");
  assert.equal(detectRequest("make it 60 days", afterBooleanQuery), "boolean");
  assert.equal(detectRequest("include lost items too", afterBooleanQuery), "boolean");
  assert.equal(detectRequest("Loans overdue by 30+ days", afterBooleanQuery), "boolean");
});

test("treats a new question after a Boolean query as a new question", () => {
  // The first is a suggested-question button on the empty chat.
  assert.equal(detectRequest("The circulation desk computer has no internet connection.", afterBooleanQuery), "general");
  assert.equal(detectRequest("Customer wants to renew their books", afterBooleanQuery), "general");
  assert.equal(detectRequest("What does error E01 on the self-check mean?", afterBooleanQuery), "general");
  assert.equal(detectRequest("How do I waive a fine?", afterBooleanQuery), "general");
});

test("doesn't mistake everyday questions for Boolean queries or ink requests", () => {
  assert.equal(detectRequest("What's the code for the staff wifi?", []), "general");
  assert.equal(detectRequest("Customer has queries about their overdue fines", []), "general");
  assert.equal(detectRequest("I have a quick query about holds", []), "general");
  assert.equal(detectRequest("The self-check shows error code 3", []), "general");
  assert.equal(detectRequest("How do I check the toner level on the printer?", []), "general");
  assert.equal(detectRequest("The printer says the toner is jammed", []), "general");
});

// A few Spydus Help pages, enough for the guide search to rank them.
function sampleGuides() {
  const page = (title: string, steps: string[]) =>
    `<html><head><title>${title}</title></head><body><div id="i-body-content"><ul>${steps.map((s) => `<li>${s}</li>`).join("")}</ul></div></body></html>`;
  const pages: [string, string[]][] = [
    ["Add or edit user accounts", [
      "To add or edit an active user account, from the Module Menu select Maintenance, General and then User Accounts.",
      "Click New to add a new user account, or select the account you want and click Edit.",
      "Click Save or Save & Close.",
    ]],
    ["Renew loans", ["To renew loans for a borrower, select Circulation and then Renew.", "Click Renew All, then Close."]],
    ["Place a reservation", ["To place a reservation, select Circulation and then Reservations.", "Search for the title and click Place Reservation."]],
    ["Waive a charge", ["To waive a fine, open the borrower and click Charges.", "Select the charge, click Waive and enter a reason."]],
    ["Register a borrower", ["To register a borrower, select Circulation and then Borrower Registration.", "Fill in the name, address and category."]],
    ["Print a receipt", ["To reprint a receipt, open Transactions and click Print Receipt."]],
    ["Return items", ["To return items, select Circulation and then Returns, then scan each barcode."]],
  ];
  const chunks = pages.flatMap(([title, steps]) =>
    knowledge.parseGuide(`${title}.html`, `SOP/SPYDUS HELP SOPS/${title}.html`, page(title, steps)),
  );
  return knowledge.buildGuideIndex(chunks);
}

test("keeps the earlier guide when staff doubt an answer", () => {
  const guides = sampleGuides();
  const history: { role: "user" | "model"; content: string }[] = [
    { role: "user", content: "how do i add a new user" },
    { role: "model", content: "1. Go to **Maintenance** > **General** > **User Accounts**.\n2. Click **New**.\n\n_From: Add or edit user accounts_" },
  ];
  for (const doubt of ["cap", "prove it", "but isnt what u told me correct?"]) {
    const context = knowledge.buildContext(doubt, history, guides, [], []);
    assert.match(context, /Guide: Add or edit user accounts/, doubt);
    assert.match(context, /questioning your earlier answer[\s\S]*earlier question "how do i add a new user"/, doubt);
  }
  // Several doubts in a row still go back to the question that matched a guide.
  const later = [...history, { role: "user" as const, content: "cap" }, { role: "model" as const, content: "..." }];
  assert.match(knowledge.buildContext("huh?", later, guides, [], []), /Guide: Add or edit user accounts/);
});

test("says no guide matched, without doubting earlier answers, when nothing did", () => {
  const guides = sampleGuides();
  const context = knowledge.buildContext("the self-check is beeping loudly and flashing", [], guides, [], []);
  assert.match(context, /No guide matched this message\. That says nothing about earlier answers/);
});
