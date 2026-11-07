import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../figma-plugin/ui.html", import.meta.url), "utf8");
const chatRoute = readFileSync(new URL("../app/api/assistant/chat/route.ts", import.meta.url), "utf8");

function questionParser() {
  const start = ui.indexOf("function agentStripAskBlock");
  const end = ui.indexOf("function agentOfferQuestions");
  return new Function(ui.slice(start, end) + "; return { agentStripAskBlock, agentParseQuestions };")() as {
    agentStripAskBlock: (text: string) => string;
    agentParseQuestions: (text: string) => Array<{ q: string; options: string[]; recommended: number }>;
  };
}

test("FreeLLMAPI is not shown anywhere in the plugin UI", () => {
  assert.equal(/freellm/i.test(ui), false);
  assert.equal(ui.includes('id="providerSelect"'), false, "no provider switcher in the Connected panel");
  assert.ok(ui.includes("Free models · UX Direct gateway"));
});

test("numbered clarifying questions become clickable options", () => {
  const { agentParseQuestions } = questionParser();
  const reply = "Could you let me know:\n\n1. Which sections you consider non-essential (e.g., banners, extra cards, duplicate metrics)?\n" +
    "2. Whether you want to keep the progress rings or replace them with a simpler indicator.\n" +
    "3. If you prefer a single-column layout or a two-column layout.";
  const questions = agentParseQuestions(reply);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0].options, ["Banners", "Extra cards", "Duplicate metrics"]);
  assert.deepEqual(questions[1].options, ["Keep the progress rings", "Replace them with a simpler indicator"]);
  assert.deepEqual(questions[2].options, ["Single-column layout", "Two-column layout"]);
  assert.equal(agentParseQuestions("Done. The copy is next to the original.").length, 0, "no chips without a question");
});

test("a uxd-ask block is parsed and hidden from the reply text", () => {
  const { agentParseQuestions, agentStripAskBlock } = questionParser();
  const reply = 'Pick one.\n```uxd-ask\n{"questions":[{"q":"Density?","options":["Compact","Comfortable"],"recommended":1}]}\n```';
  assert.deepEqual(agentParseQuestions(reply), [{ q: "Density?", options: ["Compact", "Comfortable"], recommended: 1 }]);
  assert.equal(agentStripAskBlock(reply), "Pick one.");
  assert.ok(ui.includes("agentStripAskBlock(content)"), "the block never renders in a bubble");
  assert.ok(chatRoute.includes("PLUGIN_ASK_PROTOCOL") && chatRoute.includes("ALLOWED_FIGMA_ORIGINS.has(request.headers.get(\"origin\")"),
    "plugin chats are told to send questions as a uxd-ask block");
});

test("canvas changes ask first: design, native plan, quick tasks and direct edits", () => {
  assert.ok(ui.includes("const designPlan = await agentPlanDesign(prompt);"));
  assert.ok(ui.includes("const actions = await agentReviewActions(payload.actions, payload.summary, canvas);"));
  assert.ok(ui.includes("if (agentQuickTaskWrites(task) && !(await agentConfirm(agentDescribeQuickTask(task)"));
  assert.ok(ui.includes('if (!(await agentConfirm("Apply this edit?"'));
  assert.ok(ui.includes("agentCancelAsks"), "Stop cancels a waiting question");
  assert.ok(ui.includes('id="askModeToggle"'), "Ask first / Auto toggle");
});

test("run card shows numbered steps and the orb has distinct modes", () => {
  assert.ok(ui.includes("agentStart(prompt);"));
  for (const route of ['agentRoute("design")', 'agentRoute("native")', 'agentRoute("quick")', 'agentRoute("direct")', 'agentRoute("chat")']) {
    assert.ok(ui.includes(route), route);
  }
  for (const mode of ['data-agent-mode="thinking"', 'data-agent-mode="building"', 'data-agent-mode="asking"']) assert.ok(ui.includes(mode), mode);
  const effects = readFileSync(new URL("../figma-plugin/ui-effects.tsx", import.meta.url), "utf8");
  assert.ok(effects.includes('asking: "listening"'));
});
