import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS, configuredProviders, freeModelsFromListing, modelTier, modelSupportsVision } from "../src/llm-gateway/catalog";
import { cooldownFor, estimatePromptTokens, providerBody, rankCandidates, resolveRole } from "../src/llm-gateway/router";
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
  assert.equal(resolveRole(new Headers({ "X-UXD-Agent-Role": "planner" }), {}), "planner");
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
    providers, role: "planner", promptTokens: 20_000, vision: false, now, random: fixedRandom,
    usage: new Map([["gemini/gemini-2.5-flash", { provider: "gemini", model: "gemini-2.5-flash", lastMinute: 9, today: 10, tokensToday: 0, calls24h: 10, ok24h: 10, avgLatencyMs: 2000 }]]),
    cooldowns: new Map([["cerebras/qwen-3-235b-a22b-instruct-2507", now + 10_000]]),
    localHits: new Map(),
  });
  // Groq's free TPM cannot take a 20k prompt, Gemini is at its RPM, the Qwen row is cooling down.
  assert.deepEqual(ranked.map((candidate) => candidate.provider.id + "/" + candidate.model), ["cerebras/gpt-oss-120b"]);

  const spread = rankCandidates({
    providers, role: "planner", promptTokens: 1_000, vision: false, now, random: fixedRandom,
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
  const vision = rankCandidates({ providers, role: "critic", promptTokens: 500, vision: true, usage: new Map(), cooldowns: new Map(), localHits: new Map(), random: fixedRandom });
  assert.deepEqual(vision.map((candidate) => candidate.model), ["gemini-2.5-flash"]);
});

test("cooldowns follow Retry-After, daily quota, bad keys and dead models", () => {
  const now = Date.UTC(2026, 10, 7, 15, 0, 0);
  assert.equal(cooldownFor(429, "Rate limit reached", "12", now), now + 12_000);
  assert.equal(cooldownFor(429, "You exceeded your requests per day quota", null, now), Date.UTC(2026, 10, 8));
  assert.equal(cooldownFor(401, "invalid key", null, now), now + 3600_000);
  assert.equal(cooldownFor(404, "model not found", null, now), now + 6 * 3600_000);
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
