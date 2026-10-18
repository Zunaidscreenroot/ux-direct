import { test } from "node:test";

// Ensure provider-adapter tests exercise stubbed free/local modes, never live paid routing.
(process.env as unknown as Record<string, string | undefined>).NODE_ENV = "test";
import assert from "node:assert/strict";
import { chatCompletion, GatewayError, estimateChatContentChars, isValidChatContent, resolveProvider, type ProviderConfig } from "../src/model-gateway";

const providers: ProviderConfig[] = [
  { name: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key", models: ["gpt-test"] },
  { name: "local", baseUrl: "http://localhost:11434/v1", models: ["default"] }
];

test("routes only explicitly configured models", () => {
  assert.equal(resolveProvider("gpt-test", providers).name, "openai");
  assert.throws(() => resolveProvider("unknown-model", providers), (error: unknown) =>
    error instanceof GatewayError && error.status === 400);
});

test("registers DeepSeek paid models only after the paid master switch is enabled", async () => {
  const { providersFromEnv } = await import("../src/model-gateway");
  const off = providersFromEnv({ NODE_ENV: "test", DEEPSEEK_API_KEY: "test-key", ALLOW_PAID_MODELS: "false" });
  assert.equal(off.some(provider => provider.name === "deepseek"), false);
  const on = providersFromEnv({ NODE_ENV: "test", DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODELS: "deepseek-flash,deepseek-v4-pro", ALLOW_PAID_MODELS: "true", MODEL_GATEWAY_MONTHLY_BUDGET_INR: "3000" });
  assert.equal(on.some(provider => provider.name === "deepseek" && provider.models.includes("deepseek-flash") && provider.models.includes("deepseek-v4-pro")), true);
});

test("normalizes a successful OpenAI-compatible response", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const result = await chatCompletion({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 12,
    response_format: { type: "json_object" }
  }, {
    providers,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      calledBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "chat-test",
        model: "gpt-test",
        choices: [{ message: { content: "hello back" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });
  assert.equal(calledUrl, "https://example.test/v1/chat/completions");
  assert.equal(calledBody.max_tokens, 12);
  assert.deepEqual(calledBody.response_format, { type: "json_object" });
  assert.equal(result.content, "hello back");
  assert.equal(result.provider, "openai");
  assert.equal(result.usage?.total_tokens, 5);
});

test("retries one malformed JSON response on a non-paid route before failing", async () => {
  let calls = 0;
  const result = await chatCompletion({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }]
  }, {
    providers,
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return new Response("<html>temporary upstream response</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });
  assert.equal(calls, 2);
  assert.equal(result.content, "recovered");
});

test("surfaces provider failures without leaking credentials", async () => {
  await assert.rejects(() => chatCompletion({
    model: "gpt-test", messages: [{ role: "user", content: "hello" }]
  }, {
    providers,
    fetchImpl: (async () => new Response("provider unavailable", { status: 503 })) as typeof fetch
  }), (error: unknown) => error instanceof GatewayError && error.status === 502);
});

test("allows a local OpenAI-compatible endpoint without an API key", async () => {
  const result = await chatCompletion({
    model: "local-model", messages: [{ role: "user", content: "hi" }]
  }, {
    providers: [{ name: "local", baseUrl: "http://localhost:11434/v1", models: ["local-model"] }],
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
    }) as typeof fetch
  });
  assert.equal(result.content, "hello");
});


test("built-in mock works with no provider credentials and never calls network", async () => {
  const result = await chatCompletion({
    model: "mock/ux-direct",
    messages: [{ role: "user", content: "design a loan repayment screen" }]
  }, { providers: [{ name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" }] });
  assert.equal(result.provider, "mock");
  assert.equal(result.usage?.total_tokens, 0);
  assert.match(result.content, /no model API called/);
});

test("provider environment config enables free-tier options only when a key exists", async () => {
  const { providersFromEnv, getModelCatalog, routeTask } = await import("../src/model-gateway");
  const empty = providersFromEnv({ NODE_ENV: "production" });
  assert.deepEqual(empty.map(p => p.name), ["mock"]);
  const configured = providersFromEnv({
    NODE_ENV: "production",
    GROQ_API_KEY: "test-only",
    GROQ_MODELS: "openai/gpt-oss-20b"
  });
  assert.equal(configured.some(p => p.name === "groq"), true);
  assert.equal(getModelCatalog(configured).find(m => m.id === "openai/gpt-oss-20b")?.configured, true);
  assert.equal(routeTask("classify", configured).provider, "groq");
});

test("rejects oversized message payloads before provider invocation", async () => {
  await assert.rejects(() => chatCompletion({
    model: "gpt-test",
    messages: [{ role: "user", content: "x".repeat(200_001) }]
  }, { providers }), (error: unknown) =>
    error instanceof GatewayError && error.status === 413);
});


test("paid provider keys do not enable paid routing without explicit opt-in", async () => {
  const { providersFromEnv } = await import("../src/model-gateway");
  const locked = providersFromEnv({ NODE_ENV: "production", OPENAI_API_KEY: "test-only" });
  assert.equal(locked.some(p => p.name === "openai"), false);
  const missingPrices = providersFromEnv({ NODE_ENV: "production", OPENAI_API_KEY: "test-only", ALLOW_PAID_MODELS: "true", MODEL_GATEWAY_MONTHLY_BUDGET_INR: "3000" });
  // Listing is not activation: paid requests still require exact-model prices and budgets.
  assert.equal(missingPrices.some(p => p.name === "openai"), true);
  const enabled = providersFromEnv({
    NODE_ENV: "production", OPENAI_API_KEY: "test-only", ALLOW_PAID_MODELS: "true",
    MODEL_GATEWAY_INPUT_PRICE_INR_PER_1M: "12", MODEL_GATEWAY_OUTPUT_PRICE_INR_PER_1M: "48",
    MODEL_GATEWAY_MONTHLY_BUDGET_INR: "3000"
  });
  assert.equal(enabled.some(p => p.name === "openai" && p.models.includes("gpt-4o-mini")), true);
});


test("internal routing stays blocked until OpenRouter routing is enabled", async () => {
  const { saveGatewaySettings, defaultGatewaySettings, modelKey } = await import("../src/model-gateway/control-store");
  const settings = defaultGatewaySettings();
  settings.paidRoutingEnabled = false;
  settings.modules.critique = {
    ...settings.modules.critique,
    mode: "paid",
    selectedModelKey: modelKey("openrouter-auto", "openrouter/auto"),
    allowFallback: false
  };
  await saveGatewaySettings(settings);
  const configured: ProviderConfig[] = [
    { name: "openrouter-auto", baseUrl: "https://openrouter.example/api/v1", apiKey: "test-key", models: ["openrouter/auto"], kind: "paid" },
    { name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" }
  ];
  await assert.rejects(() => chatCompletion({
    model: "uxd/critique",
    moduleId: "critique",
    messages: [{ role: "user", content: "Review this screen." }]
  }, { providers: configured }), (error: unknown) =>
    error instanceof GatewayError && error.status === 403 && /Paid routing is locked/.test(error.message));
});


test("homepage free models stay separate from the dynamic internal OpenRouter router", async () => {
  const { providersFromEnv } = await import("../src/model-gateway");
  const env = {
    NODE_ENV: "production",
    OPENROUTER_API_KEY: "test-only",
    OPENROUTER_MODELS: "vendor/free-model:free,vendor/not-enabled"
  };
  const noRouter = providersFromEnv({ ...env, OPENROUTER_AUTO_ROUTING: "false", ALLOW_PAID_MODELS: "false" });
  assert.deepEqual(noRouter.find(p => p.name === "openrouter")?.models, ["vendor/free-model:free"]);
  assert.equal(noRouter.find(p => p.name === "openrouter")?.kind, "free-tier");
  assert.equal(noRouter.some(p => p.name === "openrouter-auto"), false);

  const routerEnabled = providersFromEnv({ ...env, OPENROUTER_AUTO_ROUTING: "true", ALLOW_PAID_MODELS: "false" });
  assert.deepEqual(routerEnabled.find(p => p.name === "openrouter")?.models, ["vendor/free-model:free"]);
  assert.equal(routerEnabled.find(p => p.name === "openrouter")?.kind, "free-tier");
  assert.deepEqual(routerEnabled.find(p => p.name === "openrouter-auto")?.models, ["openrouter/auto"]);
  assert.equal(routerEnabled.find(p => p.name === "openrouter-auto")?.kind, "paid");
});

test("OpenRouter Auto applies its low-cost tier and price ceilings without requiring a monthly budget", async () => {
  const { chatCompletion } = await import("../src/model-gateway");
  const { saveGatewaySettings, defaultGatewaySettings, modelKey } = await import("../src/model-gateway/control-store");
  const settings = defaultGatewaySettings();
  settings.paidRoutingEnabled = true;
  settings.modules["ia-audit"] = {
    ...settings.modules["ia-audit"],
    mode: "paid",
    selectedModelKey: modelKey("openrouter-auto", "openrouter/auto"),
    monthlyBudgetInr: 0,
    maxRequestCostInr: 0
  };
  await saveGatewaySettings(settings);
  let body: Record<string, unknown> = {};
  const configured: ProviderConfig[] = [
    { name: "openrouter-auto", baseUrl: "https://openrouter.example/api/v1", apiKey: "test", models: ["openrouter/auto"], kind: "paid" },
    { name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" }
  ];
  try {
    const result = await chatCompletion({
      model: "openrouter/auto",
      moduleId: "ia-audit",
      providerId: "openrouter-auto",
      messages: [{ role: "user", content: "Review this information architecture." }],
      max_tokens: 64
    }, {
      providers: configured,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          model: "vendor/selected-cheap-model",
          choices: [{ message: { content: "IA review complete." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch
    });
    assert.deepEqual(body.plugins, [{ id: "auto-router", cost_tier: "low" }]);
    assert.deepEqual(body.provider, { max_price: { prompt: 0.2, completion: 0.5 } });
    assert.deepEqual(body.usage, { include: true });
    assert.equal(result.model, "vendor/selected-cheap-model");
    assert.equal(result.content, "IA review complete.");
  } finally {
    await saveGatewaySettings(defaultGatewaySettings());
  }
});

test("custom endpoints are disabled unless local or paid mode is explicitly enabled", async () => {
  const { providersFromEnv } = await import("../src/model-gateway");
  const disabled = providersFromEnv({
    NODE_ENV: "production",
    CUSTOM_OPENAI_COMPATIBLE_BASE_URL: "https://provider.example/v1",
    CUSTOM_OPENAI_COMPATIBLE_API_KEY: "test-only",
    CUSTOM_OPENAI_COMPATIBLE_KIND: "paid"
  });
  assert.equal(disabled.some(p => p.name === "custom"), false);
  const local = providersFromEnv({
    NODE_ENV: "production",
    CUSTOM_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1",
    CUSTOM_OPENAI_COMPATIBLE_KIND: "local"
  });
  assert.equal(local.some(p => p.name === "custom" && p.kind === "local"), true);
});


test("an explicitly chosen model never silently fails over from a paid internal module", async () => {
  const { chatCompletionWithFallback } = await import("../src/model-gateway");
  const { saveGatewaySettings, defaultGatewaySettings, modelKey } = await import("../src/model-gateway/control-store");
  const configured: ProviderConfig[] = [
    { name: "groq", baseUrl: "https://groq.example/v1", apiKey: "test", models: ["openai/gpt-oss-20b"], kind: "free-tier" },
    { name: "openrouter-auto", baseUrl: "https://paid.example/v1", apiKey: "test", models: ["openrouter/auto"], kind: "paid" },
    { name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" }
  ];
  const settings = defaultGatewaySettings();
  settings.modules.general = {
    ...settings.modules.general,
    mode: "paid",
    selectedModelKey: modelKey("openrouter-auto", "openrouter/auto"),
    allowFallback: false
  };
  await saveGatewaySettings(settings);
  const attempted: string[] = [];
  try {
    await assert.rejects(() => chatCompletionWithFallback({
      model: "openai/gpt-oss-20b", moduleId: "general", providerId: "groq",
      messages: [{ role: "user", content: "Classify this design task." }]
    }, {
      providers: configured,
      fetchImpl: (async (input: RequestInfo | URL) => {
        attempted.push(String(input));
        return new Response("rate limited", { status: 429 });
      }) as typeof fetch
    }), (error: unknown) => error instanceof GatewayError && error.status === 403 &&
      /Request model does not match the exact module selection/.test(error.message));
    assert.equal(attempted.length, 0);
  } finally {
    await saveGatewaySettings(defaultGatewaySettings());
  }
});


test("rate limiter blocks bursts and resets after the window", async () => {
  const { checkGatewayRateLimit } = await import("../src/model-gateway/rate-limit");
  const key = "unit-test-rate-limit";
  for (let i = 0; i < 30; i++) assert.equal(checkGatewayRateLimit(key, 1_000).allowed, true);
  const blocked = checkGatewayRateLimit(key, 1_001);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(checkGatewayRateLimit(key, 61_001).allowed, true);
});


test("monthly budget blocks paid calls when pricing is missing or projected cost exceeds cap", async () => {
  const { assertBudgetAllows } = await import("../src/model-gateway/usage-store");
  await assert.rejects(() => assertBudgetAllows(100, 100, {
    NODE_ENV: "test",
    MODEL_GATEWAY_MONTHLY_BUDGET_INR: "3000",
    MODEL_GATEWAY_INPUT_PRICE_INR_PER_1M: "0",
    MODEL_GATEWAY_OUTPUT_PRICE_INR_PER_1M: "0"
  }), /prices are configured/);
  await assert.rejects(() => assertBudgetAllows(100_000, 100_000, {
    NODE_ENV: "test",
    MODEL_GATEWAY_MONTHLY_BUDGET_INR: "1",
    MODEL_GATEWAY_INPUT_PRICE_INR_PER_1M: "1000",
    MODEL_GATEWAY_OUTPUT_PRICE_INR_PER_1M: "1000"
  }), /budget would be exceeded/);
});

test("usage ledger records token-level counts and computes monthly budget totals", async () => {
  const { recordModelUsage, getBudgetSnapshot } = await import("../src/model-gateway/usage-store");
  await recordModelUsage({
    id: "usage-test-1", at: new Date().toISOString(), requestId: "req-test",
    provider: "groq", model: "openai/gpt-oss-20b", tier: "free-tier",
    promptTokens: 12, completionTokens: 8, totalTokens: 20, estimatedCostInr: 0,
    latencyMs: 145, status: "success"
  });
  const snapshot = await getBudgetSnapshot();
  assert.ok(snapshot.records.some(record => record.requestId === "req-test" && record.totalTokens === 20));
  assert.equal(snapshot.currency, "INR");
});


test("direct provider billing tier is explicit and paid providers stay unavailable until paid routing is enabled", async () => {
  const { providersFromEnv, getModelCatalog } = await import("../src/model-gateway");
  const base = { GEMINI_API_KEY: "test-key", GEMINI_MODELS: "gemini-3.1-flash-lite", MODEL_GATEWAY_MONTHLY_BUDGET_INR: "3000" };
  const paidLocked = providersFromEnv({ ...base, GEMINI_BILLING_MODE: "paid", ALLOW_PAID_MODELS: "false" });
  assert.equal(paidLocked.some(provider => provider.name === "gemini"), false);
  const paidEnabled = providersFromEnv({ ...base, GEMINI_BILLING_MODE: "paid", ALLOW_PAID_MODELS: "true" });
  const paidProvider = paidEnabled.find(provider => provider.name === "gemini");
  assert.equal(paidProvider?.kind, "paid");
  assert.equal(getModelCatalog(paidEnabled).find(model => model.provider === "gemini" && model.id === "gemini-3.1-flash-lite")?.tier, "paid");
  const free = providersFromEnv({ ...base, GEMINI_BILLING_MODE: "free-tier", ALLOW_PAID_MODELS: "false" });
  assert.equal(free.find(provider => provider.name === "gemini")?.kind, "free-tier");
});

test("validates multimodal screenshot content before sending it to a model", () => {
  assert.equal(isValidChatContent("Review this screenshot."), true);
  assert.equal(isValidChatContent([
    { type: "text", text: "Audit this screen." },
    { type: "image_url", image_url: { url: "https://images.example.com/screen.png", detail: "high" } }
  ]), true);
  assert.equal(isValidChatContent([
    { type: "image_url", image_url: { url: "http://images.example.com/screen.png" } }
  ]), false);
  assert.equal(isValidChatContent([
    { type: "image_url", image_url: { url: "https://127.0.0.1/screen.png" } }
  ]), false);
  assert.equal(isValidChatContent([
    { type: "image_url", image_url: { url: "https://service.internal/screen.png" } }
  ]), false);
  assert.equal(isValidChatContent([
    { type: "image_url", image_url: { url: "https://192.168.1.10/screen.png" } }
  ]), false);
  assert.equal(isValidChatContent([
    { type: "image_url", image_url: { url: "https://[::1]/screen.png" } }
  ]), false);
});

test("paid-request estimates include conservative cost allowance for screenshots", () => {
  assert.equal(estimateChatContentChars([
    { type: "text", text: "audit" },
    { type: "image_url", image_url: { url: "https://images.example.com/screen.png" } }
  ]), 32_005);
});
