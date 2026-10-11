import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionWithFreeFallback,
  getFreeChatModelOptions,
  providersForFreeChat,
  type ProviderConfig
} from "../src/model-gateway";

const providers: ProviderConfig[] = [
  {
    name: "gemini",
    baseUrl: "https://gemini.example/v1",
    apiKey: "test-key",
    models: ["gemini-3.5-flash-lite"],
    kind: "free-tier"
  },
  {
    name: "openrouter",
    baseUrl: "https://openrouter.example/api/v1",
    apiKey: "test-key",
    models: ["google/gemma-4-31b-it:free"],
    kind: "free-tier"
  }
];

test("free model selector contains two Gemini and three OpenRouter free options", () => {
  const options = getFreeChatModelOptions(providers);
  assert.equal(options.filter(option => option.provider === "gemini").length, 2);
  assert.equal(options.filter(option => option.provider === "openrouter").length, 3);
  assert.equal(options.every(option => option.tier === "free-tier"), true);
});

test("interactive allowlist extends only to the curated Gemini/OpenRouter free IDs", () => {
  const extended = providersForFreeChat(providers);
  const gemini = extended.find(provider => provider.name === "gemini");
  const openrouter = extended.find(provider => provider.name === "openrouter");
  assert.equal(gemini?.models.includes("gemini-3.1-flash-lite"), true);
  assert.equal(openrouter?.models.includes("nvidia/nemotron-3-ultra-550b-a55b:free"), true);
  assert.equal(openrouter?.models.includes("gpt-4o"), false);
});

test("Gemini rate limits fall back to another Gemini model and then an OpenRouter free model", async () => {
  const attempts: Array<{ url: string; model: string }> = [];
  const result = await chatCompletionWithFreeFallback({
    model: "gemini-3.5-flash-lite",
    providerId: "gemini",
    messages: [{ role: "user", content: "Say hello." }],
    max_tokens: 12
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempts.push({ url: String(input), model: body.model });
      if (body.model.startsWith("gemini-")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({
        id: "free-fallback-test",
        model: body.model,
        choices: [{ message: { content: "Hello from the free fallback." } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.match(result.content, /free fallback/);
  assert.deepEqual(attempts.map(item => item.model), [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "nvidia/nemotron-3-ultra-550b-a55b:free"
  ]);
});
