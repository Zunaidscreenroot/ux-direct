import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ACTIVE_CHAT_PROVIDER = "freellmapi";
process.env.FREELLMAPI_BASE_URL = "https://freellmapi.test/v1";
process.env.FREELLMAPI_API_KEY = "test-key";
// These cases script the monolithic planner; the agency route has its own test (agency-route).
process.env.UXD_AGENCY = "off";

const PROVIDER = "https://freellmapi.test/v1/chat/completions";
type Reply = () => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let providerReplies: Reply[] = [];
let providerCalls = 0;
let subAgentCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === PROVIDER) {
    // Parallel sub-agents (detector / UX analyst) are answered separately so the scripted
    // replies below stay the planner's; a sub-agent failure must never block the planner.
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("You are one sub-agent in a team")) {
      subAgentCalls += 1;
      return new Response(JSON.stringify({ error: { message: "sub-agent offline in test" } }), { status: 502 });
    }
    providerCalls += 1;
    const reply = providerReplies.shift();
    if (!reply) return new Response(JSON.stringify({ error: { message: "no more scripted replies" } }), { status: 502 });
    return reply();
  }
  // Brain, logging and storage calls are not under test: fail them like an offline backend.
  throw new Error("offline in test: " + url);
}) as typeof fetch;

const chat = (content: string, model = "test-model") => () => new Response(JSON.stringify({
  model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
}), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number) => () => new Response(JSON.stringify({ error: { message: "upstream " + code } }), { status: code });

const canvas = {
  pageName: "Page", scope: "selection", nodeCount: 12,
  nodes: [{ id: "1:1", name: "Personal loan", type: "FRAME", x: 0, y: 0, width: 360, height: 800, fillColors: ["#121212"], children: [
    { id: "1:2", name: "Title", type: "TEXT", text: "Personal Loan", fontSize: 20, fontStyle: "Semi Bold", fillColors: ["#FFFFFF"] },
    { id: "1:3", name: "Card", type: "FRAME", fillColors: ["#1C1A24"], cornerRadius: 16, children: [
      { id: "1:4", name: "Row", type: "FRAME", children: [{ id: "1:5", name: "L", type: "TEXT", text: "Credit limit" }, { id: "1:6", name: "V", type: "TEXT", text: "₹50,000" }] },
      { id: "1:7", name: "Row", type: "FRAME", children: [{ id: "1:8", name: "L", type: "TEXT", text: "Upcoming EMI" }, { id: "1:9", name: "V", type: "TEXT", text: "₹10,000" }] },
    ] },
    { id: "1:10", name: "Footer", type: "FRAME", children: [
      { id: "1:11", name: "CTA", type: "FRAME", height: 48, cornerRadius: 12, fillColors: ["#3892F6"], children: [{ id: "1:12", name: "Label", type: "TEXT", text: "Pay ₹10,000" }] },
    ] },
  ] }],
  components: [], styles: { paint: [], text: [], effect: [], grid: [] },
};

const goodSpec = JSON.stringify({
  summary: "Loan details with a clear EMI hierarchy.",
  sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "Personal Loan" }] },
    { name: "Loan", surface: "card", title: "Loan details", blocks: [{ type: "row", label: "Credit limit", value: "₹50,000" }, { type: "row", label: "Upcoming EMI", value: "₹10,000" }] },
    { name: "Actions", blocks: [{ type: "button", label: "Pay ₹10,000" }] },
  ],
  learningCandidate: null,
});

async function run(replies: Reply[]) {
  providerReplies = [...replies];
  providerCalls = 0;
  subAgentCalls = 0;
  const { POST } = await import("../app/api/assistant/figma-agent/route");
  const response = await POST(new Request("https://ux-direct.test/api/assistant/figma-agent", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "improve this screen", canvas }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = await response.json() as Record<string, any>;
  return { status: response.status, body, calls: providerCalls };
}

type PlanNode = { type?: string; text?: string; children?: PlanNode[] };
function texts(plan: { elements?: PlanNode[] }): string[] {
  const out: string[] = [];
  const walk = (nodes: PlanNode[] | undefined) => { for (const n of nodes || []) { if (n.type === "TEXT" && n.text) out.push(n.text); walk(n.children); } };
  walk(plan.elements);
  return out;
}
const SOURCE_TEXTS = ["Personal Loan", "Credit limit", "₹50,000", "Upcoming EMI", "₹10,000", "Pay ₹10,000"];
function assertDesign(result: Awaited<ReturnType<typeof run>>, fallback: boolean) {
  assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 600));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.sourceFallback === true, fallback, "sourceFallback flag");
  const found = texts(result.body.plan);
  for (const text of SOURCE_TEXTS) assert.ok(found.includes(text), "missing " + text);
}

const cases: Array<{ name: string; replies: Reply[]; fallback: boolean }> = [
  { name: "a clean block spec", replies: [chat(goodSpec)], fallback: false },
  { name: "one 502 then a good spec (transient retry)", replies: [status(502), chat(goodSpec)], fallback: false },
  { name: "the user's case: 502, 502, unusable compact spec", replies: [status(502), status(502), chat(JSON.stringify({ sections: [{ name: "X", blocks: [{ type: "sparkle" }] }] }))], fallback: true },
  { name: "provider down on every call", replies: [], fallback: true },
  { name: "429 rate limit then empty body", replies: [status(429), status(429), () => new Response("", { status: 200 })], fallback: true },
  { name: "non-JSON HTML error page", replies: [() => new Response("<html>Bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }), () => new Response("<html/>", { status: 200 })], fallback: true },
  { name: "prose instead of JSON", replies: [chat("Sure! Here is a better design idea for you."), chat("I cannot do that.")], fallback: true },
  { name: "truncated JSON", replies: [chat(goodSpec.slice(0, 120)), chat(goodSpec.slice(0, 80))], fallback: true },
  { name: "loosely typed thin spec", replies: [chat(JSON.stringify({ sections: [{ name: "All", blocks: ["Personal Loan", { type: "kv", label: "Credit limit", value: "₹50,000" }, { type: "kv", label: "Upcoming EMI", value: "₹10,000" }, { type: "cta", label: "Pay ₹10,000", variant: "primary" }] }] }))], fallback: false },
  { name: "network error thrown by fetch", replies: [() => { throw new TypeError("fetch failed"); }, () => { throw new TypeError("fetch failed"); }], fallback: true },
];

for (const c of cases) {
  test("improve flow recovers from: " + c.name, async () => {
    const result = await run(c.replies);
    assertDesign(result, c.fallback);
    // Detector + analyst ran (in parallel) and their failure did not block the planner.
    assert.equal(subAgentCalls, 2);
    if (result.body.agents) assert.equal(result.body.agents.domain, "fintech");
  });
}

test.after(() => { globalThis.fetch = realFetch; });
