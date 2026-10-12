import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

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

test("OpenRouter cockpit uses only the explicit free and expertise-routed paid allowlists", () => {
  const env = read(".env.example");
  const gateway = read("src/model-gateway/index.ts");
  const allowlist = read("src/model-gateway/openrouter-paid.ts");
  const chatRoute = read("app/api/assistant/chat/route.ts");
  const catalogRoute = read("app/api/model-gateway/models/route.ts");
  assert.ok(env.includes("OPENROUTER_API_KEY="));
  assert.ok(env.includes("ALLOW_PAID_MODELS=false"));
  assert.ok(env.includes("MODEL_GATEWAY_ADMIN_KEY="));
  assert.ok(allowlist.includes('id: "nvidia/nemotron-3.5-lightning:free"'));
  assert.ok(allowlist.includes('id: "nvidia/nemotron-3-ultra-550b-a55b:free"'));
  assert.ok(allowlist.includes('id: "qwen/qwen3.8-27b:free"'));
  assert.ok(allowlist.includes('id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"'));
  assert.ok(allowlist.includes('id: "openai/gpt-oss-20b"'));
  assert.ok(allowlist.includes('id: "openai/gpt-oss-120b"'));
  assert.ok(allowlist.includes('id: "deepseek/deepseek-v4.1-flash"'));
  assert.ok(allowlist.includes('id: "openai/gpt-6-luna"'));
  assert.ok(allowlist.includes('id: "deepseek/deepseek-v4-flash-0731"'));
  assert.ok(gateway.includes("chatCompletionFreeFirstThenPaid"));
  assert.equal(gateway.includes("assertBudgetAllows(promptChars"), false);
  assert.ok(chatRoute.includes("chatCompletionFreeFirstThenPaid"));
  assert.ok(catalogRoute.includes("getModelCatalog"));
});

test("OpenRouter account reporting is server-side and removed from application-side budget gates", () => {
  const env = read(".env.example");
  const gateway = read("src/model-gateway/index.ts");
  const route = read("app/api/model-gateway/openrouter-account/route.ts");
  const page = read("app/page.tsx");
  assert.ok(env.includes("OPENROUTER_MANAGEMENT_KEY="));
  assert.ok(route.includes('getOpenRouterJson("credits", managementKey)'));
  assert.ok(route.includes('getOpenRouterJson("activity", managementKey)'));
  assert.ok(route.includes('getOpenRouterJson("key", apiKey)'));
  assert.ok(route.includes("MODEL_GATEWAY_ADMIN_KEY"));
  assert.ok(route.includes("timingSafeEqual"));
  assert.equal(route.includes("OPENROUTER_MANAGEMENT_KEY"), true);
  assert.ok(page.includes("CREDIT RUNWAY PLANNER"));
  assert.ok(page.includes("AVAILABLE ACCOUNT CREDITS"));
  assert.ok(page.includes('"x-model-gateway-admin-key":adminKey'));
  assert.equal(/Global monthly budget|Module budget \/ month|Max cost \/ request|MONTHLY CAP|MAX \/ REQUEST/.test(page), false);
  assert.equal(gateway.includes("assertBudgetAllows(promptChars"), false);
});


test("gateway exact-model selector exposes all nine approved OpenRouter models", () => {
  const page = read("app/page.tsx");
  for (const id of [
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "qwen/qwen3.8-27b:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "openai/gpt-6-luna",
    "deepseek/deepseek-v4-flash-0731",
    "deepseek/deepseek-v4.1-flash"
  ]) assert.ok(page.includes("\"" + id + "\""));
  assert.ok(page.includes("models.filter(m=>selectionCompatible(mode,m))"));
  assert.ok(page.includes('APPROVED_OPENROUTER_MODEL_IDS.has(m.id)'));
});

test("cockpit task planner reports real gateway mode/model instead of hard-coded mock mode", () => {
  const page = read("app/page.tsx");
  assert.ok(page.includes('planResult.mode === "gateway" ? "OPENROUTER" : "MOCK"'));
  assert.ok(page.includes('planResult.diagnostics?.model ?? "not reported"'));
  assert.equal(page.includes("Plan created in mock mode."), false);
  assert.equal(page.includes("This first vertical slice uses a deterministic mock provider."), false);
});

test("Figma cockpit identifies all approved pool tiers and paid-model readiness", () => {
  const ui = read("figma-plugin/ui.html");
  assert.ok(ui.includes('freeGroup.label = "Free · tried first ("'));
  assert.ok(ui.includes('paidGroup.label = "Paid · fallback ("'));
  assert.ok(ui.includes('" + readyPaidModels + " of " + paidModels.length'));
});


test("Figma cockpit keeps explicit no-edit prompts in conversational planning mode", () => {
  const ui = read("figma-plugin/ui.html");
  const start = ui.indexOf("function requestsFigmaEdit(text) {");
  const end = ui.indexOf("\n      const designIntent =", start);
  assert.ok(start >= 0, "intent classifier should be present in the plugin UI");
  assert.ok(end > start, "intent classifier should end before the request is built");
  const classifierSource = ui.slice(start, end).trim();
  const requestsFigmaEdit = runInNewContext("(" + classifierSource + ")") as (prompt: string) => boolean;

  assert.equal(
    requestsFigmaEdit("Plan a VKYC journey. Include consent, identity verification, video verification, failure states, retries, and recovery. Do not modify Figma."),
    false
  );
  assert.equal(requestsFigmaEdit("Review this screen; no Figma changes."), false);
  assert.equal(requestsFigmaEdit("Rename the selected frame to VKYC Verification"), true);
  assert.equal(requestsFigmaEdit("Update the primary CTA text"), true);
});


test("visual edit requests have bounded deterministic output and an explicit vision timeout", () => {
  const route = read("app/api/assistant/chat/route.ts");
  const gateway = read("src/model-gateway/index.ts");
  const ui = read("figma-plugin/ui.html");
  assert.ok(route.includes('temperature: data.selection?.previewDataUrl || data.intent === "design-operation" ? 0.1 : 0.3'));
  assert.ok(route.includes('max_tokens: data.selection?.previewDataUrl ? 1200 : data.intent === "design-operation" ? 900 : 1400'));
  assert.ok(route.includes('reasoning: { effort: "minimal" as const, max_tokens: 160 }'));
  assert.match(gateway, /provider:\s*\{\s*sort:\s*"throughput"\s*\}/);
  assert.ok(gateway.includes("Math.max(timeoutMs, 45_000)"));
  assert.ok(gateway.includes("does not support screenshot input"));
  assert.ok(gateway.includes("function normalizeChatText(value: unknown): string | undefined"));
  assert.ok(gateway.includes("no user-facing text (finish_reason="));
  assert.ok(ui.includes('const routeNote = data.fallbackReason ? data.fallbackReason + " " : ""'));
});


test("screenshot requests use bounded reasoning even when the user asks for a conversational audit", () => {
  const route = read("app/api/assistant/chat/route.ts");
  assert.ok(route.includes('data.selection?.previewDataUrl || data.intent === "design-operation"'));
  assert.ok(route.includes('data.selection?.previewDataUrl ? 1200 : data.intent === "design-operation" ? 900 : 1400'));
  assert.ok(route.includes('data.selection?.previewDataUrl || data.intent === "design-operation"\n        ? { reasoning: { effort: "minimal" as const, max_tokens: 160 } }'));
});


test("free vision models are shown with their screenshot capability and only need paid inference after free attempts fail", () => {
  const route = read("app/api/model-status/route.ts");
  const gateway = read("src/model-gateway/index.ts");
  const ui = read("figma-plugin/ui.html");
  assert.ok(route.includes("supportsImages: model.supportsImages"));
  assert.ok(gateway.includes("selectOpenRouterPaidVisionModel"));
  assert.ok(gateway.includes("freeVisionModels.filter(model => model.supportsImages)"));
  assert.ok(read("app/api/assistant/chat/route.ts").includes("forcePaidVision: true"));
  assert.ok(ui.includes("up to two approved free vision models first"));
  assert.ok(ui.includes("a paid fallback may consume account credits"));
});
