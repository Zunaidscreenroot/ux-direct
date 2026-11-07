import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ACTIVE_CHAT_PROVIDER = "freellmapi";
process.env.FREELLMAPI_BASE_URL = "https://freellmapi.test/v1";
process.env.FREELLMAPI_API_KEY = "test-key";
process.env.UXD_LEAD_REVIEW = "on";

import { deterministicLeadNotes, designerPersona, STUDIO, taskOwner } from "../src/figma-agent/studio";
import { agencyEnabled } from "../src/figma-agent/agency";
import { detectTaskRole } from "../src/figma-agent/agent-roles";

const PROVIDER = "https://freellmapi.test/v1/chat/completions";
const realFetch = globalThis.fetch;
const calls: string[] = [];
let revisionMode: "good" | "drops" = "good";
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
  if (body.includes("You are one sub-agent in a team")) return new Response("{}", { status: 502 });
  if (body.includes("You are the UX Lead at UX Direct")) {
    calls.push("lead");
    return ok({ approve: false, notes: [{ severity: "medium", issue: "EMI should lead", fix: "Make Upcoming EMI the stat" }] }, "lead-model");
  }
  if (body.includes("Your UX Lead reviewed your screen")) {
    calls.push("revision");
    return ok(revisionMode === "good" ? revisedScreen : { sections: [header] }, "designer-model");
  }
  calls.push(body.includes("YOUR SEAT: UX Designer") ? "planner-ux-seat" : "planner");
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

async function run() {
  calls.length = 0;
  const { POST } = await import("../app/api/assistant/figma-agent/route");
  const response = await POST(new Request("https://ux-direct.test/api/assistant/figma-agent", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "improve this screen", canvas }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test("studio: work is split by task, one designer owns a screen", () => {
  assert.deepEqual(STUDIO.map((member) => member.seat), ["director", "ux-lead", "ux-designer", "ui-designer"]);
  assert.deepEqual(taskOwner(detectTaskRole("improve this screen")), { owner: "ux-designer", collaborator: "ui-designer" });
  assert.equal(taskOwner(detectTaskRole("change the theme to dark mode")).owner, "ui-designer");
  assert.match(designerPersona(detectTaskRole("improve this screen")), /YOUR SEAT: UX Designer.*UI Designer/);
  // The old per-card split is off unless switched on.
  delete process.env.UXD_AGENCY;
  assert.equal(agencyEnabled(), false);
});

test("studio: Lead's deterministic notes catch competing primaries and repeated text", () => {
  const notes = deterministicLeadNotes({ sections: [{ blocks: [
    { type: "buttons", items: [{ label: "Pay", variant: "primary" }, { label: "Later", variant: "primary" }] },
    { type: "text", text: "Due soon" }, { type: "text", text: "Due soon" },
  ] }, { blocks: [{ type: "button", label: "Pay" }] }] });
  assert.ok(notes.some((note) => note.severity === "high" && /primary/.test(note.issue)));
  assert.ok(notes.some((note) => /Same text twice/.test(note.issue)));
  // The same primary repeated per card is fine.
  assert.equal(deterministicLeadNotes({ sections: [{ blocks: [{ type: "button", label: "Pay" }] }, { blocks: [{ type: "button", label: "Pay" }] }] }).length, 0);
});

test("studio route: Lead reviews, designer revises once, the better screen is kept", async () => {
  revisionMode = "good";
  const { status, body } = await run();
  assert.equal(status, 200, JSON.stringify(body).slice(0, 600));
  assert.deepEqual(calls, ["planner-ux-seat", "lead", "revision"]);
  assert.match(body.model, /designer-model/);
  assert.ok(JSON.stringify(body.plan).includes("Upcoming EMI"));
  const shown = JSON.stringify([body.plan?.summary, body.model, body.generation.attemptTimes, body.plan?.frame?.name]);
  assert.doesNotMatch(shown, /agency|specialist|lead|director/i);
  assert.ok(body.generation.attemptTimes.some((entry: { attempt: string }) => entry.attempt.startsWith("review: 1")));
});

test("studio route: a revision that fails the gates is dropped and the first screen stands", async () => {
  revisionMode = "drops";
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(calls, ["planner-ux-seat", "lead", "revision"]);
  assert.doesNotMatch(body.model, /designer-model/);
  for (const text of ["Credit limit", "₹50,000", "Pay ₹10,000"]) assert.ok(JSON.stringify(body.plan).includes(text), "missing " + text);
  assert.ok(body.generation.attemptTimes.some((entry: { outcome: string }) => /kept first version/.test(entry.outcome)));
});

test.after(() => { globalThis.fetch = realFetch; });
