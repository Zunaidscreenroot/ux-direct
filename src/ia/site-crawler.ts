export type SiteLink = { url: string; label: string };
export type SiteMapPage = {
  id: string;
  url: string;
  title: string;
  description: string | null;
  depth: number;
  parentUrl: string | null;
  headings: string[];
  links: SiteLink[];
  status: number | null;
  error?: string;
};
export type SiteMapResult = {
  origin: string;
  pages: SiteMapPage[];
  pageCount: number;
  failedCount: number;
  capped: boolean;
  elapsedMs: number;
};

/**
 * Worker-safe bounded site crawler. Its queue, URL deduplication, depth/page
 * caps, same-origin policy and bounded retries follow Crawlee's useful patterns,
 * without importing its Node.js storage/browser runtime into a Cloudflare Worker.
 */
export async function discoverSiteMap(
  startUrl: string,
  options: { maxPages?: number; maxDepth?: number; budgetMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<SiteMapResult> {
  const start = parsePublicWebUrl(startUrl);
  if (!start) throw new Error("Enter a valid public HTTP(S) website URL. Private, local, and IP-literal hosts are not allowed.");
  const maxPages = Math.min(30, Math.max(1, Math.floor(options.maxPages ?? 18)));
  const maxDepth = Math.min(5, Math.max(0, Math.floor(options.maxDepth ?? 3)));
  const budgetMs = Math.min(22_000, Math.max(2_000, Math.floor(options.budgetMs ?? 18_000)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  type QueueItem = { url: string; depth: number; parentUrl: string | null };
  const queue: QueueItem[] = [{ url: start.href, depth: 0, parentUrl: null }];
  const queued = new Set<string>([start.href]);
  const pages: SiteMapPage[] = [];
  let failedCount = 0;
  let capped = false;

  while (queue.length > 0 && pages.length < maxPages && Date.now() - started < budgetMs) {
    const batch = queue.splice(0, Math.min(3, maxPages - pages.length));
    const processed = await Promise.all(batch.map(async (item) => {
      const page = await crawlOne(item, start.origin, fetchImpl, Math.max(800, Math.min(6_000, budgetMs - (Date.now() - started))));
      return { item, page };
    }));
    for (const result of processed) {
      pages.push(result.page);
      if (result.page.status === null || result.page.status >= 400) failedCount += 1;
      if (result.item.depth >= maxDepth || !result.page.status || result.page.status >= 400) continue;
      for (const link of result.page.links) {
        if (queue.length + pages.length + queued.size > maxPages * 3) break;
        const normalized = normalizeCrawlUrl(link.url, start.origin);
        if (!normalized || queued.has(normalized) || queued.size >= maxPages * 4) continue;
        queued.add(normalized);
        queue.push({ url: normalized, depth: result.item.depth + 1, parentUrl: result.item.url });
      }
    }
  }
  if (queue.length > 0 || pages.length >= maxPages || Date.now() - started >= budgetMs) capped = true;
  return {
    origin: start.origin,
    pages: pages.slice(0, maxPages),
    pageCount: Math.min(pages.length, maxPages),
    failedCount,
    capped,
    elapsedMs: Date.now() - started
  };
}

function parsePublicWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isBlockedHost(host)) return null;
    url.hash = "";
    url.search = "";
    url.pathname = normalizePath(url.pathname);
    return url;
  } catch {
    return null;
  }
}

function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // Block literal IPs; public domain URLs are sufficient for this website auditing workflow.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return true;
  if (!host.includes(".")) return true;
  if (host === "0.0.0.0" || host.endsWith(".test") || host.endsWith(".invalid")) return true;
  return false;
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/") || "/";
}

function normalizeCrawlUrl(raw: string, origin: string): string | null {
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    const path = url.pathname.toLowerCase();
    if (/\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|xml|json|rss|atom)(?:$|\/)/i.test(path)) return null;
    url.pathname = normalizePath(url.pathname);
    return url.href;
  } catch {
    return null;
  }
}

async function crawlOne(
  item: { url: string; depth: number; parentUrl: string | null },
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<SiteMapPage> {
  let lastError = "Page could not be fetched.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(item.url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "User-Agent": "UXDirect-IA-Discovery/1.0" }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        const target = location ? new URL(location, item.url) : null;
        if (target && target.origin === origin) {
          return emptyPage(item, response.status, "Redirect discovered; crawl the canonical URL from the same origin.");
        }
        return emptyPage(item, response.status, "Redirect leaves the audited origin; skipped for safety.");
      }
      const type = response.headers.get("content-type") || "";
      if (!type.toLowerCase().includes("text/html") && !type.toLowerCase().includes("application/xhtml+xml")) {
        return emptyPage(item, response.status, "Not an HTML page.");
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 180));
          continue;
        }
        return emptyPage(item, response.status, lastError);
      }
      const html = await readTextLimited(response, 1_500_000);
      const title = extractFirst(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) || new URL(item.url).pathname.split("/").filter(Boolean).pop() || "Home";
      const description = extractMeta(html, "description");
      const headings = extractHeadings(html).slice(0, 16);
      const links = extractLinks(html, item.url, origin).slice(0, 120);
      return {
        id: item.url,
        url: item.url,
        title: decodeEntities(stripTags(title)).trim().slice(0, 180) || "Untitled page",
        description,
        depth: item.depth,
        parentUrl: item.parentUrl,
        headings,
        links,
        status: response.status
      };
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError" ? "Request timed out." : "Network or parsing failure.";
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 180));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...emptyPage(item, null, lastError), error: lastError };
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function extractFirst(html: string, pattern: RegExp): string {
  return pattern.exec(html)?.[1] ?? "";
}
function stripTags(value: string): string { return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "); }
function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");
}
function extractMeta(html: string, name: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const metaName = /\bname\s*=\s*["']?([^\s"'/>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (metaName !== name.toLowerCase()) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    return decodeEntities(content).trim().slice(0, 500) || null;
  }
  return null;
}
function extractHeadings(html: string): string[] {
  const result: string[] = [];
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = decodeEntities(stripTags(match[2])).trim();
    if (text && text.length < 180 && !result.includes(text)) result.push(text);
  }
  return result;
}
function extractLinks(html: string, pageUrl: string, origin: string): SiteLink[] {
  const results: SiteLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(match[3]).trim();
    const label = decodeEntities(stripTags(match[5])).trim().replace(/\s+/g, " ").slice(0, 140);
    if (!href || /^(?:javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    const url = normalizeCrawlUrl(new URL(href, pageUrl).href, origin);
    if (!url || seen.has(url) || url === pageUrl) continue;
    seen.add(url);
    results.push({ url, label: label || new URL(url).pathname || "Unlabelled link" });
  }
  return results;
}
function emptyPage(item: { url: string; depth: number; parentUrl: string | null }, status: number | null, error?: string): SiteMapPage {
  return { id: item.url, url: item.url, title: new URL(item.url).pathname === "/" ? "Home" : new URL(item.url).pathname, description: null, depth: item.depth, parentUrl: item.parentUrl, headings: [], links: [], status, ...(error ? { error } : {}) };
}
