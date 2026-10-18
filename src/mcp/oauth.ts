import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type Claims = { typ: "code" | "access"; exp: number; aud?: string; client_id?: string; redirect_uri?: string; code_challenge?: string; code_challenge_method?: string; scope?: string };

function secret(): string {
  const value = process.env.UX_DIRECT_MCP_OAUTH_SECRET || process.env.UX_DIRECT_MCP_API_KEY || "";
  if (value.length < 32) throw new Error("Set UX_DIRECT_MCP_OAUTH_SECRET or UX_DIRECT_MCP_API_KEY to a random secret of at least 32 characters.");
  return value;
}
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function sign(value: string): string { return createHmac("sha256", secret()).update(value).digest("base64url"); }
export function issueOAuthToken(claims: Claims): string {
  const payload = encode(claims);
  return payload + "." + sign(payload);
}
export function verifyOAuthToken(token: string): Claims | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  let expected: Buffer;
  try { expected = Buffer.from(sign(payload)); } catch { return null; }
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
    if (!claims || !["code", "access"].includes(claims.typ) || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
export function isValidOAuthAccessToken(authorization: string | null, resource: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const claims = verifyOAuthToken(authorization.slice(7));
  return claims?.typ === "access" && claims.aud === resource;
}
export function clientIdForRedirect(redirectUri: string): string {
  return "uxd_" + createHash("sha256").update(redirectUri).digest("hex").slice(0, 32);
}
export function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com") || url.hostname === "chat.openai.com" || url.hostname.endsWith(".chat.openai.com");
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch { return false; }
}
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
