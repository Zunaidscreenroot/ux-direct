import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionWithOpenRouterPaid,
  providersForOpenRouterPaidChat,
  type ProviderConfig
} from "../src/model-gateway";
import {
  OPENROUTER_PAID_CHAT_MODELS,
  getOpenRouterPaidChatModel,
  selectOpenRouterPaidChatModel
} from "../src/model-gateway/openrouter-paid";

const providers: ProviderConfig[] = [{
  name: "openrouter",
  baseUrl: "https://openrouter.example/api/v1",
  apiKey: "test-key",
  models: [],
  kind: "free-tier"
}];

test("paid OpenRouter helper allows only the three user-approved paid models", () => {
  const ids = OPENROUTER_PAID_CHAT_MODELS.map(model => model.id);
  assert.deepEqual(ids, [
    "deepseek/deepseek-v4.1-flash",
    "openai/gpt-6-luna",
    "deepseek/deepseek-v4-flash-0731"
  ]);
  for (const id of ids) {
    const selected = providersForOpenRouterPaidChat(id, providers);
    const openrouter = selected.find(provider => provider.name === "openrouter");
    assert.equal(openrouter?.kind, "paid");
    assert.deepEqual(openrouter?.models, [id]);
    assert.equal(getOpenRouterPaidChatModel(id)?.id, id);
  }
  assert.throws(
    () => providersForOpenRouterPaidChat("openai/gpt-oss-20b", providers),
    /approved low-cost allowlist/
  );
  assert.throws(
    () => providersForOpenRouterPaidChat("openai/gpt-4o", providers),
    /approved low-cost allowlist/
  );
});

test("paid expertise selector chooses the coding model for implementation tasks", () => {
  const model = selectOpenRouterPaidChatModel([
    { role: "user", content: "Debug this TypeScript API route and inspect the Next.js build error." }
  ]);
  assert.equal(model.id, "deepseek/deepseek-v4-flash-0731");
});

test("paid expertise selector chooses strategy model for UX research and critique", () => {
  const model = selectOpenRouterPaidChatModel([
    { role: "user", content: "Audit the user journey and critique the information architecture." }
  ]);
  assert.equal(model.id, "deepseek/deepseek-v4.1-flash");
});

test("paid expertise selector uses GPT-6 Luna for general UX conversation", () => {
  const model = selectOpenRouterPaidChatModel([
    { role: "user", content: "Help me rewrite this short stakeholder update." }
  ]);
  assert.equal(model.id, "openai/gpt-6-luna");
});

test("selected paid OpenRouter chat sends one approved model request without an app budget cap", async () => {
  const chosenModel = "deepseek/deepseek-v4.1-flash";
  const attempts: Array<{ url: string; model: string; max_tokens: number; reasoning?: { effort?: string } }> = [];
  const result = await chatCompletionWithOpenRouterPaid({
    model: chosenModel,
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
  assert.equal(result.model, chosenModel);
  assert.equal(result.content, "PAID_OPENROUTER_OK");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].model, chosenModel);
  assert.equal(attempts[0].max_tokens, 32);
  assert.deepEqual(attempts[0].reasoning, { effort: "minimal" });
});
