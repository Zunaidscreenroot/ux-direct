import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const requestWindows = new Map<string, { count: number; since: number }>();

function publicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".")) return null;
    return url;
  } catch { return null; }
}

function rateAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const key = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const prior = requestWindows.get(key);
  if (!prior || now - prior.since > 10 * 60_000) {
    requestWindows.set(key, { count: 1, since: now });
    return true;
  }
  prior.count += 1;
  return prior.count <= 6;
}

/** Runs Lighthouse remotely through Browserless; no local Chrome/Playwright runtime is added. */
export async function POST(request: Request) {
  if (!rateAllowed(request)) {
    return NextResponse.json({ error: "Performance checks are rate limited or the request origin is not allowed." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  const token = process.env.BROWSERLESS_API_TOKEN || process.env.BROWSERLESS_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Browserless is not configured. Set BROWSERLESS_API_TOKEN in the server environment." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).url !== "string") {
    return NextResponse.json({ error: "Provide a public HTTPS website URL." }, { status: 400 });
  }
  const url = publicUrl((body as { url: string }).url);
  if (!url) return NextResponse.json({ error: "Only public HTTPS website URLs are allowed." }, { status: 400 });
  const base = (process.env.BROWSERLESS_BASE_URL || "https://production-sfo.browserless.io").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${base}/performance?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ url: url.href }),
      signal: controller.signal
    });
    if (!response.ok) {
      return NextResponse.json({ error: `Browserless Performance API returned HTTP ${response.status}.` }, { status: response.status === 429 ? 429 : 502, headers: { "Cache-Control": "no-store" } });
    }
    const report: unknown = await response.json();
    return NextResponse.json({ url: url.href, provider: "browserless-lighthouse", report, checkedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "The Lighthouse request timed out." : "Could not reach Browserless Performance API.";
    return NextResponse.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timer);
  }
}
