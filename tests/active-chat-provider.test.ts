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
    UX_DIRECT_CHAT_PROVIDER: "freellmapi",
    FREELLMAPI_BASE_URL: "https://freellmapi.example.com/v1/",
    FREELLMAPI_API_KEY: "freellmapi-unified-test-key",
    FREELLMAPI_CHAT_MODEL: "auto",
    OPENROUTER_API_KEY: "openrouter-test-key",
  });

  assert.equal(provider.id, "freellmapi");
  assert.equal(provider.baseUrl, "https://freellmapi.example.com/v1");
  assert.equal(provider.model, "auto");
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
