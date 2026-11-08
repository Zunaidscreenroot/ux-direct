/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");

function load(): any {
  const match = /\/\/ uxd-simplify:start([\s\S]*?)\/\/ uxd-simplify:end/.exec(code);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.plan = uxdSimplifyPlan;", sandbox);
  return sandbox;
}
function node(type: string, name: string, extra: any = {}, children: any[] = []): any {
  const n: any = { type, name, visible: true, ...extra, children };
  children.forEach((c) => { c.parent = n; });
  return n;
}
const text = (characters: string, fontSize = 14) => node("TEXT", characters.slice(0, 20), { characters, fontSize });
const button = (label: string) => node("FRAME", "Button", { height: 44, cornerRadius: 8, fills: [{ type: "SOLID", color: { r: 0, g: 0.3, b: 1 } }] }, [text(label)]);

function screen() {
  return node("FRAME", "Manage Loans", { layoutMode: "VERTICAL" }, [
    text("Manage Loans", 22),
    node("FRAME", "Alert banner", {}, [text("Overdue ₹12,570 on DMI0098765432, pay today to avoid charges")]),
    node("FRAME", "Promo banner", {}, [text("Get an instant top-up loan with zero paperwork today")]),
    node("FRAME", "Card", {}, [text("Personal Loan", 16), text("DMI0098765432", 12), text("Overdue", 12), text("₹12,570", 18),
      text("Your EMI is auto debited from your linked bank account every month", 12), button("Pay now")]),
    node("FRAME", "Card", {}, [text("Home Loan", 16), text("DMI0011223344", 12), text("₹4,500", 18), button("Pay now")]),
    node("FRAME", "Progress ring", {}, []),
    node("FRAME", "Unique alert", {}, [text("KYC expires on 12 Dec", 12)]),
  ]);
}

test("simplify drops repeated banners, helper copy and decoration, and keeps one primary button", () => {
  const { plan } = load();
  const root = screen();
  const result = plan(root);
  const why = result.drops.map((d: any) => d.why + ":" + d.node.name);
  assert.ok(why.includes("banner:Alert banner"), "the alert repeats ₹12,570 and the ID shown in the card");
  assert.ok(why.includes("banner:Promo banner"), JSON.stringify(why));
  assert.ok(why.some((w: string) => w.startsWith("helper copy:")));
  assert.ok(why.includes("decoration:Progress ring"));
  assert.ok(!why.includes("banner:Unique alert"), "a banner with a value shown nowhere else stays");
  assert.equal(result.demote.length, 1, "the second filled button becomes secondary");
});

test("a value that only exists in a banner is never dropped", () => {
  const { plan } = load();
  const root = node("FRAME", "Screen", {}, [text("Loans", 22), node("FRAME", "Alert", {}, [text("Overdue ₹9,999 on your loan account today please")])]);
  assert.equal(plan(root).drops.length, 0);
});

test("the plugin runs the simplify pass on simplify requests and reports it", () => {
  assert.match(code, /message\.op === "simplify-pass"\) result = await localSimplifyPass\(payload\)/);
  assert.match(ui, /localTask\("simplify-pass", \{ rootId: createdFrameId \}/);
  assert.match(ui, /polishNote \+ simplifyNote \+ timingLine/);
});
