import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ACTIVE_CHAT_PROVIDER = "freellmapi";
process.env.FREELLMAPI_BASE_URL = "https://freellmapi.test/v1";
process.env.FREELLMAPI_API_KEY = "test-key";

const PROVIDER = "https://freellmapi.test/v1/chat/completions";
const realFetch = globalThis.fetch;
const designerCalls: string[] = [];
let plannerCalls = 0;
let designerMode: "good" | "quota" = "good";
const ok = (content: unknown, model = "designer-model") => new Response(JSON.stringify({
  model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
}), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== PROVIDER) throw new Error("offline in test: " + url);
  const body = typeof init?.body === "string" ? init.body : "";
  if (body.includes("You are one sub-agent in a team")) return new Response("{}", { status: 502 });
  const designer = /You are the ([A-Za-z -]+?) in UX Direct's design agency/.exec(body);
  if (designer) {
    designerCalls.push(designer[1]);
    if (designerMode === "quota") return new Response(JSON.stringify({ error: { message: "daily_quota_exhausted (429)" } }), { status: 429 });
    if (designer[1] === "Data-viz designer") return ok({ section: { name: "Loan summary", surface: "card", blocks: [
      { type: "stat", label: "Upcoming EMI", value: "₹10,000" }, { type: "list", items: [{ label: "Credit limit", value: "₹50,000" }] }] } });
    return ok({ section: { name: "Actions", blocks: [{ type: "buttons", items: [{ label: "Pay ₹10,000", variant: "primary" }] }] } });
  }
  plannerCalls += 1;
  return new Response(JSON.stringify({ error: { message: "planner offline in test" } }), { status: 502 });
}) as typeof fetch;

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

async function run() {
  designerCalls.length = 0;
  plannerCalls = 0;
  const { POST } = await import("../app/api/assistant/figma-agent/route");
  const response = await POST(new Request("https://ux-direct.test/api/assistant/figma-agent", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "improve this screen", canvas }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test("agency: specialist designers design sections in parallel and the planner is not called", async () => {
  designerMode = "good";
  const { status, body } = await run();
  assert.equal(status, 200, JSON.stringify(body).slice(0, 600));
  assert.equal(body.agency?.used, true, JSON.stringify(body.agency));
  assert.equal(plannerCalls, 0);
  assert.ok(designerCalls.includes("Data-viz designer") && designerCalls.includes("Interaction designer"), designerCalls.join(","));
  assert.match(body.model, /^agency: designer-model/);
  assert.ok(body.generation.attemptTimes.some((entry: { attempt: string }) => entry.attempt.startsWith("agency (")));
  const plan = JSON.stringify(body.plan);
  for (const text of ["Personal Loan", "Credit limit", "₹50,000", "Upcoming EMI", "₹10,000", "Pay ₹10,000"]) assert.ok(plan.includes(text), "missing " + text);
});

test("agency: quota errors stop further designer calls and the old pipeline still answers", async () => {
  designerMode = "quota";
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.equal(body.agency?.used, false);
  assert.ok(designerCalls.length <= 4);
  assert.ok(plannerCalls >= 1);
  assert.equal(body.sourceFallback, true);
});

test.after(() => { globalThis.fetch = realFetch; });
