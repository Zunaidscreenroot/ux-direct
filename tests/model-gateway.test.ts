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
