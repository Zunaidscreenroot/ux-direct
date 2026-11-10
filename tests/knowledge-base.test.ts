import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CORE_KNOWLEDGE } from "@/src/knowledge/corpus";
import { normalizeDomain, normalizeRole, rankKnowledge, retrieveCoreKnowledge } from "@/src/knowledge/retrieve";
import { CATEGORY_LABELS, KNOWLEDGE_DOMAINS, KNOWLEDGE_ROLES } from "@/src/knowledge/types";
import { UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";

const top = (query: string, role?: string, domain?: string, limit = 6) =>
  rankKnowledge(CORE_KNOWLEDGE, { query, role, domain, limit }).map((item) => item.entry.id);

test("core knowledge entries are well-formed and unique", () => {
  const ids = new Set<string>();
  for (const entry of CORE_KNOWLEDGE) {
    assert.ok(!ids.has(entry.id), "duplicate id " + entry.id);
    ids.add(entry.id);
    assert.ok(entry.category in CATEGORY_LABELS, entry.id + " category");
    assert.ok(entry.body.length >= 150 && entry.body.length <= 1300, entry.id + " body length " + entry.body.length);
    assert.ok(entry.sources.length > 0, entry.id + " needs a source");
    assert.ok(entry.tags.length > 0, entry.id + " needs tags");
    for (const role of entry.roles) assert.ok(role === "all" || KNOWLEDGE_ROLES.includes(role), entry.id + " role " + role);
    for (const domain of entry.domains || []) assert.ok(KNOWLEDGE_DOMAINS.includes(domain), entry.id + " domain " + domain);
  }
  assert.ok(CORE_KNOWLEDGE.length >= 90);
});

test("knowledge covers every domain and the core UX canon", () => {
  for (const domain of KNOWLEDGE_DOMAINS.filter((d) => d !== "general")) {
    assert.ok(CORE_KNOWLEDGE.some((entry) => entry.domains?.includes(domain)), "no entry for " + domain);
  }
  for (const id of ["norman-seven-principles", "nielsen-10-heuristics", "law-fitts", "law-hick", "law-jakob", "gestalt-principles", "a11y-contrast", "ds-material3", "ds-apple-hig", "ds-fluent-carbon", "ds-polaris-atlassian"]) {
    assert.ok(CORE_KNOWLEDGE.some((entry) => entry.id === id), id);
  }
});

test("retrieval picks domain, role and task knowledge", () => {
  assert.ok(top("improve this loan EMI dashboard", "ui-designer", "fintech").includes("domain-lending"));
  assert.ok(top("review this checkout screen", "reviewer", "ecommerce").includes("quality-review-checklist"));
  assert.ok(top("write error message for failed UPI payment", "writer").includes("content-error-messages"));
  assert.ok(top("make the text contrast accessible", "accessibility").includes("a11y-contrast"));
  assert.ok(top("UX Direct kya hai").includes("identity-ux-direct"));
  assert.ok(top("material design android app bar", "ui-designer").includes("ds-material3"));
  // Domain entries stay out of unrelated domains.
  assert.ok(!top("create appointment booking screen", "ux-designer", "healthcare").includes("domain-lending"));
});

test("anti-slop rule is always included and the pack respects its budget", () => {
  const pack = retrieveCoreKnowledge({ query: "make a settings screen", role: "ui-designer", maxChars: 2500 });
  assert.equal(pack.ids[0], "quality-anti-slop");
  assert.ok(pack.chars <= 2500);
  assert.match(pack.text, /\[UX knowledge · /);
  const noPinned = rankKnowledge(CORE_KNOWLEDGE, { query: "make a settings screen", includePinned: false });
  assert.ok(!noPinned.some((item) => item.entry.id === "quality-anti-slop"));
});

test("role and domain names from the agency map onto knowledge roles", () => {
  assert.equal(normalizeRole("UX Director"), "director");
  assert.equal(normalizeRole("Reviewer"), "reviewer");
  assert.equal(normalizeRole("UI designer"), "ui-designer");
  assert.equal(normalizeRole("wireframe"), "ux-designer");
  assert.equal(normalizeRole("content"), "writer");
  assert.equal(normalizeRole("Accessibility specialist"), "accessibility");
  assert.equal(normalizeRole("UX lead"), "lead");
  assert.equal(normalizeDomain("banking"), "fintech");
  assert.equal(normalizeDomain("Healthcare"), "healthcare");
});

test("UX Direct no longer calls itself a BFSI design partner", () => {
  assert.doesNotMatch(UX_DIRECT_DESIGN_ROLE, /design partner/i);
  assert.match(UX_DIRECT_DESIGN_ROLE, /UX Director/);
  const chat = readFileSync("app/api/assistant/chat/route.ts", "utf8");
  assert.doesNotMatch(chat, /a thoughtful UI\/UX design partner/);
  assert.doesNotMatch(chat, /especially DMI Finance/);
  const plugin = readFileSync("figma-plugin/ui.html", "utf8");
  assert.doesNotMatch(plugin, /UX Audit service/);
});

test("screen pattern references are picked for screen-type tasks", () => {
  assert.ok(top("design a login screen with mobile number", "ux-designer").includes("screen-login"));
  assert.ok(top("create OTP verification screen", "ui-designer").includes("screen-otp-verify"));
  assert.ok(top("make KYC flow with PAN and selfie", "ux-designer", "fintech").includes("screen-kyc-flow"));
  assert.ok(top("transaction history list with filters", "ui-designer", "fintech").includes("screen-transaction-history"));
  assert.ok(top("payment failed screen", "writer", "fintech").includes("screen-payment-status"));
  assert.ok(top("admin data table for customers", "ux-designer", "saas").includes("screen-admin-table"));
  assert.ok(top("design like mobbin references", "lead").includes("screen-reference-use"));
  // Fintech-only screens stay out of other domains.
  assert.ok(!top("create appointment booking screen", "ux-designer", "healthcare").includes("screen-loan-application"));
  for (const entry of CORE_KNOWLEDGE.filter((item) => item.category === "screens")) {
    assert.doesNotMatch(entry.body, /mobbin|page flows/i, entry.id + " must stay abstract, not tied to a reference library");
  }
});

test("top-company design lessons are retrieved and carry no brand palettes", () => {
  assert.ok(top("make it look premium like Stripe", "ui-designer").includes("brand-lesson-style-directions"));
  assert.ok(top("balance amount typography on fintech home", "ui-designer", "fintech").includes("brand-lesson-money-numbers"));
  assert.ok(top("too many shadows on cards, clean it up", "ui-designer").includes("brand-lesson-depth-restraint"));
  for (const entry of CORE_KNOWLEDGE.filter((item) => item.id.startsWith("brand-lesson-"))) {
    assert.doesNotMatch(entry.body, /#[0-9a-f]{3,6}\b/i, entry.id + " must not copy brand hex colours");
  }
});

test("component guidance and extra screens are retrieved", () => {
  assert.ok(top("dropdown with 20 banks", "ui-designer").includes("comp-select-dropdown"));
  assert.ok(top("show a toast after saving", "ui-designer").includes("comp-snackbar-toast"));
  assert.ok(top("skeleton loading for list", "ui-designer").includes("comp-progress-loading"));
  assert.ok(top("forgot password screen", "ux-designer").includes("screen-forgot-password"));
  assert.ok(top("card controls freeze card", "ux-designer", "fintech").includes("screen-wallet-cards"));
  assert.ok(top("insurance claim flow", "ux-designer", "insurance").includes("screen-insurance-claim"));
  assert.ok(top("dark mode for the app", "ui-designer").includes("brand-lesson-dark-mode"));
  assert.ok(CORE_KNOWLEDGE.length >= 180);
});
