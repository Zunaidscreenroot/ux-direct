#!/usr/bin/env node
/**
 * Optional local/Node.js crawl path using Crawlee's CheerioCrawler only.
 * This script is intentionally not imported into the Cloudflare Worker bundle.
 *
 * Usage: node scripts/ia-crawl.mjs https://example.com [maxPages=18] [maxDepth=3]
 * Requires Node.js 22.13+ and @crawlee/cheerio (no Playwright/Puppeteer).
 */
import { CheerioCrawler } from "@crawlee/cheerio";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/ia-crawl.mjs https://example.com [maxPages=18] [maxDepth=3]");
  process.exit(2);
}
const start = new URL(input);
if (!["http:", "https:"].includes(start.protocol) || start.username || start.password ||
    ["localhost", "127.0.0.1", "0.0.0.0"].includes(start.hostname) || !start.hostname.includes(".")) {
  console.error("Provide a public HTTP(S) URL.");
  process.exit(2);
}
const maxPages = Math.min(30, Math.max(1, Number.parseInt(process.argv[3] || "18", 10) || 18));
const maxDepth = Math.min(5, Math.max(0, Number.parseInt(process.argv[4] || "3", 10) || 3));

const crawler = new CheerioCrawler({
  maxRequestsPerCrawl: maxPages,
  maxConcurrency: 3,
  requestHandlerTimeoutSecs: 20,
  async requestHandler({ request, $, enqueueLinks, pushData, log }) {
    const depth = Number(request.userData?.depth || 0);
    const currentUrl = request.loadedUrl || request.url;
    const title = $("title").first().text().trim();
    const headings = $("h1,h2,h3").map((_, element) => $(element).text().trim()).get()
      .filter(Boolean).slice(0, 30);
    const links = $("a[href]").map((_, element) => ({
      label: $(element).text().replace(/\\s+/g, " ").trim().slice(0, 140),
      href: $(element).attr("href")
    })).get().filter((link) => Boolean(link.href)).slice(0, 200);
    await pushData({
      url: currentUrl,
      title,
      depth,
      parentUrl: request.userData?.parentUrl || null,
      headings,
      links
    });
    if (depth >= maxDepth) return;
    await enqueueLinks({
      strategy: "same-domain",
      transformRequestFunction(next) {
        next.userData = { ...(next.userData || {}), depth: depth + 1, parentUrl: currentUrl };
        return next;
      }
    });
    log.info("Mapped " + currentUrl + " (depth " + depth + ")");
  }
});
await crawler.run([{ url: start.href, userData: { depth: 0, parentUrl: null } }]);
const result = await crawler.getData();
console.log(JSON.stringify({
  origin: start.origin,
  pageCount: result.items.length,
  pages: result.items
}, null, 2));
