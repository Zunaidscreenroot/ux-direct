/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { objectivePlaybook } from "../src/figma-agent/design-thinking";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");

function load(): { classify: (p: string, ctx?: any) => any; answering: (t: any, prompt?: string) => boolean } {
  const match = /\/\/ uxd-turn-intent:start([\s\S]*?)\/\/ uxd-turn-intent:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.classify = classifyTurn; this.answering = isAnsweringQuickTask; this.resource = isResourceInstruction;", sandbox);
  return { classify: (p, ctx) => { const out = sandbox.classify(p, ctx); return out === null ? null : JSON.parse(JSON.stringify(out)); }, answering: sandbox.answering };
}

test("Zunaid's real conversation: each turn gets the right behaviour", () => {
  const { classify } = load();
  const after = { lastDesign: true };
  assert.equal(classify("make this screen simplified", {}), null, "a design request keeps the normal design route");
  assert.deepEqual(classify("this is not simplified", after), { kind: "improve", critique: "this is not simplified", rejected: true });
  assert.equal(classify("use knowledge base", after).kind, "improve");
  assert.equal(classify("for me its not cluttered", after).kind, "keep");
  assert.equal(classify("is your learning mode on", after).kind, "learning-question");
  assert.equal(classify("so if i tell you what is wrong here and what can be fixe, will you save in knowledge base for future", after).kind, "learning-question");
});

test("questions are answered, polite requests still act", () => {
  const { classify } = load();
  for (const q of ["what does this screen do?", "why is the ring purple", "kya ye accessible hai", "how many cards are there?"]) {
    assert.equal(classify(q, {}).kind, "question", q);
  }
  for (const r of ["can you make this screen simpler", "could you add an empty state", "please can you fix the spacing"]) {
    assert.equal(classify(r, {}), null, r);
  }
});

test("teaching saves a rule; feedback needs a previous screen", () => {
  const { classify } = load();
  assert.deepEqual(classify("remember: one primary button per screen", {}), { kind: "teach", rule: "one primary button per screen" });
  assert.equal(classify("from now on never use shadows on cards", {}).kind, "teach");
  assert.equal(classify("this is not simplified", {}), null, "no screen made in this chat yet");
  assert.equal(classify("still cluttered", { lastDesign: true }).kind, "improve");
  assert.equal(classify("it's not good", { lastDesign: true }).kind, "improve");
  assert.equal(classify("looks good", { lastDesign: true }).kind, "keep");
  assert.equal(classify("add a filter chip row", { lastDesign: true }), null, "a new instruction with a target is a normal request");
});

test("a question only reaches quick tasks that answer without changing the canvas", () => {
  const { answering, classify } = load();
  assert.equal(answering({ kind: "hygiene" }), true);
  assert.equal(answering({ kind: "consistency", fix: false }), true);
  assert.equal(answering({ kind: "consistency", fix: true }), false);
  assert.equal(answering({ kind: "hygiene-fix", groups: ["spacing"] }), false);
  assert.equal(answering({ kind: "design-rules", mode: "show" }), true);
  assert.equal(answering(null), false);
  assert.equal(answering({ kind: "ux-audit" }, "what is wrong here?"), false);
  assert.equal(answering({ kind: "ux-audit" }, "can you audit this screen?"), true);
  assert.equal(classify("what is wrong here?", {}).kind, "question");
});

test("objective playbook gives simplify concrete moves and honours a rejected attempt", () => {
  assert.match(objectivePlaybook("make this screen simplified"), /OBJECTIVE: SIMPLIFY/);
  assert.match(objectivePlaybook("improve the hierarchy"), /OBJECTIVE: HIERARCHY/);
  assert.equal(objectivePlaybook("add a loading state"), "");
  assert.match(objectivePlaybook("make it simple\nFEEDBACK ON THE PREVIOUS ATTEMPT (rejected by the designer): \"not simplified\""), /rejected the previous attempt/);
});

test("explanations are lessons; a critique with a reason still redoes the screen", () => {
  const { classify } = load();
  assert.deepEqual(classify("simplified means fewer colours and one primary CTA", {}), { kind: "explain", lesson: "simplified means fewer colours and one primary CTA" });
  assert.equal(classify("status chip title ke saath hona chahiye", {}).kind, "explain");
  assert.equal(classify("this is not simplified because the cards still use three colours", { lastDesign: true }).kind, "improve");
  assert.equal(classify("make the cards flatter because they look heavy", {}), null, "an instruction with a reason is a normal request");
});


test("telling me which resource to use is not saved as a design lesson", () => {
  const match = /\/\/ uxd-turn-intent:start([\s\S]*?)\/\/ uxd-turn-intent:end/.exec(ui);
  const sandbox: Record<string, any> = {};
  runInNewContext(match![1] + "\nthis.resource = isResourceInstruction;", sandbox);
  for (const text of ["use knowledge base", "please use the knowledge base", "follow the design rules", "KB use karo"]) assert.equal(sandbox.resource(text), true, text);
  for (const text of ["this is not simplified", "use fewer colours", "use the design system buttons, the cards are too heavy", "too many banners"]) assert.equal(sandbox.resource(text), false, text);
});

test("after a screen is made: change edits it in place, improve makes a new version, only revert removes", () => {
  const match = /\/\/ uxd-turn-intent:start([\s\S]*?)\/\/ uxd-turn-intent:end/.exec(ui);
  const sandbox: Record<string, any> = {};
  runInNewContext(match![1] + "\nthis.classify = classifyTurn; this.wantsNew = wantsNewFrame;", sandbox);
  const after = { lastDesign: true };
  const kind = (p: string) => { const out = sandbox.classify(p, after); return out && out.kind; };
  for (const p of ["thik karo", "better karo", "isko better banao", "improve it", "make it better", "theek kar do", "polish this", "try again"]) {
    assert.equal(kind(p), "improve", p);
  }
  for (const p of ["make it bigger", "more spacing between fields", "header ka color blue karo", "forgot password link add karo", "button hata do", "title bada karo"]) {
    assert.equal(kind(p), "edit", p);
  }
  for (const p of ["revert", "undo this", "revert karo", "wapas karo", "pehle jaisa kar do"]) {
    assert.equal(kind(p), null, p + " goes to the revert task");
  }
  assert.equal(sandbox.classify("header ka color blue karo", {}), null, "no screen made yet: normal routing");
  for (const p of ["change the header colour", "update the button label to Continue", "add a remember me checkbox", "edit the layout spacing"]) {
    assert.equal(sandbox.wantsNew(p), false, p + " stays in place");
  }
  for (const p of ["create a signup screen", "make a new version", "redesign this", "improve this screen", "generate 3 variations", "naya screen banao"]) {
    assert.equal(sandbox.wantsNew(p), true, p);
  }
});
