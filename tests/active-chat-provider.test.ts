import test from "node:test";
import assert from "node:assert/strict";
import { getActiveChatProvider } from "../src/providers/active-chat-provider";

test("defaults to OpenRouter and does not require FreeLLMAPI configuration", () => {
  const provider = getActiveChatProvider({
    NODE_ENV: "test",
    OPENROUTER_API_KEY: "openrouter-test-key",
  });

  assert.equal(provider.id, "openrouter");
  assert.equal(provider.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(provider.model, "openrouter/auto");
  assert.equal(provider.configured, true);
  assert.equal(provider.apiKey, "openrouter-test-key");
});

test("selects FreeLLMAPI with the configured server URL, unified key and model", () => {
  const provider = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_MODEL_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1/",
    FREELLMAPI_API_KEY: "freellmapi-unified-test-key",
    FREELLMAPI_CHAT_MODEL: "auto:smart",
    FREELLMAPI_VISION_MODEL: "auto:vision",
    OPENROUTER_API_KEY: "openrouter-test-key",
  });

  assert.equal(provider.id, "freellmapi");
  assert.equal(provider.baseUrl, "https://freellmapi.example.com/v1");
  assert.equal(provider.model, "auto:smart");
  assert.equal(provider.visionModel, "auto:vision");
  assert.equal(provider.configured, true);
  assert.equal(provider.apiKey, "freellmapi-unified-test-key");
});

test("reports a specific error when the FreeLLMAPI key is missing", () => {
  const provider = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_CHAT_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1",
  });

  assert.equal(provider.configured, false);
  assert.match(provider.configurationError || "", /FREELLMAPI_API_KEY is missing/);
});

test("rejects a FreeLLMAPI base URL that omits the /v1 path", () => {
  const provider = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_CHAT_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "https://freellmapi.example.com",
    FREELLMAPI_API_KEY: "test-key",
  });

  assert.equal(provider.configured, false);
  assert.match(provider.configurationError || "", /must include the \/v1 path/);
});

test("rejects insecure and localhost FreeLLMAPI URLs in production", () => {
  const insecure = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_CHAT_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "http://freellmapi.example.com/v1",
    FREELLMAPI_API_KEY: "test-key",
  });
  assert.equal(insecure.configured, false);
  assert.match(insecure.configurationError || "", /must use HTTPS in production/);

  const local = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_CHAT_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "https://localhost:3001/v1",
    FREELLMAPI_API_KEY: "test-key",
  });
  assert.equal(local.configured, false);
  assert.match(local.configurationError || "", /cannot reach FreeLLMAPI on your local machine/);
});

test("rejects unknown provider names instead of silently selecting another provider", () => {
  const provider = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_CHAT_PROVIDER: "freellmapii",
    FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1",
    FREELLMAPI_API_KEY: "test-key",
  });

  assert.equal(provider.id, "invalid");
  assert.equal(provider.configured, false);
  assert.match(provider.configurationError || "", /must be either openrouter or freellmapi/);
});

test("FreeLLMAPI Figma routes get an ordered fallback chain defaulting to the auto aliases", async () => {
  const { figmaModelChain } = await import("../src/providers/active-chat-provider");
  const base = { NODE_ENV: "production", UX_DIRECT_MODEL_PROVIDER: "freellmapi", FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1", FREELLMAPI_API_KEY: "k" };
  const defaults = getActiveChatProvider(base);
  assert.deepEqual(figmaModelChain(defaults, false, ["x"]), ["auto"]);
  assert.deepEqual(figmaModelChain(defaults, true, ["x"]), ["auto"]);

  const pinned = getActiveChatProvider({ ...base,
    FREELLMAPI_FIGMA_MODELS: " groq/openai/gpt-oss-120b, auto:smart,,auto:smart ",
    FREELLMAPI_FIGMA_VISION_MODELS: "gemini/gemini-2.5-flash,auto:vision" });
  assert.deepEqual(figmaModelChain(pinned, false, ["x"]), ["groq/openai/gpt-oss-120b", "auto:smart"]);
  assert.deepEqual(figmaModelChain(pinned, true, ["x"]), ["gemini/gemini-2.5-flash", "auto:vision"]);
});

test("OpenRouter keeps its explicit Figma chain", async () => {
  const { figmaModelChain } = await import("../src/providers/active-chat-provider");
  const provider = getActiveChatProvider({ NODE_ENV: "test", OPENROUTER_API_KEY: "k" });
  assert.deepEqual(figmaModelChain(provider, true, ["openai/gpt-6-luna", "openrouter/auto"]), ["openai/gpt-6-luna", "openrouter/auto"]);
});

test("FreeLLMAPI gets a cold-start first attempt and retries 4xx without JSON mode", async () => {
  const { figmaAttemptTimeoutMs, shouldRetryWithoutJsonMode } = await import("../src/providers/active-chat-provider");
  const free = getActiveChatProvider({ NODE_ENV: "production", UX_DIRECT_MODEL_PROVIDER: "freellmapi", FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1", FREELLMAPI_API_KEY: "k" });
  const openrouter = getActiveChatProvider({ NODE_ENV: "test", OPENROUTER_API_KEY: "k" });
  assert.equal(figmaAttemptTimeoutMs(free, 0, 60000, 45000), 90000);
  assert.equal(figmaAttemptTimeoutMs(free, 1, 60000, 45000), 45000);
  assert.equal(figmaAttemptTimeoutMs(openrouter, 0, 60000, 45000), 60000);
  assert.equal(shouldRetryWithoutJsonMode(free, 400), true);
  assert.equal(shouldRetryWithoutJsonMode(free, 422), true);
  assert.equal(shouldRetryWithoutJsonMode(free, 401), false);
  assert.equal(shouldRetryWithoutJsonMode(openrouter, 400), false);
});

test("FREELLMAPI_TUNNEL_URL secret overrides the static FreeLLMAPI base URL", () => {
  const provider = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_MODEL_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "https://old-host.example.com/v1",
    FREELLMAPI_TUNNEL_URL: "https://toxic-example.trycloudflare.com/v1/",
    FREELLMAPI_API_KEY: "k",
  });
  assert.equal(provider.configured, true);
  assert.equal(provider.baseUrl, "https://toxic-example.trycloudflare.com/v1");
});

test("FreeLLMAPI Figma calls are uncapped, follow the user's routing, and bias only the compact retry to speed", async () => {
  const { figmaMaxTokens, figmaRoutingHeaders } = await import("../src/providers/active-chat-provider");
  const free = getActiveChatProvider({ NODE_ENV: "production", UX_DIRECT_MODEL_PROVIDER: "freellmapi", FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1", FREELLMAPI_API_KEY: "k" });
  const openrouter = getActiveChatProvider({ NODE_ENV: "test", OPENROUTER_API_KEY: "k" });
  assert.deepEqual(figmaMaxTokens(free, 9000), {});
  assert.deepEqual(figmaMaxTokens(openrouter, 9000), { max_tokens: 9000 });
  assert.deepEqual(figmaRoutingHeaders(free), {});
  assert.deepEqual(figmaRoutingHeaders(free, { fast: true }), { "X-FreeLLM-Task-Type": "chat" });
  assert.deepEqual(figmaRoutingHeaders(openrouter, { fast: true }), {});
  assert.deepEqual(figmaRoutingHeaders(openrouter), {});
  assert.deepEqual(figmaRoutingHeaders(free, { role: "planner" }), { "X-UXD-Agent-Role": "planner" });
});

test("FREELLMAPI_TRANSPORT=vpc routes FreeLLMAPI to the VPC base URL without public-URL checks", async () => {
  const { FREELLMAPI_VPC_BASE_URL } = await import("../src/providers/active-chat-provider");
  const provider = getActiveChatProvider({
    NODE_ENV: "production",
    UX_DIRECT_MODEL_PROVIDER: "freellmapi",
    FREELLMAPI_TRANSPORT: "vpc",
    FREELLMAPI_TUNNEL_URL: "https://stale.trycloudflare.com/v1",
    FREELLMAPI_API_KEY: "k",
  });
  assert.equal(provider.configured, true);
  assert.equal(provider.baseUrl, FREELLMAPI_VPC_BASE_URL);
});
