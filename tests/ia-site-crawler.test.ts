import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverSiteMap } from "../src/ia/site-crawler";

function html(title: string, body: string): Response {
  return new Response("<!doctype html><html><head><title>" + title + "</title></head><body>" + body + "</body></html>", {
    status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

test("uses a nested HTML sitemap as the authoritative parent-child hierarchy", async () => {
  const root = "https://bank.example/";
  const responses: Record<string, Response> = {
    [root]: html("Bank home", '<a href="/personal">Personal</a><a href="/sitemap">Sitemap</a>'),
    "https://bank.example/sitemap": html("Site map",
      '<main><h1>Sitemap</h1><ul>' +
      '<li><a href="/personal">Personal</a><ul><li><a href="/personal/savings">Savings</a><ul><li><a href="/personal/savings/digital">Digital savings</a></li></ul></li></ul></li>' +
      '<li><a href="/business">Business</a><ul><li><a href="/business/current-account">Current account</a></li></ul></li>' +
      '<li><a href="/nri">NRI</a><ul><li><a href="/nri/deposits">NRI deposits</a></li></ul></li>' +
      '</ul></main>'),
    "https://bank.example/personal": html("Bank home", "<h1>Personal banking</h1>"),
    "https://bank.example/personal/savings": html("Savings", "<h1>Savings</h1>"),
    "https://bank.example/personal/savings/digital": html("Digital savings", "<h1>Digital savings</h1>"),
    "https://bank.example/business": html("Business", "<h1>Business banking</h1>"),
    "https://bank.example/business/current-account": html("Current account", "<h1>Current accounts</h1>"),
    "https://bank.example/nri": html("NRI", "<h1>NRI banking</h1>"),
    "https://bank.example/nri/deposits": html("NRI deposits", "<h1>NRI deposits</h1>")
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return responses[url] ?? new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  const result = await discoverSiteMap(root, { maxPages: 8, maxDepth: 4, budgetMs: 12_000, fetchImpl });
  assert.equal(result.hierarchySource, "official-html-sitemap");
  assert.equal(result.hierarchySourceUrl, "https://bank.example/sitemap");
  assert.equal(result.pageCount, 8);
  const pageByUrl = new Map(result.pages.map(page => [page.url, page]));
  assert.equal(pageByUrl.get("https://bank.example/personal")?.parentUrl, root);
  assert.equal(pageByUrl.get("https://bank.example/personal/savings")?.parentUrl, "https://bank.example/personal");
  assert.equal(pageByUrl.get("https://bank.example/personal/savings/digital")?.parentUrl, "https://bank.example/personal/savings");
  assert.equal(pageByUrl.get("https://bank.example/business/current-account")?.parentUrl, "https://bank.example/business");
  assert.equal(pageByUrl.get("https://bank.example/personal")?.title, "Personal");
  assert.equal(pageByUrl.get("https://bank.example/personal")?.documentTitle, "Bank home");
  assert.ok(result.inspectedCount >= 1);
});

test("labels no-sitemap maps as observed crawl paths", async () => {
  const root = "https://no-map.example/";
  const responses: Record<string, Response> = {
    [root]: html("Home", '<a href="/accounts">Accounts</a>'),
    "https://no-map.example/accounts": html("Accounts", "<h1>Accounts</h1>")
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return responses[url] ?? new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  const result = await discoverSiteMap(root, { maxPages: 4, maxDepth: 2, budgetMs: 8_000, fetchImpl });
  assert.equal(result.hierarchySource, "observed-crawl");
  assert.equal(result.pages.find(page => page.url.endsWith("/accounts"))?.parentUrl, root);
});