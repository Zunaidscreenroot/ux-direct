import { NextResponse } from "next/server";
import { chatCompletionWithFallback, GatewayError } from "@/src/model-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGES = 30;
const rateWindows = new Map<string, { count: number; since: number }>();

type PageInput = {
  id: string;
  url: string;
  title: string;
  depth: number;
  parentUrl: string | null;
  status: number | null;
  description?: string | null;
  headings?: string[];
  links?: Array<{ url: string; label: string }>;
};

type Finding = {
  title: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  category: string;
  evidence: string;
  recommendation: string;
  confidence: number;
  hypothesis: boolean;
  url: string;
};

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function publicHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const parts = host.split(".");
    const isIpv4 = parts.length === 4 && parts.every((part) => part !== "" && [...part].every((ch) => ch >= "0" && ch <= "9") && Number(part) <= 255);
    if (!["https:", "http:"].includes(url.protocol) || !host || url.username || url.password ||
        host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
        isIpv4 || host.includes(":") || !host.includes(".")) return null;
    url.hash = "";
    return url;
  } catch { return null; }
}

function clipText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function parseFindingList(value: unknown, allowedUrls: Set<string>): Finding[] {
  if (!Array.isArray(value)) return [];
  const findings: Finding[] = [];
  for (const itemValue of value.slice(0, 30)) {
    const item = asRecord(itemValue);
    if (!item) continue;
    const title = clipText(item.title, 180);
    const evidence = clipText(item.evidence, 900);
    const recommendation = clipText(item.recommendation, 900);
    const category = clipText(item.category, 80);
    const severity = item.severity;
    const url = publicHttpUrl(item.url);
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1, item.confidence)) : null;
    if (!title || !evidence || !recommendation || !category ||
        !["Critical", "High", "Medium", "Low"].includes(String(severity)) ||
        confidence === null || !url || !allowedUrls.has(url.href)) continue;
    findings.push({
      title, evidence, recommendation, category,
      severity: severity as Finding["severity"],
      confidence,
      hypothesis: item.hypothesis === true,
      url: url.href
    });
  }
  return findings;
}

export async function POST(request: Request) {
  if (!checkRequest(request)) {
    return NextResponse.json({ error: "IA audit is rate limited or the request origin is not allowed." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }

  const input = asRecord(body);
  const originUrl = publicHttpUrl(input?.origin);
  if (!input || !originUrl) return NextResponse.json({ error: "Provide a valid public website origin and discovered pages." }, { status: 400 });
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > MAX_PAGES) {
    return NextResponse.json({ error: "Provide 1–30 discovered pages. Run discovery again with the page cap set to 30 for a broader review." }, { status: 400 });
  }

  const origin = originUrl.origin;
  const pages: PageInput[] = [];
  for (const raw of input.pages) {
    const page = asRecord(raw);
    const pageUrl = publicHttpUrl(page?.url);
    if (!page || !pageUrl || pageUrl.origin !== origin) continue;
    pages.push({
      id: clipText(page.id, 220) || pageUrl.href,
      url: pageUrl.href,
      title: clipText(page.title, 180) || pageUrl.pathname || "Untitled page",
      depth: typeof page.depth === "number" && Number.isFinite(page.depth) ? Math.max(0, Math.min(20, Math.floor(page.depth))) : 0,
      parentUrl: typeof page.parentUrl === "string" && publicHttpUrl(page.parentUrl)?.origin === origin ? new URL(page.parentUrl).href : null,
      status: typeof page.status === "number" && Number.isFinite(page.status) ? page.status : null,
      description: clipText(page.description, 320) || null,
      headings: Array.isArray(page.headings) ? page.headings.filter((x): x is string => typeof x === "string").slice(0, 10).map(x => clipText(x, 100)) : [],
      links: Array.isArray(page.links) ? page.links.slice(0, 25).flatMap((linkValue) => {
        const link = asRecord(linkValue);
        const target = publicHttpUrl(link?.url);
        if (!link || !target || target.origin !== origin) return [];
        return [{ url: target.href, label: clipText(link.label, 100) || target.pathname }];
      }) : []
    });
  }
  if (!pages.length) return NextResponse.json({ error: "No valid discovered pages matched the supplied website origin." }, { status: 400 });
  
  const allowedUrls = new Set(pages.map(page => page.url));
  const evidenceContext = pages.map(page => ({
    url: page.url,
    title: page.title,
    depth: page.depth,
    parentUrl: page.parentUrl,
    status: page.status,
    description: page.description,
    headings: page.headings,
    links: page.links.map(link => ({ label: link.label, url: link.url })),
    note: "This parent relationship comes from the bounded crawler's traversal path; it is not guaranteed to represent every live navigation menu."
  }));
  const systemPrompt = [
    "You are a careful information-architecture analyst reviewing a public website from a bounded crawl.",
    "Return only one valid JSON object with keys summary and findings. Do not use Markdown fences.",
    "Use observed evidence in the supplied pages only. Do not invent pages, links, analytics, user tests, business metrics, or legal-compliance claims.",
    "Every finding must have title, severity (Critical|High|Medium|Low), category, evidence, recommendation, confidence (0..1), hypothesis (boolean), and url.",
    "The finding's url must be one exact URL from the supplied page records.",
    "Be conservative: when the crawl cannot prove a usability problem, set hypothesis=true and explicitly say what must be validated.",
    "Do not call a page an orphan unless the supplied link graph actually shows no inbound links among crawled pages; a capped or incomplete crawl is not proof.",
    "Look for duplicate or ambiguous labels/paths, content whose grouping appears inconsistent with the path, excessive hierarchy depth, dead HTTP responses, unclear title-heading match, repetitive navigation labels, and important service/disclosure destinations that may be hard to distinguish.",
    "Only flag duplicate paths or labels as a finding if at least two specific pages/links in the supplied evidence support it. Prioritize user task success and financial-services findability.",
    "If the evidence is insufficient, return fewer findings and explain limitations in summary. Use severity based on evidenced user harm; don't exaggerate."
  ].join("\n");

  const userPrompt = [
    "Review this discovered information architecture for " + origin + ".",
    "Crawl includes " + pages.length + " page records and may be capped; treat omissions as unknown.",
    "Return JSON schema: {"summary":"...","findings":[{"title":"...","severity":"Critical|High|Medium|Low","category":"...","evidence":"...","recommendation":"...","confidence":0.0,"hypothesis":true,"url":"exact supplied page URL"}]}",
    "Aim for up to 12 distinct findings. Each evidence string must refer to one or more supplied page titles, paths, HTTP statuses, headings, or links. Do not claim screenshot findings.",
    JSON.stringify({ origin, pageCount: pages.length, pages: evidenceContext })
  ].join("\n\n");

  try {
    const model = process.env.UXD_IA_MODEL || process.env.UX_DIRECT_CHAT_MODEL || "mock/ux-direct";
    const inferredProvider = model === "mock/ux-direct" ? "mock" : process.env.UXD_IA_PROVIDER?.trim() || (model.includes("/") ? "openrouter" : undefined);
    const configuredModule = process.env.UXD_IA_GATEWAY_MODULE || "";
    const moduleId = model === "mock/ux-direct" ? "general" :
      ["reasoning", "classification", "extraction", "summarization", "vision", "critique"].includes(configuredModule) ? configuredModule : "general";
    const response = await chatCompletionWithFallback({
      model,
      ...(inferredProvider ? { providerId: inferredProvider } : {}),
      moduleId,
            messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 5000
    });
    const raw = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return NextResponse.json({ error: "The selected model did not return structured IA audit JSON. Check Model Gateway configuration and try again.", model: response.model, provider: response.provider }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); }
    catch {
      return NextResponse.json({ error: "The selected model returned invalid IA audit JSON. Try again or change the IA model.", model: response.model, provider: response.provider }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const parsedRecord = asRecord(parsed);
    if (!parsedRecord || typeof parsedRecord.summary !== "string" || !Array.isArray(parsedRecord.findings)) {
      return NextResponse.json({ error: "The model response did not match the IA audit schema.", model: response.model, provider: response.provider }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const findings = parseFindingList(parsedRecord.findings, allowedUrls);
    return NextResponse.json({
      summary: clipText(parsedRecord.summary, 1600) || "The model returned no IA summary.",
      findings,
      pagesReviewed: pages.length,
      findingsRejected: Math.max(0, parsedRecord.findings.length - findings.length),
      model: response.model,
      provider: response.provider,
      latencyMs: response.latencyMs,
      limitations: [
        "Findings are based on a bounded HTML crawl, not usability testing or web analytics.",
        "Hypotheses require validation; missing pages in a capped crawl are not evidence of an orphaned page."
      ]
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof GatewayError ? error.status : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "IA audit failed.",
      status: status >= 400 && status <= 599 ? status : 502
    }, { status: status >= 400 && status <= 599 ? status : 502, headers: { "Cache-Control": "no-store" } });
  }
}
