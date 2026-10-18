"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow,
  useEdgesState, useNodesState,
  type Edge, type Node, type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type SiteNodeData = {
  title: string;
  url: string;
  depth: number;
  status: number | null;
  inspected?: boolean;
  outbound: number;
  hierarchySource?: "official-html-sitemap" | "observed-crawl";
  sample?: boolean;
};
type SiteNode = Node<SiteNodeData, "page">;
type PageRecord = {
  id: string;
  url: string;
  title: string;
  depth: number;
  parentUrl: string | null;
  status: number | null;
  links?: Array<{ url: string; label: string }>;
  headings?: string[];
  description?: string | null;
  error?: string;
  documentTitle?: string;
  inspected?: boolean;
  hierarchySource?: "official-html-sitemap" | "observed-crawl";
  children?: Array<{ url: string; label: string }>;
};
type DiscoveryResult = {
  origin: string; pages: PageRecord[]; pageCount: number;
  failedCount: number; capped: boolean; elapsedMs: number;
  hierarchySource: "official-html-sitemap" | "observed-crawl";
  hierarchySourceUrl?: string;
  totalKnownPages: number;
  inspectedCount: number;
};

function PageNode({ data }: NodeProps<SiteNode>) {
  const failed = data.status !== null && data.status >= 400;
  const statusColor = data.status === null ? "#a1adbf" : data.status >= 400 ? "#f28c9c" : "#74e7c1";
  const pagePath = new URL(data.url).pathname || "/";
  return (
    <div style={{
      width: 236, border: "1px solid " + (failed ? "#66404a" : "#2c4550"), borderRadius: 13,
      background: "linear-gradient(145deg,#151e2c,#101722)", boxShadow: "0 8px 24px rgba(0,0,0,.2)",
      padding: 13, color: "#edf4fc", fontFamily: "DM Sans,sans-serif"
    }}>
      <Handle type="target" position={Position.Left} style={{ background: "#8d8aff", width: 8, height: 8, border: "2px solid #101722" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 9, textTransform: "uppercase", fontWeight: 800, color: "#9db0c7", letterSpacing: ".09em" }}>LEVEL {data.depth + 1}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9, color: statusColor }}>
          <span style={{ width: 6, height: 6, borderRadius: 10, background: statusColor, display: "inline-block" }} />
          {data.status === null ? (data.inspected === false ? "NOT CHECKED" : "UNVERIFIED") : "HTTP " + data.status}
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 800, lineHeight: 1.45, overflowWrap: "anywhere", color: "#f4f7fc" }}>{data.title}</div>
      <div style={{ fontSize: 10, color: "#91e9d1", lineHeight: 1.45, marginTop: 6, overflowWrap: "anywhere" }}>{pagePath}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 11, borderTop: "1px solid #2b3749", paddingTop: 9, fontSize: 9, color: "#93a3b8" }}>
        <span>{data.status ?? "No response"}</span><span>{data.hierarchySource === "official-html-sitemap" ? data.outbound + " sitemap children" : data.outbound + " outgoing links"}</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#8debd1", width: 8, height: 8, border: "2px solid #101722" }} />
    </div>
  );
}
const nodeTypes = { page: PageNode };

const samplePages: PageRecord[] = [
  { id: "sample-root", url: "https://example.test/", title: "Sample website", depth: 0, parentUrl: null, status: 200, links: [{ url: "https://example.test/accounts", label: "Accounts" }, { url: "https://example.test/loans", label: "Loans" }, { url: "https://example.test/cards", label: "Cards" }, { url: "https://example.test/deposits", label: "Deposits" }] },
  { id: "sample-accounts", url: "https://example.test/accounts", title: "Accounts", depth: 1, parentUrl: "https://example.test/", status: 200, links: [{ url: "https://example.test/accounts/savings", label: "Savings account" }] },
  { id: "sample-loans", url: "https://example.test/loans", title: "Loans", depth: 1, parentUrl: "https://example.test/", status: 200, links: [{ url: "https://example.test/loans/personal", label: "Personal loan" }] },
  { id: "sample-cards", url: "https://example.test/cards", title: "Cards", depth: 1, parentUrl: "https://example.test/", status: 200, links: [{ url: "https://example.test/cards/credit", label: "Credit cards" }] },
  { id: "sample-deposits", url: "https://example.test/deposits", title: "Deposits", depth: 1, parentUrl: "https://example.test/", status: 200, links: [{ url: "https://example.test/deposits/fixed", label: "Fixed deposits" }] },
  { id: "sample-savings", url: "https://example.test/accounts/savings", title: "Savings account", depth: 2, parentUrl: "https://example.test/accounts", status: 200, links: [] },
  { id: "sample-personal", url: "https://example.test/loans/personal", title: "Personal loan", depth: 2, parentUrl: "https://example.test/loans", status: 200, links: [] },
  { id: "sample-credit", url: "https://example.test/cards/credit", title: "Credit cards", depth: 2, parentUrl: "https://example.test/cards", status: 200, links: [] },
  { id: "sample-fixed", url: "https://example.test/deposits/fixed", title: "Fixed deposits", depth: 2, parentUrl: "https://example.test/deposits", status: 200, links: [] }
];

function buildGraph(pages: PageRecord[]): { nodes: SiteNode[]; edges: Edge[] } {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const page of pages) {
    const parent = page.parentUrl && byUrl.has(page.parentUrl) ? page.parentUrl : null;
    if (!parent) roots.push(page.url);
    else children.set(parent, [...(children.get(parent) ?? []), page.url]);
  }
  const positionByUrl = new Map<string, {x:number;y:number}>();
  const subtreeHeight = new Map<string, number>();
  const measure = (url: string, visited = new Set<string>()): number => {
    if (subtreeHeight.has(url)) return subtreeHeight.get(url)!;
    if (visited.has(url)) return 1;
    const nextVisited = new Set(visited); nextVisited.add(url);
    const childUrls = (children.get(url) ?? []).filter(child => !nextVisited.has(child));
    const height = Math.max(1, childUrls.reduce((sum, child) => sum + measure(child, nextVisited), 0));
    subtreeHeight.set(url, height);
    return height;
  };
  const place = (url:string, depth:number, yStart:number, visited = new Set<string>()) => {
    if (positionByUrl.has(url) || visited.has(url)) return;
    const page = byUrl.get(url); if (!page) return;
    const height = measure(url);
    positionByUrl.set(url, { x: 40 + depth * 310, y: yStart + Math.max(0, (height - 1) * 76) });
    const nextVisited = new Set(visited); nextVisited.add(url);
    let nextY = yStart;
    for (const child of children.get(url) ?? []) {
      const childHeight = measure(child);
      place(child, depth + 1, nextY, nextVisited);
      nextY += childHeight * 152;
    }
  };
  let nextRootY = 24;
  for (const root of roots) { place(root, 0, nextRootY); nextRootY += measure(root) * 152 + 56; }
  // Preserve disconnected pages if parent links are missing or the crawl is capped.
  for (const page of pages) {
    if (!positionByUrl.has(page.url)) { place(page.url, page.depth, nextRootY); nextRootY += 180; }
  }
  const nodes: SiteNode[] = pages.map(page => ({
    id: page.id,
    type: "page",
    position: positionByUrl.get(page.url) ?? {x: 40 + page.depth * 310, y: 24},
    data: { title: page.title, url: page.url, depth: page.depth, status: page.status, inspected: page.inspected, outbound: page.hierarchySource === "official-html-sitemap" ? page.children?.length ?? 0 : page.links?.length ?? 0, hierarchySource: page.hierarchySource, sample: page.id.startsWith("sample-") }
  }));
  const pageIds = new Map(pages.map(page => [page.url, page.id]));
  const edges: Edge[] = pages.flatMap(page => {
    if (!page.parentUrl || !pageIds.has(page.parentUrl)) return [];
    return [{ id: "edge-" + pageIds.get(page.parentUrl) + "-" + page.id, source: pageIds.get(page.parentUrl)!, target: page.id, type: "smoothstep", animated: false, style: { stroke: "#99b5a3", strokeWidth: 1.5 } }];
  });
  return { nodes, edges };
}

export default function IADemoPage() {
  const [url, setUrl] = useState("https://www.ujjivansfb.bank.in/");
  const [maxDepth, setMaxDepth] = useState("3");
  const [maxPages, setMaxPages] = useState("120");
  const [pages, setPages] = useState<PageRecord[]>(samplePages);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedPage, setSelectedPage] = useState<PageRecord | null>(null);
  const [search, setSearch] = useState("");
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditSummary, setAuditSummary] = useState<string | null>(null);
  const [auditFindings, setAuditFindings] = useState<Array<{title:string; severity:string; evidence:string; recommendation:string; confidence:number; hypothesis:boolean; url:string}>>([]);
  const [showFindings, setShowFindings] = useState(true);
  const filteredPages = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? pages.filter((page) => page.title.toLowerCase().includes(term) || page.url.toLowerCase().includes(term) || (page.description || "").toLowerCase().includes(term)) : pages;
  }, [pages, search]);
  const graph = useMemo(() => buildGraph(filteredPages), [filteredPages]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SiteNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graph.edges);

  useEffect(() => {
    const next = buildGraph(filteredPages);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [filteredPages, setNodes, setEdges]);

  // Refresh React Flow state when the crawler result changes.
  const loadGraph = (nextPages: PageRecord[]) => {
    const next = buildGraph(nextPages);
    setPages(nextPages);
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedPage(null);
  };

  async function discover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    setAuditFindings([]);
    setAuditSummary(null);
    setAuditError("");
    try {
      const response = await fetch("/api/ia/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, maxDepth: Number(maxDepth), maxPages: Number(maxPages) })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not discover this website.");
      const data = payload as DiscoveryResult;
      setResult(data);
      loadGraph(data.pages);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "IA discovery failed.");
    } finally {
      setBusy(false);
    }
  }

  async function auditIA() {
    if (!result || result.pages.length === 0 || auditBusy) return;
    setAuditBusy(true); setAuditError(""); setAuditFindings([]); setAuditSummary(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 35_000);
    try {
      // Keep the payload focused; the server and model need a useful representative
      // link sample, not every raw outgoing link emitted by the crawler.
      const auditPages = result.pages.map((page) => ({
        ...page,
        links: (page.links || []).slice(0, 8),
        children: (page.children || []).slice(0, 18),
        headings: (page.headings || []).slice(0, 8)
      }));
      const response = await fetch("/api/ia/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: result.origin, pages: auditPages }),
        signal: controller.signal,
        cache: "no-store"
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "IA audit failed.");
      setAuditSummary(typeof payload.summary === "string" ? payload.summary : "IA analysis complete.");
      setAuditFindings(Array.isArray(payload.findings) ? payload.findings : []);
    } catch (cause) {
      setAuditError(controller.signal.aborted
        ? "IA analysis timed out after 35 seconds. Please retry; the request has been cancelled."
        : cause instanceof Error ? cause.message : "IA audit failed.");
    } finally {
      window.clearTimeout(timeoutId);
      setAuditBusy(false);
    }
  }

  return (
    <main className="ia-workbench">
      <header className="ia-head">
        <div>
          <Link href="/chat#audit" className="ia-back">← Audit workspace</Link>
          <div className="eyebrow" style={{ marginTop: 24 }}><span className="pulse" /> INFORMATION ARCHITECTURE</div>
          <h1>Information architecture <em>studio.</em></h1>
          <p className="intro">Discover your site structure, inspect the real page hierarchy, then let AI review the architecture for evidence-backed findability risks.</p>
        </div>
      </header>

      <form className="ia-toolbar" onSubmit={discover}>
        <label className="ia-url-label" htmlFor="ia-url">Website URL</label>
        <div className="ia-controls">
          <input id="ia-url" type="url" required placeholder="https://www.example.com" value={url} onChange={(event) => setUrl(event.target.value)} />
          <label>Depth
            <select value={maxDepth} onChange={(event) => setMaxDepth(event.target.value)}>
              <option value="1">L1–L2</option><option value="2">L1–L3</option><option value="3">L1–L4</option><option value="4">L1–L5</option>
            </select>
          </label>
          <label>Max pages
            <select value={maxPages} onChange={(event) => setMaxPages(event.target.value)}>
              <option value="30">30</option><option value="60">60</option><option value="120">120</option>
            </select>
          </label>
          <button className="submit-button" type="submit" disabled={busy}>{busy ? "Discovering…" : "Discover IA →"}</button>
        </div>
        <p className="ia-note">Prefers the site&apos;s nested HTML sitemap for the published hierarchy, then inspects a bounded page sample for HTTP status and headings. If no sitemap is found, the viewer labels the result as an observed crawl path instead. Public HTML only.</p>
      </form>

      {error ? <div className="ia-error" role="alert">{error}</div> : null}
      {result ? (
        <div className="ia-metrics">
          <div><strong>{result.pageCount}</strong><span>pages mapped</span></div>
          <div><strong>{result.totalKnownPages}</strong><span>known pages</span></div>
          <div><strong>{result.inspectedCount}</strong><span>pages inspected</span></div>
          <div><strong>{result.capped ? "Capped" : "Within scope"}</strong><span>map scope</span></div>
          <span className="ia-origin">{result.origin}</span>
          <p className="ia-source-note">{result.hierarchySource === "official-html-sitemap"
            ? "Hierarchy source: official HTML sitemap" + (result.hierarchySourceUrl ? " (" + new URL(result.hierarchySourceUrl).pathname + ")" : "") + ". Pages not yet inspected remain unverified for HTTP status and page headings."
            : "Hierarchy source: observed link crawl. This is an approximation of navigation, not a verified site-owner IA."}</p>
        </div>
      ) : (
        <div className="ia-sample-note">Sample map only — no live site has been crawled yet.</div>
      )}

      <section className="ia-canvas" aria-label="Interactive website information architecture">
        <div className="ia-canvas-head">
          <div><strong>IA map</strong><span>Drag nodes · zoom · pan · select a page · open source URL</span></div>
          <div className="ia-legend"><span><i style={{ background: "#4f9569" }} /> HTTP 2xx/3xx</span><span><i style={{ background: "#d97757" }} /> HTTP error</span></div>
        </div>
        <div className="ia-graph-toolbar">
          <input aria-label="Search discovered pages" placeholder="Search page names or URLs…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <span>{filteredPages.length} of {pages.length} pages</span>
          <button type="button" className="ia-audit-cta" onClick={auditIA} disabled={!result || auditBusy}>{auditBusy ? "Analysing IA…" : "✦ Audit IA with AI"}</button>
        </div>
        <div style={{ width: "100%", height: 590 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              const page = pages.find((item) => item.id === node.id);
              setSelectedPage(page ?? null);
            }}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            maxZoom={1.6}
            defaultEdgeOptions={{ type: "smoothstep" }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#e8eee8" gap={24} />
            <Controls />
            <MiniMap nodeStrokeWidth={3} zoomable pannable />
          </ReactFlow>
        </div>
      </section>

      {auditError ? <div className="ia-error" role="alert">{auditError}</div> : null}
      {auditSummary ? <section className="ia-findings-wrap">
        <div className="ia-canvas-head"><div><strong>AI IA audit findings</strong><span>{auditFindings.length} findings · hypotheses are separated from observations</span></div><button type="button" className="ia-toggle" onClick={() => setShowFindings(v => !v)}>{showFindings ? "Hide findings" : "Show findings"}</button></div>
        {showFindings ? <><p className="ia-summary">{auditSummary}</p>{auditFindings.length ? auditFindings.map((finding, i) => <article className="ia-finding" key={finding.title + "-" + i}>
          <div className="ia-finding-title"><span className={"ia-severity sev-" + finding.severity.toLowerCase()}>{finding.severity}</span><strong>{finding.title}</strong>{finding.hypothesis ? <span className="ia-hypothesis">Hypothesis</span> : null}<span className="ia-confidence">{Math.round(finding.confidence * 100)}% confidence</span></div>
          <p>{finding.evidence}</p><p><strong>Recommendation:</strong> {finding.recommendation}</p><a href={finding.url} target="_blank" rel="noreferrer">Open evidence page ↗</a>
        </article>) : <p className="ia-summary">No validated findings were returned. This does not guarantee there are no IA issues.</p>}</> : null}
      </section> : null}

      {selectedPage ? (
        <section className="ia-page-detail">
          <div><span className="ia-kicker">SELECTED PAGE</span><h2>{selectedPage.title}</h2><a href={selectedPage.url} target="_blank" rel="noreferrer">{selectedPage.url}</a></div>
          <div><strong>Depth</strong><span>L{selectedPage.depth + 1}</span></div>
          <div><strong>HTTP status</strong><span>{selectedPage.status ?? "Not fetched"}</span></div>
          <div><strong>H1–H6 headings</strong>{selectedPage.headings?.length ? selectedPage.headings.slice(0, 8).map((heading, i) => <span key={i}>{heading}</span>) : <span>{selectedPage.inspected === false ? "Not inspected yet" : "No headings extracted"}</span>}{selectedPage.documentTitle && selectedPage.documentTitle !== selectedPage.title ? <span>Document title: {selectedPage.documentTitle}</span> : null}</div>
        </section>
      ) : null}

      {result ? (
        <section className="ia-table-wrap">
          <div className="ia-canvas-head"><div><strong>Discovered pages</strong><span>Sorted by level, then title</span></div></div>
          <div className="ia-table-scroll"><table className="ia-table"><thead><tr><th>Level</th><th>Page</th><th>URL</th><th>Status</th><th>Headings</th></tr></thead>
            <tbody>{pages.map((page) => <tr key={page.id}>
              <td>L{page.depth + 1}</td><td><button type="button" className="ia-page-select" onClick={() => setSelectedPage(page)}>{page.title}</button></td>
              <td><a href={page.url} target="_blank" rel="noreferrer">{new URL(page.url).pathname || "/"}</a></td>
              <td>{page.inspected === false ? "Not checked" : page.status ?? "Failed"}</td><td>{page.headings?.length ?? 0}</td>
            </tr>)}</tbody></table></div>
        </section>
      ) : null}
      <footer className="ia-footer">UX DIRECT <span>·</span> IA DISCOVERY / INTERACTIVE MAP</footer>

      <style jsx global>{`
        .ia-workbench{min-height:100vh;background:radial-gradient(ellipse at 72% -12%,#182239 0%,#0b0f16 48%,#0a0d13 100%);color:#f4f7fc;padding:28px clamp(18px,4vw,54px) 24px;font-family:"DM Sans",sans-serif}
        .ia-head{max-width:1400px;margin:0 auto 28px}
        .ia-back{color:#93e9d0;text-decoration:none;font-size:12px;font-weight:800}
        .ia-workbench h1{font-family:Manrope,sans-serif;font-size:clamp(32px,4vw,48px);line-height:1.08;letter-spacing:-1.8px;margin:0 0 14px;color:#f2f6fc}.ia-workbench h1 em{font-style:normal;background:linear-gradient(90deg,#92f2d9,#b5a6ff);color:transparent;background-clip:text}.ia-workbench .intro{max-width:680px;color:#99a8bd;font-size:13px;line-height:1.8}.ia-workbench .eyebrow{color:#91e9d1}
        .ia-toolbar,.ia-canvas,.ia-page-detail,.ia-table-wrap,.ia-findings-wrap{max-width:1400px;margin:0 auto 18px;border:1px solid #263347;border-radius:16px;background:#101722;box-shadow:0 8px 28px rgba(0,0,0,.12)}
        .ia-toolbar{padding:18px}
        .ia-url-label{font-size:11px;font-weight:800;display:block;margin-bottom:8px;color:#8493aa}
        .ia-controls{display:flex;gap:10px;align-items:end;flex-wrap:wrap}
        .ia-controls input{flex:1;min-width:250px}
        .ia-controls input,.ia-controls select{height:42px;padding:0 12px;border:1px solid #2d3a4f;border-radius:9px;background:#141c29;color:#eaf1fb;font:inherit;font-size:12px}
        .ia-controls label{display:flex;flex-direction:column;gap:5px;font-size:10px;font-weight:800;color:#65766c}
        .ia-controls .submit-button{height:42px}
        .ia-note{font-size:11px;color:#8493aa;margin:12px 0 0;line-height:1.5}.ia-source-note{flex-basis:100%;margin:0;color:#b7c9d7;font-size:11px;line-height:1.6;padding:10px 12px;background:#141e2b;border:1px solid #2a394a;border-radius:9px}
        .ia-error{max-width:1400px;margin:0 auto 15px;padding:12px 15px;background:#2a1b22;color:#f6a5b4;border:1px solid #633440;border-radius:10px;font-size:12px}
        .ia-sample-note{max-width:1400px;margin:0 auto 12px;font-size:11px;color:#77837a}
        .ia-metrics{max-width:1400px;margin:0 auto 15px;display:flex;gap:10px;align-items:stretch;flex-wrap:wrap}
        .ia-metrics>div{min-width:115px;background:#fff;border:1px solid #2a374b;border-radius:12px;padding:12px 15px;background:#121a26;color:#f3f7fc}
        .ia-metrics strong,.ia-metrics span{display:block}.ia-metrics strong{font-size:20px;font-family:Manrope,sans-serif}.ia-metrics span{font-size:10px;color:#748078;margin-top:4px}
        .ia-origin{align-self:center;margin-left:auto;color:#8493aa;font-size:11px;overflow-wrap:anywhere}
        .ia-canvas{overflow:hidden}
        .ia-canvas-head{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 18px;border-bottom:1px solid #263245;flex-wrap:wrap}
        .ia-canvas-head strong,.ia-canvas-head span{display:block}.ia-canvas-head strong{font-size:13px}.ia-canvas-head span{font-size:10px;color:#8a98ad;margin-top:3px}
        .ia-legend{display:flex;gap:12px;flex-wrap:wrap}.ia-legend span{display:flex;align-items:center;gap:5px}.ia-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}
        .ia-page-detail{padding:18px;display:grid;grid-template-columns:minmax(220px,2fr) repeat(3,minmax(100px,1fr));gap:18px}
        .ia-page-detail h2{font-size:20px;margin:8px 0}.ia-page-detail a{font-size:11px;color:#91e9d1;overflow-wrap:anywhere}
        .ia-page-detail>div>strong,.ia-page-detail>div>span{display:block;font-size:11px;margin-bottom:7px}.ia-page-detail>div>strong{color:#78847b;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
        .ia-kicker{font-size:9px;font-weight:900;letter-spacing:.12em;color:#6b846f}
        .ia-table-wrap{overflow:hidden}.ia-table-scroll{overflow:auto}.ia-table{border-collapse:collapse;width:100%;font-size:11px}.ia-table th,.ia-table td{text-align:left;border-bottom:1px solid #edf0eb;padding:12px 16px;white-space:nowrap}.ia-table th{color:#748078;text-transform:uppercase;font-size:9px;letter-spacing:.08em;background:#141c29}.ia-table a{color:#91e9d1}
        .ia-page-select{border:0;background:transparent;padding:0;color:#b9f2e2;font-weight:800;text-align:left}
        .ia-footer{max-width:1400px;margin:28px auto 0;text-align:right;font-size:9px;letter-spacing:.14em;font-weight:800;color:#758078}.ia-footer span{color:#b6c8b4;margin:0 6px}
        .ia-graph-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid #263245;background:#111925}
        .ia-graph-toolbar input{flex:1;min-width:220px;height:36px;border:1px solid #2b394e;border-radius:8px;background:#151e2c;color:#f1f6fc;padding:0 10px;font-size:11px}
        .ia-graph-toolbar>span{color:#8291a7;font-size:10px}
        .ia-graph-toolbar button,.ia-toggle{border:1px solid #3a6258;border-radius:9px;background:linear-gradient(135deg,#90f1d5,#b5a5ff);color:#0b1720;padding:10px 13px;font-size:11px;font-weight:900}
        .ia-graph-toolbar button:disabled{opacity:.5;cursor:wait}
        .ia-findings-wrap{overflow:hidden}.ia-summary{padding:0 18px;color:#a9b7c9;font-size:12px;line-height:1.7}
        .ia-finding{padding:16px 18px;border-top:1px solid #263245}.ia-finding-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ia-finding-title strong{font-size:12px}
        .ia-finding p{color:#a8b5c8;font-size:12px;line-height:1.7}.ia-finding a{font-size:11px;color:#93e9d0;text-decoration:none}
        .ia-severity,.ia-hypothesis,.ia-confidence{font:9px "DM Mono",monospace;border-radius:999px;padding:5px 7px;border:1px solid #314057;color:#aab8ca}
        .ia-severity.sev-critical,.ia-severity.sev-high{border-color:#6a3c48;background:#2a1920;color:#f3a1b0}
        .ia-severity.sev-medium{border-color:#6b5437;background:#2b2319;color:#e8c18b}.ia-severity.sev-low{border-color:#31534c;background:#142620;color:#98e6ca}
        .ia-hypothesis{border-color:#6553a3;background:#201a36;color:#c1b5ff}.ia-confidence{margin-left:auto}
        .ia-toggle{background:#1a2637;color:#b9c7d8;border-color:#34445b}.ia-page-detail{color:#edf4fc}.ia-page-detail a{color:#91e9d1}
        .ia-table td{color:#d5deeb}.ia-table th{background:#141c29}.ia-canvas-head{border-bottom-color:#263245}.ia-legend{color:#9aa8bd}.ia-graph-toolbar input{flex:1;min-width:220px;height:36px;border:1px solid #2b394e;border-radius:8px;background:#151e2c;color:#f1f6fc;padding:0 10px;font-size:11px}.ia-graph-toolbar>span{color:#8291a7;font-size:10px}.ia-graph-toolbar button,.ia-toggle{border:1px solid #3a6258;border-radius:9px;background:linear-gradient(135deg,#90f1d5,#b5a5ff);color:#0b1720;padding:10px 13px;font-size:11px;font-weight:900}.ia-graph-toolbar button:disabled{opacity:.5;cursor:wait}.ia-findings-wrap{overflow:hidden}.ia-summary{padding:0 18px;color:#a9b7c9;font-size:12px;line-height:1.7}.ia-finding{padding:16px 18px;border-top:1px solid #263245}.ia-finding-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ia-finding-title strong{font-size:12px}.ia-finding p{color:#a8b5c8;font-size:12px;line-height:1.7}.ia-finding a{font-size:11px;color:#93e9d0;text-decoration:none}.ia-severity,.ia-hypothesis,.ia-confidence{font:9px "DM Mono",monospace;border-radius:999px;padding:5px 7px;border:1px solid #314057;color:#aab8ca}.ia-severity.sev-critical,.ia-severity.sev-high{border-color:#6a3c48;background:#2a1920;color:#f3a1b0}.ia-severity.sev-medium{border-color:#6b5437;background:#2b2319;color:#e8c18b}.ia-severity.sev-low{border-color:#31534c;background:#142620;color:#98e6ca}.ia-hypothesis{border-color:#6553a3;background:#201a36;color:#c1b5ff}.ia-confidence{margin-left:auto}.ia-toggle{background:#1a2637;color:#b9c7d8;border-color:#34445b}.ia-page-detail{color:#edf4fc}.ia-page-detail a{color:#91e9d1}.ia-table td{color:#d5deeb}.ia-table th{background:#141c29}.ia-canvas-head{border-bottom-color:#263245}.ia-legend{color:#9aa8bd}
        @media(max-width:750px){.ia-workbench{padding-top:24px}.ia-controls input{min-width:100%}.ia-page-detail{grid-template-columns:1fr 1fr}.ia-origin{margin-left:0;width:100%}}
      `}</style>
    </main>
  );
}
