import { timingSafeEqual } from "node:crypto";

function readEnv(name: string): string {
  const runtime = (globalThis as typeof globalThis & {
    Netlify?: { env?: { get?: (key: string) => string | undefined } };
  }).Netlify;
  return runtime?.env?.get?.(name) || process.env[name] || "";
}

export function isSharedBrainAuthorized(request: Request): boolean {
  const expected = readEnv("UX_DIRECT_BRAIN_API_KEY") || readEnv("UX_DIRECT_MCP_API_KEY");
  if (expected.length < 32) return false;
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer\s+/i.test(authorization)) return false;
  const supplied = Buffer.from(authorization.replace(/^Bearer\s+/i, "").trim());
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

export function unauthorizedBrainResponse() {
  return Response.json(
    { error: "A valid UX Direct shared-brain service credential is required." },
    { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } },
  );
}

export function brainNoStoreHeaders() {
  return { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
}

export const ALLOWED_BRAIN_SCOPES = new Set([
  "UX_SHARED_BRAIN",
  "indian-bfsi",
  "project:ux-direct",
  "project:ux-audit",
  "project:general-ux",
  "project:dmi-finance",
  "project:ujjivan-sfb",
  "project:express-computers",
]);

export function validateBrainScopes(value: unknown): string[] {
  const requested = Array.isArray(value) ? value : ["UX_SHARED_BRAIN"];
  const unique = [...new Set(requested.filter((item): item is string => typeof item === "string").map(item => item.trim()))];
  if (!unique.length) unique.push("UX_SHARED_BRAIN");
  if (unique.length > 8 || unique.some(scope => !ALLOWED_BRAIN_SCOPES.has(scope))) {
    throw new Error("scopeKeys contains an unsupported scope. Use only approved shared-brain scopes.");
  }
  return unique;
}

export async function readJsonBody(request: Request, maxBytes = 32_000): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  try { return JSON.parse(raw); } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

export function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status = typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number" && error.status >= 400 && error.status <= 599
      ? error.status : 400;
  return Response.json({ error: message }, { status, headers: brainNoStoreHeaders() });
}
