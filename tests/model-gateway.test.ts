import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion, GatewayError, resolveProvider, type ProviderConfig } from "../src/model-gateway";

const providers: ProviderConfig[] = [
  { name: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key", models: ["gpt-test"] },
  { name: "local", baseUrl: "http://localhost:11434/v1", models: ["default"] }
];

test("routes only explicitly configured models", () => {
  assert.equal(resolveProvider("gpt-test", providers).name, "openai");
  assert.throws(() => resolveProvider("unknown-model", providers), (error: unknown) =>
    error instanceof GatewayError && error.status === 400);
});

test("normalizes a successful OpenAI-compatible response", async () => {
  let calledUrl = "";
  let calledBody: any;
  const result = await chatCompletion({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 12
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
  assert.equal(result.content, "hello back");
  assert.equal(result.provider, "openai");
  assert.equal(result.usage?.total_tokens, 5);
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
  const enabled = providersFromEnv({ NODE_ENV: "production", OPENAI_API_KEY: "test-only", ALLOW_PAID_MODELS: "true" });
  assert.equal(enabled.some(p => p.name === "openai" && p.models.includes("gpt-4o-mini")), true);
});


test("UX task aliases resolve to configured providers and safely fall back to mock", async () => {
  const providers = [{ name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" as const }];
  const result = await chatCompletion({
    model: "uxd/critique",
    messages: [{ role: "user", content: "Review this screen." }]
  }, { providers });
  assert.equal(result.model, "mock/ux-direct");
  assert.equal(result.provider, "mock");
});


test("OpenRouter only exposes explicitly free models until paid mode is enabled", async () => {
  const { providersFromEnv } = await import("../src/model-gateway");
  const locked = providersFromEnv({
    NODE_ENV: "production",
    OPENROUTER_API_KEY: "test-only",
    OPENROUTER_MODELS: "vendor/free-model:free,vendor/paid-model"
  });
  const router = locked.find(p => p.name === "openrouter");
  assert.deepEqual(router?.models, ["vendor/free-model:free"]);
  assert.equal(router?.kind, "free-tier");
  const paid = providersFromEnv({
    NODE_ENV: "production",
    OPENROUTER_API_KEY: "test-only",
    OPENROUTER_MODELS: "vendor/paid-model",
    ALLOW_PAID_MODELS: "true"
  });
  assert.equal(paid.find(p => p.name === "openrouter")?.kind, "paid");
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


test("task aliases fail over between free providers but never select paid providers", async () => {
  const { chatCompletionWithFallback } = await import("../src/model-gateway");
  const configured: ProviderConfig[] = [
    { name: "groq", baseUrl: "https://groq.example/v1", apiKey: "test", models: ["openai/gpt-oss-20b"], kind: "free-tier" },
    { name: "gemini", baseUrl: "https://gemini.example/v1", apiKey: "test", models: ["gemini-3.5-flash"], kind: "free-tier" },
    { name: "openai", baseUrl: "https://paid.example/v1", apiKey: "test", models: ["gpt-4o-mini"], kind: "paid" },
    { name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" }
  ];
  const attempted: string[] = [];
  const result = await chatCompletionWithFallback({
    model: "uxd/classify",
    messages: [{ role: "user", content: "Classify this design task." }]
  }, {
    providers: configured,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      attempted.push(url);
      if (url.includes("groq.example")) return new Response("rate limited", { status: 429 });
      if (url.includes("gemini.example")) return new Response(JSON.stringify({
        choices: [{ message: { content: "classification complete" } }]
      }), { status: 200 });
      throw new Error("Paid provider should never be attempted");
    }) as typeof fetch
  });
  assert.equal(result.provider, "gemini");
  assert.equal(attempted.some(url => url.includes("paid.example")), false);
});
