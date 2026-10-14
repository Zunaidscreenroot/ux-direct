import test from "node:test";
import assert from "node:assert/strict";
import { GET, OPTIONS } from "../app/api/connections/route";

test("connection status rejects requests outside the Figma plugin origin", async () => {
  const response = await GET(new Request("https://uxdirect.test/api/connections?fileKey=QJhcsebwscpdMJDNh9UsYS&clientId=uxd-test-client", {
    headers: { origin: "https://evil.example" },
  }));
  assert.equal(response.status, 403);
});

test("connection status rejects a non-allowlisted Figma file", async () => {
  const response = await GET(new Request("https://uxdirect.test/api/connections?fileKey=another-file-key-123&clientId=uxd-test-client", {
    headers: { origin: "https://www.figma.com" },
  }));
  assert.equal(response.status, 403);
});

test("connection status preflight allows the Figma sandbox origin", async () => {
  const response = await OPTIONS(new Request("https://uxdirect.test/api/connections", {
    method: "OPTIONS",
    headers: { origin: "null" },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
});
