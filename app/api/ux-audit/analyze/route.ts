import { NextResponse } from "next/server";
import { chatCompletionWithFallback, GatewayError, type ChatMessage } from "@/src/model-gateway";
import { getResolvedActiveChatProvider } from "@/src/providers/runtime-chat-provider";
import { deduplicateFindings, normalizeRegion } from "@/src/ux-audit/annotations";
import { buildAuditUserPrompt, UX_AUDIT_SYSTEM_PROMPT } from "@/src/ux-audit/prompt";
import { AUDIT_CATEGORIES, type AuditFinding, type AuditScreenshot, type AuditSeverity, type BenchmarkComparison, type UXAuditReport } from "@/src/ux-audit/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORY_SET = new Set<string>(AUDIT_CATEGORIES);
const rateWindows = new Map<string, { count: number; since: number }>();

function checkRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const key = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const existing = rateWindows.get(key);
  if (!existing || now - existing.since > 5 * 60_000) {
    rateWindows.set(key, { count: 1, since: now });
    return true;
  }
  existing.count += 1;
  return existing.count <= 4;
}

function isPublicHttpsImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.href.length > 2048) return false;
    const host = url.hostname.toLowerCase();
    const parts = host.split(".");
    const isIpv4 = parts.length === 4 && parts.every((part) =>
      part.length > 0 && [...part].every((character) => character >= "0" && character <= "9") && Number(part) <= 255
    );
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (isIpv4 || host.includes(":") || !host.includes(".")) return false;
    return true;
  } catch { return false; }
}

function asText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function severity(value: unknown): AuditSeverity | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}
function normalizeReport(value: unknown, input: {
  product: string; journey: string; goal: string; screenshots: AuditScreenshot[];
}): UXAuditReport | null {
  const parsed = record(value);
  if (!parsed || !Array.isArray(parsed.findings)) return null;
  const findings: AuditFinding[] = [];
  for (const raw of parsed.findings.slice(0, 60)) {
    const item = record(raw);
    if (!item) continue;
    const kind = item.kind === "positive" ? "positive" : item.kind === "issue" ? "issue" : null;
    const category = typeof item.category === "string" && CATEGORY_SET.has(item.category) ? item.category as AuditFinding["category"] : null;
    const title = asText(item.title, 180);
    const screenshotIndex = item.screenshotIndex;
    const evidence = asText(item.evidence, 1000);
    const recommendation = asText(item.recommendation, 1000);
    if (!kind || !category || !title || !evidence || !recommendation ||
        !Number.isInteger(screenshotIndex) || Number(screenshotIndex) < 0 || Number(screenshotIndex) >= input.screenshots.length) continue;
    if (kind === "positive" && category !== "POSITIVE") continue;
    if (kind === "issue" && category === "POSITIVE") continue;
    const itemSeverity = kind === "positive" ? null : severity(item.severity);
    const heuristic = asText(item.heuristic, 200) || null;
    if (kind === "issue" && itemSeverity === null) continue;
    if (kind === "issue" && itemSeverity !== null && itemSeverity >= 3 && !heuristic) continue;
    const confidenceRaw = typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : 0.5;
    findings.push({
      id: "",
      kind,
      category,
      severity: itemSeverity,
      title,
      screenshotIndex: Number(screenshotIndex),
      evidence,
      impact: asText(item.impact, 1000),
      recommendation,
      heuristic,
      confidence: Math.max(0, Math.min(1, confidenceRaw)),
      region: normalizeRegion(item.region)
    });
  }
  const benchmark: BenchmarkComparison[] = [];
  // Match provider-generated site names case-insensitively, then preserve the user's canonical label.
  const allowedSites = new Map(input.screenshots.map((s) => [s.siteName.trim().toLowerCase(), s.siteName]));
  const hasMultipleSites = allowedSites.size >= 2;
  for (const raw of (hasMultipleSites && Array.isArray(parsed.benchmark) ? parsed.benchmark : []).slice(0, 60)) {
    const item = record(raw);
    if (!item) continue;
    const suppliedSiteName = asText(item.siteName, 100);
    const siteName = allowedSites.get(suppliedSiteName.toLowerCase());
    const relativePosition = item.relativePosition;
    if (!siteName || !["stronger", "at-par", "weaker", "not-comparable"].includes(String(relativePosition))) continue;
    const criterion = asText(item.criterion, 180);
    const evidence = asText(item.evidence, 1000);
    if (!criterion || !evidence) continue;
    benchmark.push({
      criterion,
      siteName,
      relativePosition: relativePosition as BenchmarkComparison["relativePosition"],
      evidence,
      improvementOpportunity: asText(item.improvementOpportunity, 800) || null
    });
  }
  return {
    product: input.product,
    journey: input.journey,
    goal: input.goal,
    summary: asText(parsed.summary, 1600) || "The model returned no executive summary.",
    findings: deduplicateFindings(findings),
    benchmark,
    limitations: Array.isArray(parsed.limitations) ? parsed.limitations.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 400)).filter(Boolean).slice(0, 20) : []
  };
}

export async function POST(request: Request) {
  if (!checkRequest(request)) {
    return NextResponse.json({ error: "UX audit is rate limited or the request origin is not allowed." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const input = record(body);
  if (!input) return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });

  const product = asText(input.product || "Unspecified product", 120);
  const journey = asText(input.journey || "Website UX review", 180);
  const goal = asText(input.goal, 500);
  const platform = asText(input.platform || "web", 40);
  if (!goal) return NextResponse.json({ error: "Describe the user goal so severity can be calibrated against it." }, { status: 400 });
  if (!Array.isArray(input.screenshots) || input.screenshots.length < 1 || input.screenshots.length > 12) {
    return NextResponse.json({ error: "Provide between 1 and 12 screenshot URLs." }, { status: 400 });
  }
  const screenshots: AuditScreenshot[] = [];
  for (const raw of input.screenshots) {
    const item = record(raw);
    if (!item || typeof item.url !== "string" || !isPublicHttpsImageUrl(item.url)) {
      return NextResponse.json({ error: "Each screenshot needs a public HTTPS image URL. Local, private, IP-literal, and non-HTTPS URLs are blocked." }, { status: 400 });
    }
    screenshots.push({
      url: item.url,
      label: asText(item.label || "Screen", 100) || "Screen",
      siteName: asText(item.siteName || product, 100) || product,
      pageType: asText(item.pageType, 100) || undefined
    });
  }
  const normalizedInput = { product, journey, goal, platform, screenshots };
  const prompt = buildAuditUserPrompt(normalizedInput);
  const imageParts: ChatMessage["content"] = [
    { type: "text", text: prompt },
    ...screenshots.map((s) => ({ type: "image_url" as const, image_url: { url: s.url, detail: "high" as const } }))
  ];

  const activeProvider = await getResolvedActiveChatProvider();
  try {
    const startedAt = Date.now();
    let response: { content: string; model: string; provider: string; latencyMs: number; usage?: unknown };
    if (activeProvider.id === "freellmapi") {
      const upstream = await fetch(activeProvider.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + activeProvider.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: activeProvider.visionModel || "auto:vision",
          messages: [
            { role: "system", content: UX_AUDIT_SYSTEM_PROMPT },
            { role: "user", content: imageParts },
          ],
          max_tokens: 6000,
          temperature: 0.15,
          response_format: { type: "json_object" },
        }),
        cache: "no-store",
        signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      const body: unknown = await upstream.json().catch(() => null);
      const bodyRecord = record(body) || {};
      if (!upstream.ok) {
        const errorRecord = record(bodyRecord.error) || {};
        const error = new Error(
          "FreeLLMAPI " + (activeProvider.visionModel || "auto:vision") + " returned HTTP " + upstream.status +
          (typeof errorRecord.message === "string" ? ": " + errorRecord.message.slice(0, 200) : "."),
        ) as Error & { status?: number };
        error.status = upstream.status;
        throw error;
      }
      const choices = Array.isArray(bodyRecord.choices) ? bodyRecord.choices : [];
      const firstChoice = record(choices[0]) || {};
      const message = record(firstChoice.message) || {};
      const rawContent = message.content;
      const content = typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.filter((part) => record(part)?.type === "text" && typeof record(part)?.text === "string")
              .map((part) => String((record(part) || {}).text)).join("")
          : "";
      if (!content.trim()) {
        const error = new Error("FreeLLMAPI auto:vision returned no readable response text.") as Error & { status?: number };
        error.status = 502;
        throw error;
      }
      response = {
        content,
        model: typeof bodyRecord.model === "string" ? bodyRecord.model : (activeProvider.visionModel || "auto:vision"),
        provider: activeProvider.label,
        latencyMs: Date.now() - startedAt,
        usage: bodyRecord.usage,
      };
    } else {
      const routed = await chatCompletionWithFallback({
        // Use the internal model gateway when OpenRouter is selected.
        model: "uxd/vision",
        messages: [
          { role: "system", content: UX_AUDIT_SYSTEM_PROMPT },
          { role: "user", content: imageParts },
        ],
        max_tokens: 6000,
        temperature: 0.15,
        signal: request.signal,
      }, { timeoutMs: 120_000 });
      response = {
        content: routed.content,
        model: routed.model || "uxd/vision",
        provider: routed.provider,
        latencyMs: routed.latencyMs,
        usage: routed.usage,
      };
    }
    let jsonText = response.content.trim();
    jsonText = jsonText.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); }
    catch {
      const routeLabel = activeProvider.id === "freellmapi" ? "FreeLLMAPI auto:vision" : "the selected vision-capable OpenRouter route";
      return NextResponse.json({ error: "The selected model did not return valid structured audit JSON. Check " + routeLabel + " and try again.", provider: response.provider, model: response.model }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const report = normalizeReport(parsed, normalizedInput);
    if (!report) return NextResponse.json({ error: "The model response did not match the UX audit report schema.", provider: response.provider, model: response.model }, { status: 502, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({
      report,
      model: response.model,
      provider: response.provider,
      latencyMs: response.latencyMs,
      usage: response.usage ?? null
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof GatewayError ? error.status :
      typeof error === "object" && error !== null && "status" in error && typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "UX audit failed.",
      status: status >= 400 && status <= 599 ? status : 502
    }, { status: status >= 400 && status <= 599 ? status : 502, headers: { "Cache-Control": "no-store" } });
  }
}
