import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { GET, OPTIONS, POST } from "../app/api/a11y/chat/route";

const ORIGIN = "https://accessaudit-sigma.vercel.app";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function post(body: unknown, origin = ORIGIN) {
  return POST(new Request("https://uxdirect.test/api/a11y/chat", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

test("the door says it can take a screen", async () => {
  const r = await GET(new Request("https://uxdirect.test/api/a11y/chat", { headers: { origin: ORIGIN } }));
  const j = await r.json();
  assert.equal(j.vision, true);
  assert.equal(j.maxImages, 2);
});

test("preflight allows the Figma sandbox origin", async () => {
  const r = await OPTIONS(new Request("https://uxdirect.test/api/a11y/chat", { method: "OPTIONS", headers: { origin: "null" } }));
  assert.equal(r.status, 204);
});

test("another origin is refused", async () => {
  const r = await post({ messages: [{ role: "user", content: "hello" }] }, "https://evil.example");
  assert.equal(r.status, 403);
});

test("an image is only allowed as a data URL", async () => {
  const r = await post({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/screen.png" } }] }] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /data URL/i);
});

test("an image may not ride on a system message", async () => {
  const r = await post({ messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: PNG } }] }] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /user message/i);
});

test("an oversized screen is refused", async () => {
  const r = await post({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(1_700_000) } }] }] });
  assert.equal(r.status, 413);
});

test("more than two screens are refused", async () => {
  const r = await post({ messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: PNG } }, { type: "image_url", image_url: { url: PNG } }, { type: "image_url", image_url: { url: PNG } },
  ] }] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /At most/i);
});

test("an unknown content part is refused", async () => {
  const r = await post({ messages: [{ role: "user", content: [{ type: "audio", audio: "x" }] }] });
  assert.equal(r.status, 400);
});

test("a screen does not count towards the text limit", async () => {
  // Text is well under the limit; the image is large. This must not be read as an oversized prompt.
  const r = await post({ messages: [
    { role: "system", content: "You are the audit assistant." },
    { role: "user", content: [{ type: "text", text: "Look at this screen." }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(900_000) } }] },
  ] });
  assert.notEqual(r.status, 413);
});

test("a long text prompt is still refused", async () => {
  const r = await post({ messages: [{ role: "user", content: "x".repeat(24_001) }] });
  assert.equal(r.status, 413);
});

test("a request carrying a screen gets room for a reasoning model's answer", () => {
  const src = readFileSync("app/api/a11y/chat/route.ts", "utf8");
  // 1400 was enough for a text task, but a vision request is routed to a reasoning model
  // whose thinking tokens come out of the same budget, and the reply came back truncated.
  assert.match(src, /images > 0 \? 4000 : 1400/);
});
