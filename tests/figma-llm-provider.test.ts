import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFigmaLlmTarget, getOpenRouterAllowList, isFigmaProviderConfigured, parseFigmaProvider,
  resetOpenRouterAllowListCache, selectFigmaProvider, selectOpenRouterVisionModels,
} from "../src/providers/figma-llm";

const model = (id: string, over: Record<string, unknown> = {}) => ({
  id, context_length: 200000,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000005", completion: "0.000002" },
  supported_parameters: ["structured_outputs", "temperature"],
  ...over,
});

test("parses only the two supported providers", () => {
  assert.equal(parseFigmaProvider(" FreeLLMAPI "), "freellmapi");
  assert.equal(parseFigmaProvider("openrouter"), "openrouter");
  assert.equal(parseFigmaProvider("openai"), null);
  assert.equal(parseFigmaProvider(undefined), null);
});

test("provider configuration needs the right env", () => {
  assert.equal(isFigmaProviderConfigured("openrouter", { OPENROUTER_API_KEY: "k" }), true);
  assert.equal(isFigmaProviderConfigured("openrouter", {}), false);
  assert.equal(isFigmaProviderConfigured("freellmapi", { FREELLMAPI_API_KEY: "k" }), false);
  assert.equal(isFigmaProviderConfigured("freellmapi", { FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "https://h/v1" }), true);
});

test("an explicit request wins, then env, then OpenRouter", async () => {
  assert.equal(await selectFigmaProvider("freellmapi", {}), "freellmapi");
  assert.equal(await selectFigmaProvider(undefined, { FIGMA_AGENT_PROVIDER: "freellmapi" }), "freellmapi");
  assert.equal(await selectFigmaProvider("bogus", {}), "openrouter");
});

test("OpenRouter allow-list keeps low-cost multimodal structured-output models only", () => {
  const ids = selectOpenRouterVisionModels([
    model("good/a", { pricing: { prompt: "0.0000005", completion: "0.000004" } }),
    model("good/b", { pricing: { prompt: "0.0000002", completion: "0.000001" } }),
    model("text/only", { architecture: { input_modalities: ["text"], output_modalities: ["text"] } }),
    model("pricey/c", { pricing: { prompt: "0.000005", completion: "0.00002" } }),
    model("free/d:free", { pricing: { prompt: "0", completion: "0" } }),
    model("tiny/e", { context_length: 8000 }),
    model("noparams/f", { supported_parameters: ["temperature"] }),
    model("openrouter/auto"),
    { id: 42 }, null,
  ]);
  assert.deepEqual(ids, ["good/a", "good/b"]);
  assert.deepEqual(selectOpenRouterVisionModels("nope"), []);
});

test("allow-list is fetched once, cached, and degrades to empty on failure", async () => {
  resetOpenRouterAllowListCache();
  let calls = 0;
  const ok = async () => { calls += 1; return new Response(JSON.stringify({ data: [model("good/a")] }), { status: 200 }); };
  assert.deepEqual(await getOpenRouterAllowList({}, ok, 1000), ["good/a"]);
  assert.deepEqual(await getOpenRouterAllowList({}, ok, 2000), ["good/a"]);
  assert.equal(calls, 1);
  resetOpenRouterAllowListCache();
  assert.deepEqual(await getOpenRouterAllowList({}, async () => { throw new Error("down"); }, 3000), []);
});

test("targets: OpenRouter uses auto with low cost + allow-list, FreeLLMAPI uses auto", () => {
  const or = buildFigmaLlmTarget("openrouter", "https://app", { OPENROUTER_API_KEY: "k" })!;
  assert.deepEqual(or.models, ["openrouter/auto"]);
  assert.equal(or.endpoint, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(or.bodyExtras(["good/a"]), { plugins: [{ id: "auto-router", cost_tier: "low", allowed_models: ["good/a"] }] });
  assert.deepEqual(or.bodyExtras([]), { plugins: [{ id: "auto-router", cost_tier: "low" }] });
  const free = buildFigmaLlmTarget("freellmapi", "https://app", { FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "https://h/v1/" })!;
  assert.deepEqual(free.models, ["auto"]);
  assert.equal(free.endpoint, "https://h/v1/chat/completions");
  assert.deepEqual(free.bodyExtras([]), {});
  assert.equal(buildFigmaLlmTarget("freellmapi", "https://app", {}), null);
});
