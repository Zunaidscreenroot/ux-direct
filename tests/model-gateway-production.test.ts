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

test("UX Direct chat, Figma routes and provider health use FreeLLMAPI", () => {
  const route = read("app/api/assistant/chat/route.ts");
  const figmaAgent = read("app/api/assistant/figma-agent/route.ts");
  const review = read("app/api/assistant/figma-agent/review/route.ts");
  const refine = read("app/api/assistant/figma-agent/refine/route.ts");
  const status = read("app/api/assistant/status/route.ts");
  const policy = read("src/providers/freellmapi-models.ts");
  assert.ok(route.includes("const ROUTER_MODEL = FREELLMAPI_MODELS[0]"));
  assert.equal(route.includes("FALLBACK_MODEL"), false);
  assert.ok(route.includes("const candidates = [ROUTER_MODEL];"));
  assert.ok(route.includes("max_tokens: 25000"));
  assert.ok(route.includes("FREELLMAPI_API_KEY"));
  assert.ok(route.includes("FREELLMAPI_BASE_URL"));
  assert.ok(route.includes('const endpoint = baseUrl + "/chat/completions";'));
  assert.equal(route.includes("openrouter.ai"), false);
  const figmaModels = policy.slice(policy.indexOf("export const FIGMA_AGENT_MODELS"), policy.indexOf("export type FigmaAgentModelId"));
  assert.deepEqual([...figmaModels.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]), ["auto"]);
  assert.ok(policy.includes("UX_DIRECT_DESIGN_ROLE"));
  const generalModels = policy.slice(policy.indexOf("export const FREELLMAPI_MODELS"), policy.indexOf("export const FREELLMAPI_MODEL_LABELS"));
  assert.deepEqual([...generalModels.matchAll(/"([^"]+)"/g)].map((match) => match[1]), ["auto"]);
  for (const routeText of [figmaAgent, review, refine]) {
    assert.ok(routeText.includes("FIGMA_AGENT_MODELS"));
    assert.ok(routeText.includes("FREELLMAPI_API_KEY"));
    assert.ok(routeText.includes("FREELLMAPI_BASE_URL"));
    assert.ok(routeText.includes("UX_DIRECT_DESIGN_ROLE"));
    assert.equal(routeText.includes("openrouter.ai"), false);
  }
  assert.ok(status.includes("defaultModel: FREELLMAPI_MODELS[0]"));
  assert.ok(status.includes("FREELLMAPI_MODEL_LABELS[index]"));
  assert.ok(status.includes('baseUrl + "/models"'));
  assert.equal(status.includes("openrouter.ai"), false);
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

test("FreeLLMAPI environment configuration is server-only and has no OpenRouter dependency", () => {
  const env = read(".env.example");
  assert.ok(env.includes("FREELLMAPI_BASE_URL="));
  assert.ok(env.includes("FREELLMAPI_API_KEY="));
  assert.ok(env.includes("FREELLMAPI_MODELS=auto"));
  assert.ok(env.includes("MODEL_GATEWAY_ADMIN_KEY="));
  assert.equal(env.includes("OPENROUTER_API_KEY"), false);
  assert.equal(env.includes("OPENROUTER_MODELS"), false);
  assert.equal(env.includes("OPENROUTER_AUTO_ROUTING"), false);
  assert.equal(env.includes("OPENROUTER_PAID_MODELS"), false);
  assert.equal(env.includes("UXD_INTERNAL_PAID_MODEL"), false);
  assert.equal(env.includes("MODEL_GATEWAY_MONTHLY_BUDGET_INR=3000"), false);
});


test("IA audit server and browser allow a long-running model response without a 15-second override", () => {
  const route = read("app/api/ia/audit/route.ts");
  const page = read("app/ia-demo/page.tsx");
  assert.ok(route.includes("timeoutMs: 120_000"));
  assert.equal(route.includes("timeoutMs: 15_000"), false);
  assert.ok(page.includes("controller.abort(), 135_000"));
  assert.equal(page.includes("controller.abort(), 35_000"), false);
});


test("screenshot UX audits use the dynamic gateway and carry long-running cancellation through", () => {
  const route = read("app/api/ux-audit/analyze/route.ts");
  const env = read(".env.example");
  assert.ok(route.includes('model: "uxd/vision"'));
  assert.ok(route.includes("timeoutMs: 120_000"));
  assert.ok(route.includes("signal: request.signal"));
  assert.equal(route.includes("UXD_AUDIT_MODEL"), false);
  assert.equal(route.includes("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"), false);
  assert.equal(env.includes("UXD_AUDIT_MODEL="), false);
});

test("competitor benchmarks validate named sites and explain missing comparison evidence", () => {
  const route = read("app/api/ux-audit/analyze/route.ts");
  const page = read("app/audit-demo/page.tsx");
  assert.ok(route.includes("new Map(input.screenshots.map"));
  assert.ok(route.includes("const hasMultipleSites = allowedSites.size >= 2"));
  assert.ok(page.includes("benchmarkSiteCount < 2"));
  assert.ok(page.includes("No comparable observations were validated from this run."));
});

test("Lighthouse benchmarking allows enough time for page load and measurements", () => {
  const route = read("app/api/ux-audit/lighthouse/route.ts");
  assert.ok(route.includes("controller.abort(), 90_000"));
  assert.equal(route.includes("controller.abort(), 25_000"), false);
});
