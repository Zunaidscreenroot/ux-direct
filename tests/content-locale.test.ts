import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasTexts, contentLocaleInstruction, inferContentLocale } from "../src/figma-agent/content-locale";
import { createScopeInstructions } from "../src/figma-agent/create-mode";

test("content locale follows prompt, then design rules, then canvas, then the ₹ default", () => {
  assert.equal(inferContentLocale({ prompt: "food delivery order tracking for a US city" }).code, "USD");
  assert.equal(inferContentLocale({ prompt: "food delivery order tracking", designRules: "Prices in EUR, 2 decimals" }).code, "EUR");
  const texts = canvasTexts({ nodes: [{ type: "FRAME", children: [{ type: "TEXT", text: "Subtotal £12.40" }, { type: "TEXT", text: "Delivery £2.99" }] }] });
  assert.deepEqual(texts, ["Subtotal £12.40", "Delivery £2.99"]);
  assert.equal(inferContentLocale({ prompt: "order tracking", texts }).code, "GBP");
  const fallback = inferContentLocale({ prompt: "food delivery order tracking" });
  assert.equal(fallback.code, "INR");
  assert.equal(fallback.source, "default");
  // Words that only look like a region do not switch the currency.
  assert.equal(inferContentLocale({ prompt: "CONTACT US for french fries" }).code, "INR");
});

test("create mode carries the locale line instead of a hard-coded Indian finance format", () => {
  const line = contentLocaleInstruction(inferContentLocale({ prompt: "checkout in dollars" }));
  const text = createScopeInstructions({ width: 360, height: 800, platform: "mobile" }, line);
  assert.match(text, /CONTENT LOCALE: Taken from the prompt: amounts in USD/);
  assert.doesNotMatch(text, /Indian finance/);
});
