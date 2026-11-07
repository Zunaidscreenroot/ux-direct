import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS, configuredProviders, freeModelsFromListing, modelTier, modelSupportsVision } from "../src/llm-gateway/catalog";
import { cooldownFor, estimatePromptTokens, isAccountWideQuota, providerBody, rankCandidates, resolveRole } from "../src/llm-gateway/router";
import { freeLlmApiShouldFallBack } from "../src/providers/provider-fetch";
import { getActiveChatProvider, llmGatewayMode, UXD_GATEWAY_BASE_URL } from "../src/providers/active-chat-provider";

const byId = (id: string) => PROVIDERS.find((provider) => provider.id === id)!;
const fixedRandom = () => 0.5;

test("only providers with a key (or the AI binding) are configured; models can be overridden", () => {
  const providers = configuredProviders({ GROQ_API_KEY: "g1,g2", UXD_GW_GROQ_MODELS: "openai/gpt-oss-120b" }, true);
  assert.deepEqual(providers.map((provider) => provider.id), ["groq", "workers-ai"]);
  assert.deepEqual(providers[0].models, ["openai/gpt-oss-120b"]);
  assert.equal(providers[0].discover, false);
  assert.deepEqual(configuredProviders({ UXD_GW_WORKERS_AI: "off" }, true), []);
  assert.deepEqual(configuredProviders({ GROQ_API_KEY: "g", UXD_GW_DISABLED_PROVIDERS: "groq" }, false), []);
});

test("free model detection keeps only zero-price :free OpenRouter rows and chat models", () => {
  const openrouter = freeModelsFromListing(byId("openrouter"), { data: [
    { id: "deepseek/deepseek-chat-v3.1:free", pricing: { prompt: "0", completion: "0" } },
    { id: "deepseek/deepseek-chat-v3.1", pricing: { prompt: "0.0000002", completion: "0.0000008" } },
    { id: "fake/model:free", pricing: { prompt: "0.1", completion: "0" } },
  ] });
  assert.deepEqual(openrouter, ["deepseek/deepseek-chat-v3.1:free"]);
  const groq = freeModelsFromListing(byId("groq"), { data: [{ id: "openai/gpt-oss-120b" }, { id: "whisper-large-v3" }, { id: "meta-llama/llama-guard-4-12b" }] });
  assert.deepEqual(groq, ["openai/gpt-oss-120b"]);
  const gemini = freeModelsFromListing(byId("gemini"), { data: [{ id: "models/gemini-2.5-flash" }, { id: "models/text-embedding-004" }, { id: "models/gemini-embedding-001" }] });
  assert.deepEqual(gemini, ["gemini-2.5-flash"]);
});

test("tiers put strong reasoning models above fast ones", () => {
  assert.equal(modelTier("openai/gpt-oss-120b"), "strong");
  assert.equal(modelTier("gemini-2.5-flash"), "strong");
  assert.equal(modelTier("gemini-2.5-flash-lite"), "fast");
  assert.equal(modelTier("openai/gpt-oss-20b"), "fast");
  assert.equal(modelTier("glm-4.5-flash"), "fast");
  assert.equal(modelTier("z-ai/glm-4.5-air:free"), "medium");
  assert.ok(modelSupportsVision("gemini-2.5-flash"));
  assert.equal(modelSupportsVision("openai/gpt-oss-120b"), false);
});

test("roles come from the explicit header, FreeLLMAPI's chat bias or streaming", () => {
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "planner" }), {}), "lead");
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "critic" }), {}), "lead");
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "reviewer" }), {}), "lead");
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "Section-Designer" }), {}), "ux-designer");
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "director" }), {}), "director");
  assert.equal(resolveRole(new Headers({ "X-FreeLLM-Task-Type": "chat" }), {}), "fast-retry");
  assert.equal(resolveRole(new Headers(), { stream: true }), "chat");
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "nonsense" }), {}), "default");
});

test("ranking skips cooldowns, rate-limited and too-small models and spreads providers", () => {
  const providers = [
    { provider: byId("cerebras"), models: ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507"] },
    { provider: byId("groq"), models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
    { provider: byId("gemini"), models: ["gemini-2.5-flash"] },
  ];
  const now = 1_000_000;
  const ranked = rankCandidates({
    providers, role: "lead", promptTokens: 20_000, vision: false, now, random: fixedRandom,
    usage: new Map([["gemini/gemini-2.5-flash", { provider: "gemini", model: "gemini-2.5-flash", lastMinute: 9, today: 10, tokensToday: 0, calls24h: 10, ok24h: 10, avgLatencyMs: 2000 }]]),
    cooldowns: new Map([["cerebras/qwen-3-235b-a22b-instruct-2507", now + 10_000]]),
    localHits: new Map(),
  });
  // Groq's free TPM cannot take a 20k prompt, Gemini is at its RPM, the Qwen row is cooling down.
  assert.deepEqual(ranked.map((candidate) => candidate.provider.id + "/" + candidate.model), ["cerebras/gpt-oss-120b"]);

  const spread = rankCandidates({
    providers, role: "lead", promptTokens: 1_000, vision: false, now, random: fixedRandom,
    usage: new Map(), cooldowns: new Map(), localHits: new Map(),
  });
  for (let index = 1; index < spread.length - 1; index++) {
    assert.notEqual(spread[index].provider.id, spread[index - 1].provider.id, "consecutive hops use different providers");
  }
  assert.equal(spread[0].tier, "strong");
});

test("chat prefers fast models; vision keeps only vision models", () => {
  const providers = [
    { provider: byId("groq"), models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
    { provider: byId("gemini"), models: ["gemini-2.5-flash"] },
    { provider: byId("workers-ai"), models: ["@cf/meta/llama-4-scout-17b-16e-instruct"] },
  ];
  const chat = rankCandidates({ providers, role: "chat", promptTokens: 500, vision: false, usage: new Map(), cooldowns: new Map(), localHits: new Map(), random: fixedRandom });
  assert.equal(chat[0].tier, "fast");
  const vision = rankCandidates({ providers, role: "lead", promptTokens: 500, vision: true, usage: new Map(), cooldowns: new Map(), localHits: new Map(), random: fixedRandom });
  assert.deepEqual(vision.map((candidate) => candidate.model), ["gemini-2.5-flash"]);
});

test("cooldowns follow Retry-After, daily quota, bad keys and dead models", () => {
  const now = Date.UTC(2026, 10, 7, 15, 0, 0);
  assert.equal(cooldownFor(429, "Rate limit reached", "12", now), now + 12_000);
  assert.equal(cooldownFor(429, "You exceeded your requests per day quota", null, now), Date.UTC(2026, 10, 8));
  assert.equal(cooldownFor(401, "invalid key", null, now), now + 3600_000);
  assert.equal(cooldownFor(404, "model not found", null, now), now + 24 * 3600_000);
  assert.equal(cooldownFor(413, "Request too large", null, now), null);
  assert.equal(cooldownFor(503, "overloaded", null, now), now + 30_000);
  assert.equal(cooldownFor(400, "bad json schema", null, now), null);
});

test("provider body drops non-OpenAI fields, clamps max_tokens and can drop JSON mode", () => {
  const body = { model: "auto", messages: [{ role: "user", content: "hi" }], max_tokens: 25_000, plugins: [{}], reasoning: { effort: "low" }, response_format: { type: "json_object" }, stream: true };
  const github = providerBody(byId("github"), "openai/gpt-4.1", body, true);
  assert.equal(github.model, "openai/gpt-4.1");
  assert.equal(github.max_tokens, 4_000);
  assert.equal("plugins" in github, false);
  assert.equal("reasoning" in github, false);
  assert.deepEqual(github.response_format, { type: "json_object" });
  const groq = providerBody(byId("groq"), "openai/gpt-oss-120b", body, false);
  assert.equal("response_format" in groq, false);
  assert.deepEqual(groq.stream_options, { include_usage: true });
});

test("prompt size estimate counts text and images", () => {
  assert.equal(estimatePromptTokens({ messages: [{ role: "user", content: "x".repeat(3600) }] }), 1000);
  assert.equal(estimatePromptTokens({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:" } }] }] }), 1500);
});

test("gateway mode defaults to fallback and 'only' needs no FreeLLMAPI key or URL", () => {
  assert.equal(llmGatewayMode({}), "fallback");
  assert.equal(llmGatewayMode({ UXD_LLM_GATEWAY: "PRIMARY" }), "primary");
  const provider = getActiveChatProvider({ NODE_ENV: "production", UX_DIRECT_MODEL_PROVIDER: "freellmapi", UXD_LLM_GATEWAY: "only" });
  assert.equal(provider.configured, true);
  assert.equal(provider.baseUrl, UXD_GATEWAY_BASE_URL);
  assert.ok(provider.apiKey);
  assert.ok(freeLlmApiShouldFallBack(530));
  assert.ok(freeLlmApiShouldFallBack(429));
  assert.equal(freeLlmApiShouldFallBack(400), false);
});

test("tiers handle new model names by size and ultra/nano signals", async () => {
  const { modelSizeB } = await import("../src/llm-gateway/catalog");
  assert.equal(modelSizeB("qwen3-235b-a22b"), 235);
  assert.equal(modelSizeB("nvidia/nemotron-3-ultra-550b-a55b:free"), 550);
  assert.equal(modelTier("nvidia/nemotron-3-ultra-550b-a55b:free"), "strong");
  assert.equal(modelTier("nvidia/nemotron-3.5-super-vl:free"), "strong");
  assert.equal(modelTier("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"), "fast");
  assert.equal(modelTier("liquid/lfm-3-1.7b:free"), "fast");
  assert.equal(modelTier("google/gemma-4-31b-it:free"), "medium");
  assert.equal(modelTier("gemini-3.7-flash"), "strong");
  assert.equal(modelTier("openai/gpt-oss-20b"), "fast");
  assert.ok(modelSupportsVision("nvidia/nemotron-3.5-super-vl:free"));
});

test("detected free models replace stale defaults, strongest first", async () => {
  const { pickDetectedModels } = await import("../src/llm-gateway/router");
  const picked = pickDetectedModels(["gemini-3.5-flash", "gemini-2.0-flash"], ["gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview"]);
  assert.equal(picked[0], "gemini-3.5-flash");
  assert.ok(picked.includes("gemini-3.6-flash"));
  assert.ok(!picked.includes("gemini-2.0-flash"));
  assert.equal(picked[picked.length - 1], "gemini-2.5-flash-lite");
  assert.deepEqual(pickDetectedModels(["a"], []), ["a"]);
});

test("agency seats get their own primary models, rotated across providers, with deep fallbacks", async () => {
  const { ROLE_ROUTES, chainRank } = await import("../src/llm-gateway/roles");
  const ids = new Set(PROVIDERS.map((provider) => provider.id));
  for (const [seat, route] of Object.entries(ROLE_ROUTES)) {
    for (const entry of [...route.primary, ...route.fallback]) assert.ok(ids.has(entry.split("/")[0] as never), seat + ": " + entry);
    assert.ok(route.primary.length + route.fallback.length >= 6, seat + " has a deep chain");
  }
  const providers = [
    { provider: byId("groq"), models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
    { provider: byId("gemini"), models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash-lite"] },
    { provider: byId("workers-ai"), models: ["@cf/openai/gpt-oss-120b", "@cf/nvidia/nemotron-3-120b-a12b", "@cf/openai/gpt-oss-20b"] },
    { provider: byId("openrouter"), models: ["nvidia/nemotron-3-ultra-550b-a55b:free"] },
    { provider: byId("mistral"), models: ["mistral-code-latest", "ministral-14b-2512"] },
  ];
  const rank = (role: "ux-designer" | "lead" | "chat" | "director" | "product-designer", turn: number) => rankCandidates({
    providers, role, promptTokens: 1_000, vision: false, usage: new Map(), cooldowns: new Map(), localHits: new Map(), random: fixedRandom, turn,
  });
  const designerA = rank("ux-designer", 0);
  const designerB = rank("ux-designer", 1);
  assert.equal(designerA[0].provider.id + "/" + designerA[0].model, "groq/openai/gpt-oss-120b");
  assert.equal(designerB[0].provider.id, "workers-ai", "the next designer call starts on another provider");
  assert.ok(designerA.length >= 6);
  assert.equal(rank("lead", 0)[0].provider.id, "gemini", "the Lead reviews on a different quota than the designers");
  assert.ok(!["groq", "workers-ai"].includes(rank("director", 1)[0].provider.id));
  assert.match(rank("chat", 0)[0].model, /gpt-oss-20b/);
  assert.equal(rank("director", 0)[0].model, "gemini-3.1-pro-preview");
  const product = rank("product-designer", 0);
  assert.match(product[0].model, /gpt-oss-120b/);
  assert.ok(!["gemini", "openrouter"].includes(product[0].provider.id), "product designer starts off the Lead's providers");
  assert.ok(!["gemini", "openrouter"].includes(rank("product-designer", 1)[0].provider.id));
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "product-designer" }), {}), "product-designer");
  assert.equal(chainRank(ROLE_ROUTES.director, "zai", "glm-4.5-flash", 0) > chainRank(ROLE_ROUTES.director, "groq", "openai/gpt-oss-120b", 0), true);
});

test("OpenRouter's account-wide daily cap and free-tier-only models are respected", () => {
  const providers = [
    { provider: byId("openrouter"), models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free"] },
    { provider: byId("groq"), models: ["openai/gpt-oss-120b"] },
  ];
  const usage = new Map([
    ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", { provider: "openrouter", model: "x", lastMinute: 0, today: 600, tokensToday: 0, calls24h: 600, ok24h: 600, avgLatencyMs: 0 }],
    ["openrouter/google/gemma-4-31b-it:free", { provider: "openrouter", model: "y", lastMinute: 0, today: 300, tokensToday: 0, calls24h: 300, ok24h: 300, avgLatencyMs: 0 }],
  ]);
  const ranked = rankCandidates({ providers, role: "lead", promptTokens: 500, vision: false, usage, cooldowns: new Map(), localHits: new Map(), random: fixedRandom });
  assert.deepEqual(ranked.map((candidate) => candidate.provider.id), ["groq"]);
  const cooled = rankCandidates({ providers, role: "lead", promptTokens: 500, vision: false, usage: new Map(), cooldowns: new Map([["openrouter/*", Date.now() + 60_000]]), localHits: new Map(), random: fixedRandom });
  assert.deepEqual(cooled.map((candidate) => candidate.provider.id), ["groq"]);
  const now = Date.UTC(2026, 10, 7, 5, 0, 0);
  assert.equal(cooldownFor(403, "This model is not available in your subscription tier", null, now), now + 24 * 3600_000);
});

test("Workers AI answers are read from chat, legacy and Responses-API shapes", async () => {
  const { workersAiText } = await import("../src/llm-gateway/router");
  assert.equal(workersAiText({ choices: [{ message: { content: "a" } }] }), "a");
  assert.equal(workersAiText({ response: "b" }), "b");
  assert.equal(workersAiText({ output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "think" }] }, { type: "message", content: [{ type: "output_text", text: "c" }] }] }), "c");
});

test("OpenRouter paid models are never routed, even when pinned or listed in an override", async () => {
  const { isAllowedModel } = await import("../src/llm-gateway/catalog");
  assert.equal(isAllowedModel(byId("openrouter"), "openai/gpt-5"), false);
  assert.equal(isAllowedModel(byId("openrouter"), "nvidia/nemotron-3-ultra-550b-a55b:free"), true);
  const [openrouter] = configuredProviders({ OPENROUTER_API_KEY: "k", UXD_GW_OPENROUTER_MODELS: "openai/gpt-5,google/gemma-4-31b-it:free", UXD_GW_OPENROUTER_RPD: "50" }, false);
  assert.deepEqual(openrouter.models, ["google/gemma-4-31b-it:free"]);
  assert.equal(openrouter.accountRpd, 50);
  assert.equal(configuredProviders({ OPENROUTER_API_KEY: "k" }, false)[0].accountRpd, 1000);
  const ranked = rankCandidates({
    providers: [{ provider: byId("openrouter"), models: ["anthropic/claude-x", "google/gemma-4-31b-it:free"] }],
    role: "lead", promptTokens: 100, vision: false, usage: new Map(), cooldowns: new Map(), localHits: new Map(), random: fixedRandom,
    pinned: { provider: "openrouter", model: "anthropic/claude-x" },
  });
  assert.deepEqual(ranked, []);
});

test("budget view sums published daily limits only, shares OpenRouter's account cap and groups roles by seat", async () => {
  const { buildBudget } = await import("../src/command-center/models");
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const usageRow = (provider: string, model: string, today: number, tokensToday: number) => ({ provider, model, lastMinute: 0, today, tokensToday, calls24h: today, ok24h: today, avgLatencyMs: 0 });
  const budget = buildBudget({
    now,
    providers: [
      { id: "groq", label: "Groq", models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"] },
      { id: "openrouter", label: "OpenRouter", models: ["a:free", "b:free"] },
      { id: "mistral", label: "Mistral", models: ["mistral-code-latest"] },
    ],
    usage: [usageRow("groq", "openai/gpt-oss-120b", 100, 50_000), usageRow("openrouter", "a:free", 30, 9_000), usageRow("openrouter", "b:free", 20, 1_000), usageRow("mistral", "mistral-code-latest", 5, 2_000)],
    stats: {
      today: { calls: 155, tokens: 62_000 },
      last24h: { calls: 200, ok: 190, tokens: 80_000, promptTokens: 60_000, completionTokens: 20_000 },
      last3h: { calls: 30, tokens: 12_000 },
      hourly: [],
      roles: [
        { role: "section-designer", calls: 10, ok: 10, tokens: 10_000, promptTokens: 8_000, completionTokens: 2_000, topModel: "groq/x" },
        { role: "ux-designer", calls: 5, ok: 5, tokens: 5_000, promptTokens: 4_000, completionTokens: 1_000, topModel: "" },
        { role: "lead", calls: 10, ok: 9, tokens: 15_000, promptTokens: 12_000, completionTokens: 3_000, topModel: "gemini/y" },
      ],
    },
  });
  // Groq: 1000 + 1000 requests/day; OpenRouter: one shared 1000; Mistral: none published.
  assert.equal(budget.requests.limit, 3_000);
  assert.equal(budget.requests.used, 150);
  assert.equal(budget.requests.coveredModels, 4);
  assert.equal(budget.requests.totalModels, 5);
  // Only gpt-oss-120b publishes a token/day cap (200k); the new qwen id has none.
  assert.equal(budget.tokens.limit, 200_000);
  assert.equal(budget.tokens.remaining, 150_000);
  assert.equal(budget.tokens.usedToday, 62_000);
  assert.equal(budget.pace.tokensPerHour, 4_000);
  assert.equal(budget.pace.projected24hTokens, 96_000);
  assert.equal(budget.pace.hoursUntilRequestsOut, null, "2850 left at 10/h lasts past the reset");
  assert.deepEqual(budget.roles.map((row) => [row.seat, row.tokens]), [["ux-designer", 15_000], ["lead", 15_000]]);
  assert.equal(budget.roles[0].share, 50);
  assert.equal(budget.providers.find((provider) => provider.id === "mistral")!.models[0].rpd, undefined);
  assert.equal(budget.resetsAt, "2026-11-08T00:00:00.000Z");
});

test("account-wide daily caps skip the provider's other models; a per-model quota does not", () => {
  assert.equal(isAccountWideQuota("Rate limit exceeded: free-models-per-day. Add 5 credits to unlock 1000"), true);
  assert.equal(isAccountWideQuota("4006: you have used up your daily free allocation of 10,000 neurons"), true);
  // Gemini quotas are per model: flash-lite can still answer when flash is out.
  assert.equal(isAccountWideQuota("You exceeded your current quota, please check your plan"), false);
});
