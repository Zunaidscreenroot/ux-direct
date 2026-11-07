import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ACTIVE_CHAT_PROVIDER = "freellmapi";
process.env.FREELLMAPI_BASE_URL = "https://freellmapi.test/v1";
process.env.FREELLMAPI_API_KEY = "test-key";
process.env.UXD_LEAD_REVIEW = "on";

import { deterministicLeadNotes, designerPersona, gatewaySeat, leadApproves, lostTexts, missingFromSpec, seatKnowledge, STUDIO, taskOwner } from "../src/figma-agent/studio";
import { agencyEnabled } from "../src/figma-agent/agency";
import { detectTaskRole } from "../src/figma-agent/agent-roles";

const PROVIDER = "https://freellmapi.test/v1/chat/completions";
const realFetch = globalThis.fetch;
const calls: string[] = [];
let scores: number[] = [];
let iterationMode: "good" | "drops" = "good";
const ok = (content: unknown, model = "model-a") => new Response(JSON.stringify({
  model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
}), { status: 200, headers: { "content-type": "application/json" } });

const header = { name: "Header", surface: "plain", blocks: [{ type: "text", text: "Personal Loan", style: "title" }] };
const actions = { name: "Actions", surface: "plain", blocks: [{ type: "buttons", items: [{ label: "Pay ₹10,000", variant: "primary" }] }] };
const firstScreen = { summary: "s", sections: [header,
  { name: "Loan summary", surface: "card", blocks: [{ type: "list", items: [{ label: "Credit limit", value: "₹50,000" }, { label: "Upcoming EMI", value: "₹10,000" }] }] }, actions] };
const revisedScreen = { summary: "s", sections: [header,
  { name: "Loan summary", surface: "card", blocks: [{ type: "stat", label: "Upcoming EMI", value: "₹10,000" }, { type: "list", items: [{ label: "Credit limit", value: "₹50,000" }] }] }, actions] };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== PROVIDER) throw new Error("offline in test: " + url);
  const body = typeof init?.body === "string" ? init.body : "";
  const seat = new Headers(init?.headers).get("x-uxd-agent-role") || "";
  if (body.includes("You are one sub-agent in a team")) return new Response("{}", { status: 502 });
  if (body.includes("You are the UX Lead at UX Direct")) {
    const score = scores.shift() ?? 80;
    calls.push("lead:" + score);
    return ok({ score, notes: score >= 70 ? [] : [{ severity: "medium", issue: "EMI should lead", fix: "Make Upcoming EMI the stat" }] }, "lead-model");
  }
  if (body.includes("Your UX Lead reviewed your whole screen")) {
    calls.push("iteration:" + seat);
    return ok(iterationMode === "good" ? revisedScreen : { sections: [header, actions] }, "designer-model");
  }
  calls.push(body.includes("YOUR SEAT: Product Designer") ? "planner:product" : "planner");
  return ok(firstScreen);
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

async function run(leadScores: number[]) {
  calls.length = 0;
  scores = [...leadScores];
  const { POST } = await import("../app/api/assistant/figma-agent/route");
  const response = await POST(new Request("https://ux-direct.test/api/assistant/figma-agent", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "improve this screen", canvas }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = await response.json() as Record<string, any>;
  const row = (body.generation?.attemptTimes ?? []).find((entry: { attempt: string }) => entry.attempt.startsWith("review "));
  return { status: response.status, body, row: row?.attempt as string | undefined };
}

test("studio: the Director gives one screen to exactly one designer", () => {
  assert.deepEqual(STUDIO.map((entry) => entry.seat), ["director", "ux-lead", "product-designer", "ux-designer", "ui-designer"]);
  assert.equal(taskOwner(detectTaskRole("improve this screen"), "improve this screen"), "product-designer");
  assert.equal(taskOwner(detectTaskRole("create a variation of this screen"), "create a variation of this screen"), "product-designer");
  assert.equal(taskOwner(detectTaskRole("make a wireframe of this"), "make a wireframe of this"), "ux-designer");
  assert.equal(taskOwner(detectTaskRole("change the theme to dark mode"), "change the theme to dark mode"), "ui-designer");
  assert.equal(taskOwner(detectTaskRole("change the buttons to outline"), "change the buttons to outline"), "ui-designer");
  assert.equal(taskOwner(detectTaskRole("fix the hierarchy and the buttons"), "fix the hierarchy and the buttons"), "product-designer");
  assert.match(designerPersona(detectTaskRole("improve this screen"), "improve this screen"), /YOUR SEAT: Product Designer.*whole screen, top to bottom/);
  assert.equal(gatewaySeat("ux-lead"), "lead");
  assert.equal(gatewaySeat("product-designer"), "product-designer");
  delete process.env.UXD_AGENCY;
  assert.equal(agencyEnabled(), false);
});

test("studio: Lead's deterministic notes and verdict", () => {
  const notes = deterministicLeadNotes({ sections: [{ blocks: [
    { type: "buttons", items: [{ label: "Pay", variant: "primary" }, { label: "Later", variant: "primary" }] },
    { type: "text", text: "Due soon" }, { type: "text", text: "Due soon" },
  ] }, { blocks: [{ type: "button", label: "Pay" }] }] });
  assert.ok(notes.some((entry) => entry.severity === "high" && /primary/.test(entry.issue)));
  assert.ok(notes.some((entry) => /Same text twice/.test(entry.issue)));
  assert.equal(deterministicLeadNotes({ sections: [{ blocks: [{ type: "button", label: "Pay" }] }, { blocks: [{ type: "button", label: "Pay" }] }] }).length, 0);
  assert.equal(leadApproves({ notes: [], score: 72, ms: 0 }), true);
  assert.equal(leadApproves({ notes: [], score: 60, ms: 0 }), false);
  assert.equal(leadApproves({ notes: [{ severity: "high", issue: "x", fix: "y" }], score: 90, ms: 0 }), false);
});

test("studio: coverage helpers find dropped source texts and texts lost between versions", () => {
  const spec = { sections: [{ title: "Loan", blocks: [{ type: "list", items: [{ label: "EMI", value: "₹8,450" }] }] }] };
  assert.deepEqual(missingFromSpec(spec, ["Loan", "emi", "₹8,450", "₹2,290"]), ["₹2,290"]);
  assert.deepEqual(lostTexts(spec, { sections: [{ title: "Loan", blocks: [{ type: "text", text: "EMI" }] }] }), ["₹8,450"]);
  const notes = deterministicLeadNotes(spec, ["₹2,290", "Overdue"]);
  assert.ok(notes.some((entry) => entry.severity === "high" && /missing.*₹2,290, Overdue/i.test(entry.issue)));
});

test("studio route: Product Designer builds, Lead scores 55 → iteration → 78 approves", async () => {
  iterationMode = "good";
  const { status, body, row } = await run([55, 78]);
  assert.equal(status, 200, JSON.stringify(body).slice(0, 600));
  assert.deepEqual(calls, ["planner:product", "lead:55", "iteration:product-designer", "lead:78"]);
  assert.equal(row, "review 55% → 78% ✓");
  assert.match(body.model, /designer-model/);
  assert.doesNotMatch(JSON.stringify([body.plan?.summary, body.generation.attemptTimes]), /agency|specialist|lead|director|designer/i);
});

test("studio route: the loop stops at the round cap and ends on a review", async () => {
  iterationMode = "good";
  const { status, row } = await run([40, 50, 55, 60]);
  assert.equal(status, 200);
  assert.deepEqual(calls.filter((call) => call.startsWith("iteration")).length, 3);
  assert.equal(calls[calls.length - 1], "lead:60");
  assert.equal(row, "review 40% → 50% → 55% → 60%");
});

test("studio route: an iteration that drops the amounts is refused by the Director", async () => {
  iterationMode = "drops";
  const { status, body, row } = await run([50, 50]);
  assert.equal(status, 200);
  for (const text of ["Credit limit", "₹50,000", "Upcoming EMI", "₹10,000"]) assert.ok(JSON.stringify(body.plan).includes(text), "missing " + text);
  assert.match(row ?? "", /^review 50% ×/);
  assert.doesNotMatch(body.model, /designer-model/);
});

test("studio: each seat gets its role's knowledge", async () => {
  const lead = await seatKnowledge("ux-lead", "improve this screen review hierarchy consistency critique", "fintech");
  const product = await seatKnowledge("product-designer", "improve this screen", "fintech");
  assert.ok(lead.length > 200 && product.length > 200);
  assert.notEqual(lead, product);
  assert.doesNotMatch(lead + product, /You are UX Direct/i);
});

test.after(() => { globalThis.fetch = realFetch; });
