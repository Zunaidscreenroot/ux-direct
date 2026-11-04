import test from "node:test";
import assert from "node:assert/strict";
import { getProviderSwitcherState, getResolvedActiveChatProvider, isSupportedRuntimeChatProvider } from "../src/providers/runtime-chat-provider";

test("OpenRouter is inactive: not offered, not switchable, and never resolved as the active provider", async () => {
  const previous = { ...process.env };
  process.env.UX_DIRECT_MODEL_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.FREELLMAPI_BASE_URL = "https://freellmapi.example.com/v1";
  process.env.FREELLMAPI_API_KEY = "freellmapi-test-key";
  try {
    assert.equal(isSupportedRuntimeChatProvider("openrouter"), false);
    assert.equal(isSupportedRuntimeChatProvider("freellmapi"), true);
    const active = await getResolvedActiveChatProvider();
    assert.equal(active.id, "freellmapi");
    const state = await getProviderSwitcherState();
    assert.equal(state.activeProvider, "freellmapi");
    assert.deepEqual(state.providers.map((provider) => provider.id), ["freellmapi"]);
  } finally {
    process.env = previous;
  }
});
