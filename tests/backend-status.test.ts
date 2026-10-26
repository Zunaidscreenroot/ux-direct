import assert from "node:assert/strict";
import test from "node:test";
import { collectBackendStatus } from "../src/backend/status";

const env = {
  OPENROUTER_API_KEY: "or-key", FREELLMAPI_API_KEY: "fl-key", FREELLMAPI_BASE_URL: "https://free.example/v1",
  UX_AUDIT_BASE_URL: "https://audit.example", UX_DIRECT_BRAIN_API_KEY: "brain",
};
const getPlugin = async () => ({ connected: true, connectedSessions: 1, lastHeartbeatAt: "2026-10-26T15:00:00.000Z" });
const getChatGpt = async () => ({ state: "idle" as const, lastActivityAt: null });

test("reports every node and probes each provider without leaking keys", async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (url.startsWith("https://free.example")) return new Response("{}", { status: auth === "Bearer fl-key" ? 200 : 401 });
    return new Response("{}", { status: 200 });
  };
  const status = await collectBackendStatus({ host: "h", env, fetchImpl, getPlugin, getChatGpt, now: 0 });
  assert.equal(status.providers.options.length, 2);
  assert.deepEqual(status.providers.options.map((o) => [o.id, o.configured, o.reachable]), [["openrouter", true, true], ["freellmapi", true, true]]);
  assert.equal(status.providers.selected, "openrouter");
  assert.equal(status.plugin.connected, true);
  assert.equal(status.uxAudit.reachable, true);
  assert.equal(status.brain.reachable, true);
  assert.equal(status.chatgpt.state, "idle");
  assert.ok(seen.includes("https://free.example/v1/models"));
  assert.equal(JSON.stringify(status).includes("fl-key"), false);
  assert.equal(JSON.stringify(status).includes("or-key"), false);
});

test("unconfigured providers are reported as not configured, not unreachable", async () => {
  const status = await collectBackendStatus({
    host: "h", env: {}, fetchImpl: async () => { throw new Error("offline"); },
    getPlugin: async () => { throw new Error("r2"); }, getChatGpt: async () => { throw new Error("r2"); },
  });
  for (const option of status.providers.options) { assert.equal(option.configured, false); assert.equal(option.reachable, null); }
  assert.equal(status.plugin.connected, false);
  assert.equal(status.chatgpt.state, "unknown");
  assert.equal(status.uxAudit.reachable, false);
  assert.equal(status.brain.reachable, null);
});

test("a rejected FreeLLMAPI key is reported clearly", async () => {
  const status = await collectBackendStatus({ host: "h", env, fetchImpl: async (url) => new Response("{}", { status: url.startsWith("https://free.example") ? 401 : 200 }), getPlugin, getChatGpt });
  const free = status.providers.options.find((o) => o.id === "freellmapi")!;
  assert.equal(free.reachable, false);
  assert.match(free.detail, /rejected the key/);
});
