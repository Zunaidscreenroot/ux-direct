import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const metadata = read("app/.well-known/oauth-authorization-server/route.ts");
const authorize = read("app/api/mcp/oauth/authorize/route.ts");
const token = read("app/api/mcp/oauth/token/route.ts");
const helper = read("lib/mcp-oauth.ts");

test("OAuth advertises CIMD and issuer identification while retaining DCR", () => {
  assert.ok(metadata.includes("client_id_metadata_document_supported: true"));
  assert.ok(metadata.includes("authorization_response_iss_parameter_supported: true"));
  assert.ok(metadata.includes("registration_endpoint:"));
});

test("authorization supports only the trusted ChatGPT CIMD URL or a signed DCR client", () => {
  assert.ok(helper.includes("return clientId === CHATGPT_CIMD_CLIENT_ID"));
  assert.ok(authorize.includes("isChatGptCimdClientId(clientId)"));
  assert.ok(authorize.includes('clientId.startsWith("uxmcp_")'));
  assert.ok(authorize.includes('redirect: "error"'));
  assert.ok(authorize.includes("raw.length > 16_384"));
  assert.ok(authorize.includes("redirects.includes(CHATGPT_STABLE_REDIRECT_URI)"));
});

test("authorization requires state and returns the full OAuth callback data", () => {
  assert.ok(authorize.includes("!state || state.length > 2048"));
  assert.ok(authorize.includes('callback.searchParams.set("code", code)'));
  assert.ok(authorize.includes('callback.searchParams.set("state", input.state)'));
  assert.ok(authorize.includes('callback.searchParams.set("iss", issuer)'));
});

test("token exchange keeps the authorization code bound to client, redirect URI and PKCE", () => {
  assert.ok(token.includes("registeredDcrClient"));
  assert.ok(token.includes("trustedCimdClient"));
  assert.ok(token.includes("claims.client_id !== clientId"));
  assert.ok(token.includes("claims.redirect_uri !== redirectUri"));
  assert.ok(token.includes("!equal(challenge, String(claims.code_challenge || \"\"))"));
  assert.ok(token.includes("refresh.client_id !== clientId"));
});
