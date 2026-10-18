import test from "node:test";
import assert from "node:assert/strict";
import { GET as getAuthorizationServerMetadata } from "../app/.well-known/oauth-authorization-server/route";
import { GET as getProtectedResourceRootMetadata } from "../app/.well-known/oauth-protected-resource/route";
import { GET as getProtectedResourcePathMetadata } from "../app/.well-known/oauth-protected-resource/api/mcp/route";

function withIssuerUnset<T>(run: () => T): T {
  const previous = process.env.UX_DIRECT_MCP_ISSUER_URL;
  delete process.env.UX_DIRECT_MCP_ISSUER_URL;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.UX_DIRECT_MCP_ISSUER_URL;
    else process.env.UX_DIRECT_MCP_ISSUER_URL = previous;
  }
}

test("authorization-server metadata is available at the standard well-known URL", async () => {
  const response = await withIssuerUnset(() =>
    getAuthorizationServerMetadata(new Request("https://uxdirect.test/.well-known/oauth-authorization-server")),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.issuer, "https://uxdirect.test");
  assert.equal(body.authorization_endpoint, "https://uxdirect.test/api/mcp/oauth/authorize");
  assert.equal(body.token_endpoint, "https://uxdirect.test/api/mcp/oauth/token");
  assert.equal(body.registration_endpoint, "https://uxdirect.test/api/mcp/oauth/register");
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
});

test("path-specific protected-resource metadata matches the MCP endpoint resource identifier", async () => {
  const response = await withIssuerUnset(() =>
    getProtectedResourcePathMetadata(new Request("https://uxdirect.test/.well-known/oauth-protected-resource/api/mcp")),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.resource, "https://uxdirect.test/api/mcp");
  assert.deepEqual(body.authorization_servers, ["https://uxdirect.test"]);
  assert.ok(body.scopes_supported.includes("ux:execute"));
});

test("root protected-resource metadata fallback is also available", async () => {
  const response = await withIssuerUnset(() =>
    getProtectedResourceRootMetadata(new Request("https://uxdirect.test/.well-known/oauth-protected-resource")),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.resource, "https://uxdirect.test/api/mcp");
  assert.deepEqual(body.authorization_servers, ["https://uxdirect.test"]);
});
