import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { allowedLiveModel, anthropicLiveCompletion, classify, liveModelFor, toAnthropic } from "../src/llm-gateway/anthropic-live";
import { POST } from "../app/api/a11y/chat/route";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("each live seat is pinned to Haiku or Sonnet, and Opus or Fable can never be set", () => {
  assert.equal(liveModelFor("live-vision", {}), "claude-haiku-5-5");
  assert.equal(liveModelFor("live-review", {}), "claude-sonnet-5-5");
  assert.equal(liveModelFor("live-text", {}), "claude-haiku-5-5");
  assert.equal(liveModelFor("live-review", { UXD_LIVE_REVIEW_MODEL: "claude-opus-5-5" }), "claude-sonnet-5-5");
  assert.equal(liveModelFor("live-review", { UXD_LIVE_REVIEW_MODEL: "claude-fable-5-2" }), "claude-sonnet-5-5");
  assert.equal(allowedLiveModel("claude-haiku-4-5"), true);
});

test("OpenAI messages become Anthropic blocks with a cached system prompt", () => {
  const { system, messages } = toAnthropic([
    { role: "system", content: "rules" },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: PNG } }] },
  ]);
  assert.equal(system[0].text, "rules");
  assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
  const parts = messages[0].content as Anthropic.ContentBlockParam[];
  assert.equal(parts[1].type, "image");
});

test("errors say used up or busy", () => {
  const h = new Headers();
  assert.equal(classify(new Anthropic.RateLimitError(429, { error: { type: "rate_limit_error" } }, "slow", h)).code, "busy");
  assert.equal(classify(new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, undefined, h)).code, "used_up");
  assert.equal(classify(new Anthropic.AuthenticationError(401, {}, "bad key", h)).code, "used_up");
  assert.equal(classify(new Anthropic.InternalServerError(529, {}, "overloaded", h)).code, "busy");
});

test("no key is reported, not thrown as a crash", async () => {
  await assert.rejects(anthropicLiveCompletion({ seat: "live-text", messages: [{ role: "user", content: "hi" }], maxTokens: 100, env: {} }), (e: { code?: string }) => e.code === "no_key");
});

test("a live seat without Anthropic says used up and does not fall back by default", async () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await POST(new Request("https://uxdirect.test/api/a11y/chat", { method: "POST", headers: { origin: "https://accessaudit-sigma.vercel.app", "content-type": "application/json" },
      body: JSON.stringify({ seat: "live-vision", messages: [{ role: "user", content: "hello" }] }) }));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, "used_up");
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});

test("with the fallback switched on, a live seat goes to the gateway and says why", async () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  process.env.UXD_LIVE_FALLBACK = "on";
  try {
    const r = await POST(new Request("https://uxdirect.test/api/a11y/chat", { method: "POST", headers: { origin: "https://accessaudit-sigma.vercel.app", "content-type": "application/json" },
      body: JSON.stringify({ seat: "live-text", messages: [{ role: "user", content: "hello" }] }) }));
    assert.equal(r.headers.get("x-uxd-provider"), "gateway");
    if (!r.ok) assert.match(String((await r.json()).error.code), /busy|used_up/);
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; delete process.env.UXD_LIVE_FALLBACK; }
});

test("cost line is computed from usage", async () => {
  const { costUsd } = await import("../src/llm-gateway/anthropic-live");
  assert.equal(costUsd("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 0 }), 0.1);
  assert.equal(costUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 100_000 }), 1);
});
