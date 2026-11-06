import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDomain, detectTaskRole, roleInstructions } from "../src/figma-agent/agent-roles";
import { composeBrief, groundedInSource, runSubAgents } from "../src/figma-agent/sub-agents";
import { UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";
import { promptRequestsRestyle } from "../src/figma-agent/spec-consistency";

const SOURCE = ["Personal Loan", "Credit limit", "₹50,000", "Upcoming EMI", "₹10,000", "Due on 5 Jan", "Pay ₹10,000"];

test("every model gets the anti-hallucination and anti-slop contract", () => {
  assert.match(UX_DIRECT_DESIGN_ROLE, /GROUNDING/);
  assert.match(UX_DIRECT_DESIGN_ROLE, /Never invent/);
  assert.match(UX_DIRECT_DESIGN_ROLE, /NO AI SLOP/);
});

test("role switcher picks the role from the request", () => {
  assert.equal(detectTaskRole("make a wireframe of this").id, "wireframe");
  assert.equal(detectTaskRole("low-fi version please").id, "wireframe");
  assert.equal(detectTaskRole("create a variation of this screen").id, "variation");
  assert.equal(detectTaskRole("isko dark mode me karo").id, "restyle");
  assert.equal(detectTaskRole("rewrite the copy").id, "content");
  assert.equal(detectTaskRole("improve this screen").id, "improve");
  assert.ok(promptRequestsRestyle("make a wireframe"), "wireframes may use a greyscale theme");
});

test("domain detection reads the prompt and source text", () => {
  assert.equal(detectDomain("improve this", SOURCE).domain.id, "fintech");
  assert.equal(detectDomain("improve", ["Add to cart", "Checkout", "Price ₹999 discount"]).domain.id, "ecommerce");
  assert.equal(detectDomain("improve", ["Settings"]).domain.id, "general", "one stray keyword is not a domain");
  assert.match(roleInstructions(detectTaskRole("wireframe"), detectDomain("", SOURCE).domain), /Wireframe designer[\s\S]*Fintech/);
});

test("brief keeps only grounded content and real component IDs", () => {
  assert.deepEqual(groundedInSource(["Credit limit", "Pre-approved ₹5 lakh offer", "pay ₹10,000"], SOURCE), ["Credit limit", "pay ₹10,000"]);
  const role = detectTaskRole("improve this screen");
  const brief = composeBrief({ role, sourceTexts: SOURCE }, detectDomain("", SOURCE),
    { run: { agent: "detector", ok: true, ms: 10 }, data: { domain: "banking", product: "Personal loan app", userGoal: "Pay the next EMI",
      keyContent: ["Upcoming EMI", "Instant 0% interest offer"] } },
    { run: { agent: "analyst", ok: true, ms: 12 }, data: { primaryAction: "Apply for credit card", hierarchy: ["EMI: ₹10,000 · Due on 5 Jan"],
      problems: ["CTA is below the fold"], changes: ["Put the EMI amount first"] } },
    { run: { agent: "scout", ok: true, ms: 9 }, data: { matches: [{ control: "button", componentId: "10:1" }, { control: "tab", componentId: "99:99" }] } },
    new Set(["10:1"]));
  assert.equal(brief.domain.id, "fintech");
  assert.equal(brief.domainSource, "agent");
  assert.match(brief.instructions, /Upcoming EMI/);
  assert.doesNotMatch(brief.instructions, /0% interest/, "invented content is dropped");
  assert.doesNotMatch(brief.instructions, /Apply for credit card/, "invented primary action is dropped");
  assert.match(brief.instructions, /button → 10:1/);
  assert.doesNotMatch(brief.instructions, /99:99/, "unknown component IDs are dropped");
  assert.equal(brief.runs.length, 3);
});

test("sub-agents run in parallel and a failed agent only drops its notes", async () => {
  process.env.ACTIVE_CHAT_PROVIDER = "freellmapi";
  process.env.FREELLMAPI_BASE_URL = "https://freellmapi.test/v1";
  process.env.FREELLMAPI_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
    const body = String(init?.body || "");
    if (body.includes("Design-system scout")) return new Response("{}", { status: 502 });
    const content = body.includes("Context detector")
      ? { domain: "fintech", product: "Loan app", userGoal: "Pay EMI", keyContent: ["Upcoming EMI"] }
      : { primaryAction: "Pay ₹10,000", hierarchy: ["EMI first"], changes: ["Lead with the EMI"] };
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const brief = await runSubAgents({ prompt: "improve this", role: detectTaskRole("improve"), designScope: "selected_screen_or_frame",
      selectedNode: { name: "Loan", type: "FRAME", width: 360, height: 800 }, sourceTexts: SOURCE,
      components: [{ id: "10:1", name: "Button" }], renderedScreen: null, origin: "https://ux-direct.test" });
    assert.ok(brief.runs[0].ok, JSON.stringify(brief.runs));
    assert.equal(maxInFlight, 3, "detector, analyst and scout call the model at the same time");
    assert.deepEqual(brief.runs.map((run) => [run.agent, run.ok]), [["detector", true], ["analyst", true], ["scout", false]]);
    assert.match(brief.instructions, /Primary action \(from source\): Pay ₹10,000/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a hanging sub-agent is aborted at the shared deadline and never blocks the planner", async () => {
  process.env.ACTIVE_CHAT_PROVIDER = "freellmapi";
  process.env.FREELLMAPI_BASE_URL = "https://freellmapi.test/v1";
  process.env.FREELLMAPI_API_KEY = "test-key";
  process.env.UXD_SUB_AGENT_TIMEOUT_MS = "5000";
  const realFetch = globalThis.fetch;
  const imagesSent: boolean[] = [];
  let calls = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    imagesSent.push(String(init?.body || "").includes("image_url"));
    // Never answers until aborted, like a stalled upstream.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;
  const started = Date.now();
  try {
    const brief = await runSubAgents({ prompt: "make a wireframe", role: detectTaskRole("make a wireframe"), designScope: "selected_screen_or_frame",
      selectedNode: { name: "Loan", type: "FRAME", width: 360, height: 800 }, sourceTexts: SOURCE,
      components: [{ id: "10:1", name: "Button" }], renderedScreen: "data:image/png;base64,AAAA", origin: "https://ux-direct.test" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 7000, "stage stopped at its deadline, took " + elapsed + "ms");
    assert.equal(calls, 3, "one call per agent, no retries");
    assert.equal(imagesSent.filter(Boolean).length, 0, "agents are text-only; only the planner sends the screenshot");
    assert.ok(brief.runs.every((run) => !run.ok));
    assert.match(brief.instructions, /Wireframe designer/, "planner still gets the deterministic role");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.UXD_SUB_AGENT_TIMEOUT_MS;
  }
});

test("the brief is cached per source frame so variations of one frame skip the agents", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify({ domain: "fintech", userGoal: "Pay", hierarchy: ["EMI"], matches: [] }) } }] }), { status: 200 });
  }) as typeof fetch;
  const input = { prompt: "improve the cached frame", role: detectTaskRole("improve"), designScope: "selected_screen_or_frame",
    selectedNode: { name: "Cached", type: "FRAME", width: 360, height: 800 }, sourceTexts: SOURCE,
    components: [], renderedScreen: null, origin: "https://ux-direct.test" };
  try {
    const first = await runSubAgents(input);
    assert.equal(calls, 2);
    const second = await runSubAgents(input);
    assert.equal(calls, 2, "second run reuses the brief");
    assert.ok(second.runs.every((run) => run.cached));
    assert.equal(second.instructions, first.instructions);
    const variation = await runSubAgents({ ...input, prompt: "improve the cached frame\nVariation 2 of 3: list-first" });
    assert.equal(calls, 2, "a variation prompt on the same frame still hits the cache");
    assert.ok(variation.runs.every((run) => run.cached));
    await runSubAgents({ ...input, sourceTexts: [...SOURCE, "New row"] });
    assert.equal(calls, 4, "changed source content runs the agents again");
  } finally {
    globalThis.fetch = realFetch;
  }
});
