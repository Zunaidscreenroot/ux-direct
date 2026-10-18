import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskBrainScope } from "../src/memory/shared-brain";

test("explicit DMI and Ujjivan work stays in the matching client scope", () => {
  assert.equal(resolveTaskBrainScope("general", "DMI HFC VKYC", "Review the identity-verification journey"), "DMI_HFC");
  assert.equal(resolveTaskBrainScope("general", "Ujjivan SFB", "Review the loan application"), "UJJIVAN_SFB");
});

test("Indian financial journeys retrieve the India BFSI namespace", () => {
  assert.equal(resolveTaskBrainScope("general", "Indian loan application", "Show APR, KFS and repayment terms"), "INDIA_BFCI_SHARED");
  assert.equal(resolveTaskBrainScope("general", "BFSI onboarding", "Review the consent flow"), "INDIA_BFCI_SHARED");
});

test("Express Computers patterns stay in their project namespace", () => {
  assert.equal(resolveTaskBrainScope("express-computers", "Batch 3 wireframes", "Use Batch 2 patterns"), "EXPRESS_COMPUTERS");
});

test("generic non-financial and clearly international tasks do not receive Indian BFSI guidance", () => {
  assert.equal(resolveTaskBrainScope("general", "Retail checkout", "Improve product filters and error recovery"), "UX_DIRECT");
  assert.equal(resolveTaskBrainScope("general", "US bank card journey", "Review loan and credit card details for a United States customer"), "UX_DIRECT");
});
