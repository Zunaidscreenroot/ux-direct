import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("gateway UI is added without dropping the live health report or task dashboard", () => {
  const page = read("app/page.tsx");
  assert.ok(page.includes('label: "Model Gateway"'));
  assert.ok(page.includes("Run Plugin Health Check"));
  assert.ok(page.includes("Run smoke tests"));
  assert.ok(page.includes('activeTab === "gateway" ? <ModelGatewayPanel />'));
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

test("gateway admin secret is entered transiently, not stored in web storage", () => {
  const page = read("app/page.tsx");
  assert.ok(page.includes('value={adminKey} onChange={e=>setAdminKey(e.target.value)}'));
  assert.ok(page.includes('"x-model-gateway-admin-key":adminKey'));
  assert.ok(page.includes("never saved in browser storage"));
  assert.equal(page.includes("localStorage.setItem(\"adminKey\""), false);
  assert.equal(page.includes("sessionStorage.setItem(\"adminKey\""), false);
});

test("free-first OpenRouter example is pinned to an exact model and never silently turns on paid calls", () => {
  const env = read(".env.example");
  assert.ok(env.includes("OPENROUTER_MODELS=google/gemma-4-31b-it:free"));
  assert.ok(env.includes("ALLOW_PAID_MODELS=false"));
  assert.ok(env.includes("MODEL_GATEWAY_ADMIN_KEY="));
});


test("OpenRouter catalog and capability recommendations are dynamic, protected, and cost-aware", () => {
  const catalog = read("src/model-gateway/openrouter-catalog.ts");
  const modelsRoute = read("app/api/model-gateway/models/route.ts");
  const plannerRoute = read("app/api/model-gateway/recommendations/route.ts");
  const checkRoute = read("app/api/model-gateway/check/route.ts");
  const page = read("app/page.tsx");
  assert.ok(catalog.includes('"/models?limit=1000"'));
  assert.ok(catalog.includes('"/key"'));
  assert.ok(catalog.includes('"/activity"'));
  assert.ok(catalog.includes("getCapabilityRecommendations"));
  assert.ok(modelsRoute.includes("getLiveGatewayModels"));
  assert.ok(plannerRoute.includes("checkGatewayRateLimit"));
  assert.ok(checkRoute.includes('response.status === 429'));
  assert.ok(page.includes("gateway-tier-toggle"));
  assert.ok(page.includes("PROJECTED API COST / DAY"));
  assert.ok(page.includes("runPlanner(false)"));
  assert.ok(page.includes("Test selected model"));
});
