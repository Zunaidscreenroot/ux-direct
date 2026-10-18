import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverSiteMap } from "../src/ia/site-crawler";

test("IA crawler stays on the audited origin, deduplicates pages and preserves parent links", async () => {
  const pages: Record<string, string> = {
    "https://example.com/": '<html><head><title>Example Bank</title><meta name="description" content="Retail banking"></head><body><h1>Banking</h1><a href="/accounts">Accounts</a><a href="/loans">Loans</a><a href="/accounts#top">Accounts again</a><a href="https://competitor.example/cards">External</a><a href="/terms.pdf">PDF</a></body></html>',
    "https://example.com/accounts": '<html><head><title>Accounts</title></head><body><h1>Savings</h1><a href="/">Home</a></body></html>',
    "https://example.com/loans": '<html><head><title>Loans</title></head><body><h1>Personal loan</h1></body></html>'
  };
  const calls: string[] = [];
  const result = await discoverSiteMap("https://example.com/", {
    maxPages: 10,
    maxDepth: 2,
    budgetMs: 5000,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!(url in pages)) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(pages[url], { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch
  });
  assert.equal(result.origin, "https://example.com");
  assert.equal(result.pageCount, 3);
  assert.equal(result.pages[0].title, "Example Bank");
  assert.deepEqual(result.pages[0].headings, ["Banking"]);
  assert.equal(result.pages[1].parentUrl, "https://example.com/");
  assert.equal(result.pages.some((page) => page.url.includes("competitor.example")), false);
  assert.equal(result.pages.some((page) => page.url.endsWith(".pdf")), false);
  // Root fetch + three bounded sitemap probes + two discovered pages.
  assert.equal(calls.length, 6);
});

test("IA crawler rejects private and IP-literal hosts before fetching", async () => {
  await assert.rejects(() => discoverSiteMap("http://127.0.0.1"), /public HTTP\(S\)/);
  await assert.rejects(() => discoverSiteMap("https://service.internal"), /public HTTP\(S\)/);
});
