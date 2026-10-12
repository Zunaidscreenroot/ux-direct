import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionWithOpenRouterPaid,
  providersForOpenRouterPaidChat,
  type ProviderConfig
} from "../src/model-gateway";

const providers: ProviderConfig[] = [{
  name: "openrouter",
  baseUrl: "https://openrouter.example/api/v1",
  apiKey: "test-key",
  models: [],
  kind: "free-tier"
}];

test("paid OpenRouter helper only admits its explicit low-cost allowlist", () => {
  const selected = providersForOpenRouterPaidChat("openai/gpt-oss-20b", providers);
  const openrouter = selected.find(provider => provider.name === "openrouter");
  assert.equal(openrouter?.kind, "paid");
  assert.deepEqual(openrouter?.models, ["openai/gpt-oss-20b"]);
  assert.throws(
    () => providersForOpenRouterPaidChat("openai/gpt-4o", providers),
    /approved low-cost allowlist/
  );
});

test("selected paid OpenRouter chat makes one request and is covered by budget checks", async () => {
  const attempts: Array<{ url: string; model: string; max_tokens: number; reasoning?: { effort?: string } }> = [];
  const result = await chatCompletionWithOpenRouterPaid({
    model: "openai/gpt-oss-20b",
    providerId: "openrouter",
    messages: [{ role: "user", content: "Reply with exactly: PAID_OPENROUTER_OK" }],
    max_tokens: 32,
    reasoning: { effort: "minimal" }
  }, {
    providers,
    timeoutMs: 2000,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number; reasoning?: { effort?: string } };
      attempts.push({ url: String(input), model: body.model, max_tokens: body.max_tokens, reasoning: body.reasoning });
      return new Response(JSON.stringify({
        id: "openrouter-paid-test",
        model: body.model,
        choices: [{ message: { content: "PAID_OPENROUTER_OK" } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch
  });

  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "openai/gpt-oss-20b");
  assert.equal(result.content, "PAID_OPENROUTER_OK");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].model, "openai/gpt-oss-20b");
  assert.equal(attempts[0].max_tokens, 32);
  assert.deepEqual(attempts[0].reasoning, { effort: "minimal" });
});
