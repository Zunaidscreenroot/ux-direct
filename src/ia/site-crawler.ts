export type HierarchySource = "official-html-sitemap" | "observed-crawl";
export type SiteLink = {
  url: string;
  label: string;
  parentUrl?: string | null;
  hierarchyDepth?: number;
  hierarchySource?: HierarchySource;
};
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
  documentTitle?: string;
  inspected?: boolean;
  hierarchySource?: HierarchySource;
  children?: SiteLink[];
};
export type SiteMapResult = {
  origin: string;
  pages: SiteMapPage[];
  pageCount: number;
  failedCount: number;
  capped: boolean;
  elapsedMs: number;
  hierarchySource: HierarchySource;
  hierarchySourceUrl?: string;
  totalKnownPages: number;
  inspectedCount: number;
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
  const maxPages = Math.min(120, Math.max(1, Math.floor(options.maxPages ?? 120)));
  const maxDepth = Math.min(5, Math.max(0, Math.floor(options.maxDepth ?? 3)));
  const budgetMs = Math.min(22_000, Math.max(2_000, Math.floor(options.budgetMs ?? 18_000)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const rootItem = { url: start.href, depth: 0, parentUrl: null as string | null };
  const rootPage = await crawlOne(rootItem, start.origin, fetchImpl, Math.min(5_000, budgetMs));
  rootPage.inspected = rootPage.status !== null;
  rootPage.hierarchySource = "observed-crawl";
  const pages: SiteMapPage[] = [rootPage];
  let failedCount = rootPage.status === null || rootPage.status >= 400 || rootPage.error === "Not an HTML page." ? 1 : 0;
  let capped = false;

  const hintedSitemaps = rootPage.links.filter(link => isHtmlSitemapUrl(link.url)).map(link => link.url);
  const commonSitemaps = ["/sitemap", "/site-map", "/sitemap.html"].map(path => new URL(path, start.origin).href);
  const candidates = [...new Set([...hintedSitemaps, ...commonSitemaps])]
    .filter(url => url !== start.href).slice(0, 4);
  let sitemapPage: SiteMapPage | undefined = rootPage.links.some(link => typeof link.hierarchyDepth === "number")
    ? rootPage : undefined;
  if (!sitemapPage && rootPage.status !== null && rootPage.status < 400 && candidates.length) {
    const probes = await Promise.all(candidates.map(async url => {
      try {
        return await crawlOne(
          { url, depth: 0, parentUrl: null }, start.origin, fetchImpl,
          Math.max(800, Math.min(2_400, budgetMs - (Date.now() - started)))
        );
      } catch {
        return null;
      }
    }));
    sitemapPage = probes.find((page): page is SiteMapPage =>
      Boolean(page && page.status !== null && page.status < 400 &&
        page.links.some(link => typeof link.hierarchyDepth === "number" && link.hierarchySource === "official-html-sitemap"))
    );
  }

  if (sitemapPage) {
    const rootUrl = start.href;
    const unique = new Map<string, SiteLink>();
    for (const link of sitemapPage.links) {
      const url = normalizeCrawlUrl(link.url, start.origin);
      if (!url || url === rootUrl || typeof link.hierarchyDepth !== "number") continue;
      if (!unique.has(url)) unique.set(url, { ...link, url });
    }
    const allEntries = [...unique.values()];
    const eligible = allEntries.filter(link => (link.hierarchyDepth ?? 1) <= maxDepth);
    const balanced = orderSitemapLinks(eligible, rootUrl);
    const selected = balanced.slice(0, Math.max(0, maxPages - 1));
    capped = selected.length < eligible.length || allEntries.length >= 800;
    const selectedUrls = new Set<string>([rootUrl, ...selected.map(link => link.url)]);
    const childrenByParent = new Map<string, SiteLink[]>();
    for (const link of selected) {
      const parentUrl = link.parentUrl && selectedUrls.has(link.parentUrl) ? link.parentUrl : rootUrl;
      const child = { ...link, parentUrl, hierarchySource: "official-html-sitemap" as const };
      childrenByParent.set(parentUrl, [...(childrenByParent.get(parentUrl) ?? []), child]);
    }
    const structuralPages: SiteMapPage[] = selected.map(link => {
      const parentUrl = link.parentUrl && selectedUrls.has(link.parentUrl) ? link.parentUrl : rootUrl;
      return {
        id: link.url,
        url: link.url,
        title: link.label || new URL(link.url).pathname || "Untitled page",
        description: null,
        depth: link.hierarchyDepth ?? 1,
        parentUrl,
        headings: [],
        links: [],
        children: [],
        status: null,
        inspected: false,
        hierarchySource: "official-html-sitemap"
      };
    });
    const pageByUrl = new Map<string, SiteMapPage>([[rootUrl, rootPage], ...structuralPages.map(page => [page.url, page] as [string, SiteMapPage])]);
    for (const [parentUrl, children] of childrenByParent) {
      const parent = pageByUrl.get(parentUrl);
      if (parent) parent.children = children.map(child => ({
        url: child.url, label: child.label, parentUrl, hierarchyDepth: child.hierarchyDepth,
        hierarchySource: "official-html-sitemap"
      }));
    }
    pages.push(...structuralPages);

    // The sitemap supplies the hierarchy; a bounded, branch-balanced sample supplies live status and heading evidence.
    const inspectTargets = structuralPages.slice(0, Math.min(24, structuralPages.length));
    while (inspectTargets.length && Date.now() - started < budgetMs) {
      const batch = inspectTargets.splice(0, Math.min(3, inspectTargets.length));
      const timeLeft = budgetMs - (Date.now() - started);
      if (timeLeft < 800) break;
      const inspected = await Promise.all(batch.map(async page => {
        try {
          return await crawlOne(
            { url: page.url, depth: page.depth, parentUrl: page.parentUrl },
            start.origin, fetchImpl, Math.max(800, Math.min(4_000, timeLeft))
          );
        } catch (error) {
          return { ...emptyPage({ url: page.url, depth: page.depth, parentUrl: page.parentUrl }, null,
            error instanceof Error ? error.message : "Page inspection failed.") };
        }
      }));
      for (const fetched of inspected) {
        const target = pageByUrl.get(fetched.url);
        if (!target) continue;
        target.status = fetched.status;
        target.documentTitle = fetched.title;
        target.description = fetched.description;
        target.headings = fetched.headings;
        target.links = fetched.links;
        target.error = fetched.error;
        target.inspected = fetched.status !== null;
        target.hierarchySource = "official-html-sitemap";
        if (fetched.status === null || fetched.status >= 400 || fetched.error === "Not an HTML page.") failedCount += 1;
      }
    }
    return {
      origin: start.origin,
      pages: pages.slice(0, maxPages),
      pageCount: Math.min(pages.length, maxPages),
      failedCount,
      capped,
      elapsedMs: Date.now() - started,
      hierarchySource: "official-html-sitemap",
      hierarchySourceUrl: sitemapPage.url,
      totalKnownPages: allEntries.length + 1,
      inspectedCount: pages.slice(0, maxPages).filter(page => page.inspected).length
    };
  }

  // No sitemap: preserve the live-link graph, but mark it as an observed approximation.
  const sitemapCandidateSet = new Set(candidates);
  const queue: Array<{ url: string; depth: number; parentUrl: string | null }> = rootPage.links
    .filter(link => !isHtmlSitemapUrl(link.url) && !sitemapCandidateSet.has(link.url))
    .map(link => ({ url: link.url, depth: 1, parentUrl: start.href }));
  const queued = new Set<string>([start.href, ...candidates]);
  for (const item of queue) queued.add(item.url);
  while (queue.length > 0 && pages.length < maxPages && Date.now() - started < budgetMs) {
    const batch = queue.splice(0, Math.min(3, maxPages - pages.length));
    const timeLeft = budgetMs - (Date.now() - started);
    if (timeLeft < 800) { queue.unshift(...batch); break; }
    const processed = await Promise.all(batch.map(async item => {
      const page = await crawlOne(item, start.origin, fetchImpl, Math.max(800, Math.min(4_000, timeLeft)));
      return { item, page };
    }));
    for (const { item, page } of processed) {
      page.inspected = page.status !== null;
      page.hierarchySource = "observed-crawl";
      pages.push(page);
      if (page.status === null || page.status >= 400) failedCount += 1;
      if (item.depth >= maxDepth || !page.status || page.status >= 400) continue;
      for (const link of page.links) {
        if (queue.length + pages.length >= maxPages * 3) break;
        const normalized = normalizeCrawlUrl(link.url, start.origin);
        if (!normalized || queued.has(normalized) || queued.size >= maxPages * 4) continue;
        queued.add(normalized);
        queue.push({ url: normalized, depth: item.depth + 1, parentUrl: item.url });
      }
    }
  }
  if (queue.length > 0 || Date.now() - started >= budgetMs) capped = true;
  return {
    origin: start.origin,
    pages: pages.slice(0, maxPages),
    pageCount: Math.min(pages.length, maxPages),
    failedCount,
    capped,
    elapsedMs: Date.now() - started,
    hierarchySource: "observed-crawl",
    totalKnownPages: Math.max(pages.length, queued.size - candidates.length),
    inspectedCount: pages.filter(page => page.inspected).length
  };
}
function isHtmlSitemapUrl(value: string): boolean {
  try { return /(?:^|\/)(?:site[-_]?map)(?:\.html)?\/?$/i.test(new URL(value).pathname); }
  catch { return false; }
}
function orderSitemapLinks(links: SiteLink[], rootUrl: string): SiteLink[] {
  const byUrl = new Map(links.map(link => [link.url, link]));
  const branchFor = (link: SiteLink): string => {
    let current = link;
    const seen = new Set<string>();
    while (current.parentUrl && current.parentUrl !== rootUrl && byUrl.has(current.parentUrl) && !seen.has(current.url)) {
      seen.add(current.url);
      current = byUrl.get(current.parentUrl)!;
    }
    return current.url;
  };
  const maxDepth = links.reduce((max, link) => Math.max(max, link.hierarchyDepth ?? 1), 1);
  const result: SiteLink[] = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const layer = links.filter(link => (link.hierarchyDepth ?? 1) === depth);
    const buckets = new Map<string, SiteLink[]>();
    for (const link of layer) {
      const branch = branchFor(link);
      buckets.set(branch, [...(buckets.get(branch) ?? []), link]);
    }
    const queues = [...buckets.values()].map(bucket => [...bucket]);
    while (queues.some(queue => queue.length)) {
      for (const queue of queues) {
        const next = queue.shift();
        if (next) result.push(next);
      }
    }
  }
  return result;
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
  // Block literal IPv4 and IPv6 destinations before any outbound request.
  const hostParts = host.split(".");
  const isIpv4 = hostParts.length === 4 && hostParts.every((part) =>
    part.length > 0 && [...part].every((character) => character >= "0" && character <= "9") && Number(part) <= 255
  );
  if (isIpv4 || host.includes(":")) return true;
  if (!host.includes(".")) return true;
  if (host === "0.0.0.0" || host.endsWith(".test") || host.endsWith(".invalid")) return true;
  return false;
}

function extractSitemapHierarchy(html: string, pageUrl: string, origin: string): SiteLink[] {
  let content = html;
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (main) content = main[1];
  const found: SiteLink[] = [];
  const seen = new Set<string>();
  const add = (href: string, label: string, parentUrl: string, depth: number) => {
    const normalized = normalizeSitemapUrl(href, origin);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    found.push({
      url: normalized,
      label: decodeEntities(stripTags(label)).trim().replace(/\s+/g, " ").slice(0, 140) || new URL(normalized).pathname || "Unlabelled sitemap entry",
      parentUrl, hierarchyDepth: depth, hierarchySource: "official-html-sitemap"
    });
  };
  const readBalancedElement = (source: string, openingStart: number, tagName: string): { inner: string; end: number } | null => {
    const openingEnd = source.indexOf(">", openingStart);
    if (openingEnd < 0) return null;
    const token = new RegExp("<" + tagName + "\\b[^>]*>|</" + tagName + "\\s*>", "gi");
    token.lastIndex = openingEnd + 1;
    let depth = 1;
    let match: RegExpExecArray | null;
    while ((match = token.exec(source))) {
      if (match[0].startsWith("</")) depth--;
      else if (!match[0].endsWith("/>")) depth++;
      if (depth === 0) return { inner: source.slice(openingEnd + 1, match.index), end: token.lastIndex };
    }
    return null;
  };
  const menuSectionStart = /<div\b[^>]*class=["'][^"']*\bmenu-section\b[^"']*["'][^>]*>/gi;
  let sectionMatch: RegExpExecArray | null;
  let foundSections = 0;
  while ((sectionMatch = menuSectionStart.exec(content))) {
    const balanced = readBalancedElement(content, sectionMatch.index, "div");
    if (!balanced) break;
    foundSections++;
    const sectionHtml = balanced.inner;
    const heading = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(sectionHtml);
    const rootAnchor = heading ? /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i.exec(heading[1]) : null;
    let sectionUrl: string | null = null;
    if (rootAnchor) {
      let href = "";
      try { href = new URL(decodeEntities(rootAnchor[2]).trim(), pageUrl).href; } catch { /* invalid sitemap entry */ }
      const normalized = normalizeCrawlUrl(href, origin);
      if (normalized) {
        sectionUrl = normalized;
        add(normalized, rootAnchor[3], new URL("/", origin).href, 1);
      }
    }
    if (sectionUrl) {
      const mainMenu = /<span\b[^>]*class=["'][^"']*\bmain-menu\b[^"']*["'][^>]*>\s*<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>\s*<\/span>/gi;
      let menuMatch: RegExpExecArray | null;
      while ((menuMatch = mainMenu.exec(sectionHtml))) {
        let href = "";
        try { href = new URL(decodeEntities(menuMatch[2]).trim(), pageUrl).href; } catch { continue; }
        const normalizedMenuUrl = normalizeCrawlUrl(href, origin);
        if (!normalizedMenuUrl) continue;
        add(normalizedMenuUrl, menuMatch[3], sectionUrl, 2);

        const rest = sectionHtml.slice(mainMenu.lastIndex);
        const subMenuOpen = /^\s*<ul\b[^>]*class=["'][^"']*\bsub-menu\b[^"']*["'][^>]*>/i.exec(rest);
        if (!subMenuOpen) continue;
        const listStart = mainMenu.lastIndex + subMenuOpen.index;
        const list = readBalancedElement(sectionHtml, listStart, "ul");
        if (!list) continue;
        const anchors = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
        let childMatch: RegExpExecArray | null;
        while ((childMatch = anchors.exec(list.inner))) {
          add(childMatch[2], childMatch[3], normalizedMenuUrl, 3);
        }
      }
    }
    menuSectionStart.lastIndex = balanced.end;
  }
  if (!foundSections) {
    // Generic nested-list sitemap fallback for sites not using Ujjivan's menu-section markup.
    const headingRegex = /<h[1-4]\b[^>]*>[\s\S]*?<\/h[1-4]>/gi;
    let headingMatch: RegExpExecArray | null;
    while ((headingMatch = headingRegex.exec(content))) {
      if (/sitemap/i.test(decodeEntities(stripTags(headingMatch[0])))) {
        content = content.slice(headingRegex.lastIndex);
        break;
      }
    }
    const footer = /<footer\b|<div\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:footer|region-footer)[^"']*["']/i.exec(content);
    if (footer) content = content.slice(0, footer.index);
    type ListItem = { url: string | null; depth: number; parentUrl: string | null };
    const stack: ListItem[] = [];
    const tokens = /<\/?li\b[^>]*>|<a\b[^>]*>[\s\S]*?<\/a>/gi;
    for (const tokenMatch of content.matchAll(tokens)) {
      const token = tokenMatch[0];
      if (/^<li\b/i.test(token)) { stack.push({ url: null, depth: 0, parentUrl: null }); continue; }
      if (/^<\/li/i.test(token)) { stack.pop(); continue; }
      if (!stack.length) continue;
      const current = stack[stack.length - 1];
      if (current.url) continue;
      const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i.exec(token);
      if (!anchor) continue;
      let target = "";
      try { target = new URL(decodeEntities(anchor[2]).trim(), pageUrl).href; } catch { continue; }
      const normalized = normalizeCrawlUrl(target, origin);
      if (!normalized) continue;
      const parent = [...stack.slice(0, -1)].reverse().find(item => item.url);
      const depth = parent ? parent.depth + 1 : 1;
      const parentUrl = parent?.url ?? new URL("/", origin).href;
      current.url = normalized;
      current.depth = depth;
      current.parentUrl = parentUrl;
      add(normalized, anchor[3], parentUrl, depth);
    }
  }
  return found.slice(0, 800);
}

function normalizeSitemapUrl(raw: string, origin: string): string | null {
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    const path = url.pathname.toLowerCase();
    // Keep downloadable disclosures and forms as IA destinations; skip only web assets.
    if (/\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|zip|gz|woff2?|ttf|eot|mp4|mp3|xml|json|rss|atom)(?:$|\/)/i.test(path)) return null;
    url.pathname = normalizePath(url.pathname);
    return url.href;
  } catch {
    return null;
  }
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
      const links = isHtmlSitemapUrl(item.url) ? extractSitemapHierarchy(html, item.url, origin) : extractLinks(html, item.url, origin).slice(0, 120);
      return {
        id: item.url,
        url: item.url,
        title: decodeEntities(stripTags(title)).trim().slice(0, 180) || "Untitled page",
        description,
        depth: item.depth,
        parentUrl: item.parentUrl,
        headings,
        links,
        status: response.status,
        inspected: true,
        hierarchySource: isHtmlSitemapUrl(item.url) ? "official-html-sitemap" : "observed-crawl"
      };
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError" ? "Request timed out." : "Network or parsing failure.";
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 180));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...emptyPage(item, null, lastError), error: lastError, inspected: false, hierarchySource: "observed-crawl" };
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
    let absoluteUrl: string;
    try { absoluteUrl = new URL(href, pageUrl).href; } catch { continue; }
    const url = normalizeCrawlUrl(absoluteUrl, origin);
    if (!url || seen.has(url) || url === pageUrl) continue;
    seen.add(url);
    results.push({ url, label: label || new URL(url).pathname || "Unlabelled link" });
  }
  return results;
}
function emptyPage(item: { url: string; depth: number; parentUrl: string | null }, status: number | null, error?: string): SiteMapPage {
  return { id: item.url, url: item.url, title: new URL(item.url).pathname === "/" ? "Home" : new URL(item.url).pathname, description: null, depth: item.depth, parentUrl: item.parentUrl, headings: [], links: [], status, ...(error ? { error } : {}) };
}
