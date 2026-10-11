import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionWithFreeFallback,
  getFreeChatModelOptions,
  providersForFreeChat,
  providersFromEnv,
  type ProviderConfig
} from "../src/model-gateway";

const providers: ProviderConfig[] = [
  {
    name: "openrouter",
    baseUrl: "https://openrouter.example/api/v1",
    apiKey: "test-key",
    models: ["provider/static-list:free"],
    kind: "free-tier"
  }
];

test("free model options combine provider IDs with live-discovered :free IDs", () => {
  const options = getFreeChatModelOptions(providers, ["live/discovered-model:free", "gpt-4o"]);
  assert.deepEqual(options.map(option => option.id), ["provider/static-list:free", "live/discovered-model:free"]);
  assert.equal(options.every(option => option.provider === "openrouter" && option.tier === "free-tier"), true);
});

test("OpenRouter provider does not require an OPENROUTER_MODELS environment variable", () => {
  const configured = providersFromEnv({ OPENROUTER_API_KEY: "test-key" })
    .find(provider => provider.name === "openrouter");
  assert.deepEqual(configured?.models, []);
  assert.equal(configured?.apiKey, "test-key");
});

test("selected live OpenRouter :free model is allowed without adding paid IDs", () => {
  const extended = providersForFreeChat(providers, "live/discovered-model:free");
  const openrouter = extended.find(provider => provider.name === "openrouter");
  assert.equal(openrouter?.models.includes("live/discovered-model:free"), true);
  assert.equal(openrouter?.models.includes("gpt-4o"), false);
});

test("chat uses exactly one selected OpenRouter free model and returns its response", async () => {
  const attempts: Array<{ url: string; model: string }> = [];
  const result = await chatCompletionWithFreeFallback({
    model: "live/discovered-model:free",
    providerId: "openrouter",
    messages: [{ role: "user", content: "Say hello." }],
    max_tokens: 12
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempts.push({ url: String(input), model: body.model });
      return new Response(JSON.stringify({
        id: "openrouter-free-test",
        model: body.model,
        choices: [{ message: { content: "Hello from the selected free model." } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "live/discovered-model:free");
  assert.match(result.content, /selected free model/);
  assert.deepEqual(attempts.map(item => item.model), ["live/discovered-model:free"]);
});
