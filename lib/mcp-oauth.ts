import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export type McpClaims = Record<string, unknown> & { typ: "client" | "code" | "access" | "refresh"; exp?: number };
export const MCP_SCOPES = ["ux:read", "ux:execute", "ux:learn", "offline_access"] as const;

// ChatGPT can identify itself with its stable Client ID Metadata Document (CIMD).
export const CHATGPT_CIMD_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
export function isChatGptCimdClientId(clientId: string): boolean {
  // Exact URL allowlisting prevents arbitrary remote metadata fetches and SSRF.
  return clientId === CHATGPT_CIMD_CLIENT_ID;
}
export function readMcpEnv(key: string): string {
  const runtime = (globalThis as typeof globalThis & { Netlify?: { env?: { get?: (name: string) => string | undefined } } }).Netlify;
  return runtime?.env?.get?.(key) || process.env[key] || "";
}
export function getMcpSecret(): string {
  const value = readMcpEnv("UX_DIRECT_MCP_OAUTH_SECRET");
  if (value.length < 32) throw new Error("UX_DIRECT_MCP_OAUTH_SECRET must be configured with at least 32 characters.");
  return value;
}
function signature(encoded: string): string { return createHmac("sha256", getMcpSecret()).update(encoded).digest("base64url"); }
export function signMcpPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded + "." + signature(encoded);
}
export function verifyMcpPayload(token: string, expectedType?: McpClaims["typ"]): McpClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, supplied] = parts;
    const expected = Buffer.from(signature(encoded)), actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as McpClaims;
    if (!parsed || typeof parsed !== "object" || typeof parsed.typ !== "string") return null;
    if (expectedType && parsed.typ !== expectedType) return null;
    if (typeof parsed.exp === "number" && parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch { return null; }
}
export function getMcpIssuer(request: Request): string {
  const configured = readMcpEnv("UX_DIRECT_MCP_ISSUER_URL").trim().replace(/\/+$/, "");
  return configured || new URL(request.url).origin;
}
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
