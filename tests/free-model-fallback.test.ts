import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionFreeFirstThenPaid,
  chatCompletionWithFreeFallback,
  getFreeChatModelOptions,
  providersForFreeChat,
  providersFromEnv,
  type ProviderConfig
} from "../src/model-gateway";

const LIGHTNING = "nvidia/nemotron-3.5-lightning:free";
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free";
const providers: ProviderConfig[] = [{
  name: "openrouter",
  baseUrl: "https://openrouter.example/api/v1",
  apiKey: "test-key",
  models: [],
  kind: "free-tier"
}];

test("free options are restricted to the two approved Nemotron IDs", () => {
  const options = getFreeChatModelOptions(providers, [LIGHTNING, ULTRA, "live/unapproved:free", "gpt-6-luna"]);
  assert.deepEqual(options.map(option => option.id), [LIGHTNING, ULTRA]);
  assert.equal(options.every(option => option.provider === "openrouter" && option.tier === "free-tier"), true);
});

test("OpenRouter provider starts with no static model list", () => {
  const configured = providersFromEnv({ OPENROUTER_API_KEY: "test-key" }).find(provider => provider.name === "openrouter");
  assert.deepEqual(configured?.models, []);
  assert.equal(configured?.apiKey, "test-key");
});

test("free request cannot expand the model allowlist to an unapproved ID", async () => {
  const extended = providersForFreeChat(providers, "live/unapproved:free");
  assert.deepEqual(extended.find(provider => provider.name === "openrouter")?.models, []);
  await assert.rejects(() => chatCompletionWithFreeFallback({
    model: "live/unapproved:free",
    providerId: "openrouter",
    messages: [{ role: "user", content: "Say hello." }]
  }, { providers }), /two approved OpenRouter free models/);
});

test("free-first returns the first healthy free model without making a paid call", async () => {
  const attempts: string[] = [];
  const result = await chatCompletionFreeFirstThenPaid({
    model: LIGHTNING,
    providerId: "openrouter",
    messages: [{ role: "user", content: "Say hello." }],
    max_tokens: 24
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempts.push(body.model);
      return new Response(JSON.stringify({
        id: "openrouter-free-test",
        model: body.model,
        choices: [{ message: { content: "Hello from the free model." } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, LIGHTNING);
  assert.equal(result.tier, "free-tier");
  assert.equal(result.routingStrategy, "free-first");
  assert.deepEqual(result.attemptedModels, [LIGHTNING]);
  assert.deepEqual(attempts, [LIGHTNING]);
});

test("paid fallback runs only after both free IDs fail and is assigned by task expertise", async () => {
  const attempts: string[] = [];
  const result = await chatCompletionFreeFirstThenPaid({
    model: LIGHTNING,
    providerId: "openrouter",
    messages: [{ role: "user", content: "Debug this TypeScript API route and fix the build error." }],
    max_tokens: 32
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempts.push(body.model);
      if (body.model.endsWith(":free")) {
        return new Response(JSON.stringify({ error: { message: "Model temporarily unavailable" } }), {
          status: 503, headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        id: "openrouter-paid-test",
        model: body.model,
        choices: [{ message: { content: "PAID_CODE_OK" } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.tier, "paid");
  assert.equal(result.model, "deepseek/deepseek-v4-flash-0731");
  assert.equal(result.routingStrategy, "free-first");
  assert.deepEqual(attempts, [LIGHTNING, ULTRA, "deepseek/deepseek-v4-flash-0731"]);
  assert.deepEqual(result.attemptedModels, attempts);
  assert.match(result.fallbackReason ?? "", /approved free models were unavailable/i);
});


test("an explicitly chosen paid fallback is used only after both free models fail", async () => {
  const attempts: string[] = [];
  const selectedPaid = "openai/gpt-6-luna";
  const result = await chatCompletionFreeFirstThenPaid({
    model: LIGHTNING,
    providerId: "openrouter",
    preferredPaidModelId: selectedPaid,
    messages: [{ role: "user", content: "Draft concise UX copy." }],
    max_tokens: 32
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempts.push(body.model);
      if (body.model.endsWith(":free")) {
        return new Response(JSON.stringify({ error: { message: "Free model unavailable" } }), {
          status: 503, headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        id: "openrouter-selected-paid-test",
        model: body.model,
        choices: [{ message: { content: "Selected fallback response." } }],
        usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.model, selectedPaid);
  assert.equal(result.tier, "paid");
  assert.deepEqual(attempts, [LIGHTNING, ULTRA, selectedPaid]);
});

test("visual requests skip text-only free models and attach the selected-frame image to one paid vision call", async () => {
  const attempts: string[] = [];
  const imageDataUrl = "data:image/jpeg;base64,AAAA";
  const result = await chatCompletionFreeFirstThenPaid({
    model: LIGHTNING,
    providerId: "openrouter",
    imageDataUrl,
    messages: [{ role: "user", content: "Visually inspect this selected frame." }],
    max_tokens: 32
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string | Array<{ type: string; image_url?: { url: string }; text?: string }> }>;
      };
      attempts.push(body.model);
      assert.equal(body.model, "deepseek/deepseek-v4.1-flash");
      const userMessage = body.messages.find(message => message.role === "user");
      assert.ok(userMessage);
      assert.ok(Array.isArray(userMessage.content));
      const imagePart = userMessage.content.find(part => typeof part === "object" && part.type === "image_url");
      assert.equal(imagePart?.image_url?.url, imageDataUrl);
      return new Response(JSON.stringify({
        id: "openrouter-vision-test",
        model: body.model,
        choices: [{ message: { content: "The frame has a visible hierarchy issue." } }],
        usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.tier, "paid");
  assert.equal(result.routingStrategy, "vision-direct");
  assert.deepEqual(attempts, ["deepseek/deepseek-v4.1-flash"]);
});
