import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("home opens the unified chat-first workspace instead of the operations dashboard", () => {
  const page = read("app/page.tsx");
  const chat = read("app/chat/page.tsx");
  assert.ok(page.includes('redirect("/chat")'));
  assert.ok(chat.includes("Message UX Direct"));
  assert.ok(chat.includes("Audit"));
  assert.ok(chat.includes("Connections"));
  assert.ok(chat.includes("ThinkingOrb"));
  assert.ok(chat.includes('from "thinking-orbs"'));
  assert.equal(chat.includes("ud-brain-orb"), false);
  assert.equal(page.includes("ModelGatewayPanel"), false);
});

test("UX Direct chat only accepts explicit free OpenRouter model IDs and disables provider fallbacks", () => {
  const route = read("app/api/assistant/chat/route.ts");
  const status = read("app/api/assistant/status/route.ts");
  assert.ok(route.includes('model.endsWith(":free")'));
  assert.ok(route.includes("provider: { allow_fallbacks: false }"));
  assert.ok(route.includes("OPENROUTER_API_KEY"));
  assert.ok(status.includes('row.id.endsWith(":free")'));
  assert.ok(status.includes('model.endsWith(":free")'));
  assert.ok(status.includes("openrouter.ai/api/v1/models"));
});

test("production gateway settings writes require the server-side admin key", () => {
  const route = read("app/api/model-gateway/settings/route.ts");
  assert.ok(route.includes("MODEL_GATEWAY_ADMIN_KEY"));
  assert.ok(route.includes("timingSafeEqual"));
  assert.ok(route.includes("Gateway settings are read-only until MODEL_GATEWAY_ADMIN_KEY is configured"));
  assert.ok(route.includes("localSettingsWritesAllowed"));
});

test("task planning is rate-limited and gateway rate limiter supports tighter route-specific limits", () => {
  const route = read("app/api/tasks/plan/route.ts");
  const limiter = read("src/model-gateway/rate-limit.ts");
  assert.ok(route.includes('checkGatewayRateLimit("task-plan:" + clientIp, Date.now(), 10)'));
  assert.ok(route.includes("status: 429"));
  assert.ok(limiter.includes("maxRequests = MAX_REQUESTS_PER_WINDOW"));
});

test("legacy gateway credentials remain server-only and are not saved in browser storage", () => {
  const chat = read("app/chat/page.tsx");
  const settingsRoute = read("app/api/model-gateway/settings/route.ts");
  assert.equal(chat.includes("MODEL_GATEWAY_ADMIN_KEY"), false);
  assert.equal(chat.includes("x-model-gateway-admin-key"), false);
  assert.equal(chat.includes('localStorage.setItem("adminKey"'), false);
  assert.equal(chat.includes('sessionStorage.setItem("adminKey"'), false);
  assert.ok(settingsRoute.includes("MODEL_GATEWAY_ADMIN_KEY"));
});

test("OpenRouter homepage chat stays free-only while internal routing is dynamic and cost-sensitive", () => {
  const env = read(".env.example");
  assert.ok(env.includes("OPENROUTER_MODELS=google/gemma-4-31b-it:free"));
  assert.ok(env.includes("OPENROUTER_AUTO_ROUTING=true"));
  assert.ok(env.includes("OPENROUTER_AUTO_MAX_INPUT_USD_PER_1M=0.10"));
  assert.ok(env.includes("OPENROUTER_AUTO_MAX_OUTPUT_USD_PER_1M=0.30"));
  assert.ok(env.includes("ALLOW_PAID_MODELS=false"));
  assert.ok(env.includes("MODEL_GATEWAY_ADMIN_KEY="));
  assert.ok(!env.includes("OPENROUTER_PAID_MODELS"));
  assert.ok(!env.includes("UXD_INTERNAL_PAID_MODEL"));
  assert.ok(!env.includes("MODEL_GATEWAY_MONTHLY_BUDGET_INR=3000"));
});
