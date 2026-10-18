"use client";

import { useMemo, useState } from "react";
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
  outbound: number;
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
};
type DiscoveryResult = {
  origin: string; pages: PageRecord[]; pageCount: number;
  failedCount: number; capped: boolean; elapsedMs: number;
};

function PageNode({ data }: NodeProps<SiteNode>) {
  const statusColor = data.status === null ? "#9ca3af" : data.status >= 400 ? "#d97757" : "#4f9569";
  return (
    <div style={{
      width: 230, border: "1px solid #dfe6df", borderRadius: 12, background: "#fff",
      boxShadow: "0 3px 14px rgba(22,49,39,.06)", padding: 12, color: "#182720"
    }}>
      <Handle type="target" position={Position.Left} style={{ background: "#739080", width: 7, height: 7 }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", fontWeight: 800, color: "#65766c", letterSpacing: ".08em" }}>L{data.depth + 1}</span>
        <span style={{ width: 7, height: 7, borderRadius: 10, background: statusColor, display: "inline-block" }} title={data.status === null ? "Not fetched" : "HTTP " + data.status} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.35, overflowWrap: "anywhere" }}>{data.title}</div>
      <div style={{ fontSize: 10, color: "#738078", lineHeight: 1.45, marginTop: 6, overflowWrap: "anywhere" }}>{new URL(data.url).pathname || "/"}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, borderTop: "1px solid #eef1ed", paddingTop: 8, fontSize: 10, color: "#65766c" }}>
        <span>{data.status ?? "Not fetched"}</span><span>{data.outbound} links</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#739080", width: 7, height: 7 }} />
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
  const levelCounts = new Map<number, number>();
  const sorted = [...pages].sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title));
  const nodes: SiteNode[] = sorted.map((page) => {
    const index = levelCounts.get(page.depth) ?? 0;
    levelCounts.set(page.depth, index + 1);
    return {
      id: page.id,
      type: "page",
      position: { x: 30 + page.depth * 295, y: 25 + index * 165 },
      data: {
        title: page.title,
        url: page.url,
        depth: page.depth,
        status: page.status,
        outbound: page.links?.length ?? 0,
        sample: page.id.startsWith("sample-")
      }
    };
  });
  const pageIds = new Map(sorted.map((page) => [page.url, page.id]));
  const edges: Edge[] = sorted.flatMap((page) => {
    if (!page.parentUrl || !pageIds.has(page.parentUrl)) return [];
    return [{
      id: "edge-" + pageIds.get(page.parentUrl) + "-" + page.id,
      source: pageIds.get(page.parentUrl)!,
      target: page.id,
      type: "smoothstep",
      animated: false,
      style: { stroke: "#99b5a3", strokeWidth: 1.5 }
    }];
  });
  return { nodes, edges };
}

export default function IADemoPage() {
  const [url, setUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState("3");
  const [maxPages, setMaxPages] = useState("18");
  const [pages, setPages] = useState<PageRecord[]>(samplePages);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedPage, setSelectedPage] = useState<PageRecord | null>(null);
  const graph = useMemo(() => buildGraph(pages), [pages]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SiteNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graph.edges);

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

  return (
    <main className="ia-workbench">
      <header className="ia-head">
        <div>
          <Link href="/" className="ia-back">← UX Direct cockpit</Link>
          <div className="eyebrow" style={{ marginTop: 24 }}><span className="pulse" /> INFORMATION ARCHITECTURE</div>
          <h1>See the site as a <em>structure.</em></h1>
          <p className="intro">Discover a bounded set of same-origin pages, then inspect the page hierarchy and navigation relationships in an interactive map.</p>
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
              <option value="8">8</option><option value="18">18</option><option value="30">30</option>
            </select>
          </label>
          <button className="submit-button" type="submit" disabled={busy}>{busy ? "Discovering…" : "Discover IA →"}</button>
        </div>
        <p className="ia-note">The deployed crawler is deliberately bounded and same-origin. It reads public HTML only; JavaScript-only pages may expose fewer links. It does not use Playwright or Cloudflare Browser Run.</p>
      </form>

      {error ? <div className="ia-error" role="alert">{error}</div> : null}
      {result ? (
        <div className="ia-metrics">
          <div><strong>{result.pageCount}</strong><span>pages mapped</span></div>
          <div><strong>{result.failedCount}</strong><span>failed / non-HTML</span></div>
          <div><strong>{(result.elapsedMs / 1000).toFixed(1)}s</strong><span>crawl time</span></div>
          <div><strong>{result.capped ? "Capped" : "Complete"}</strong><span>crawl status</span></div>
          <span className="ia-origin">{result.origin}</span>
        </div>
      ) : (
        <div className="ia-sample-note">Sample map only — no live site has been crawled yet.</div>
      )}

      <section className="ia-canvas" aria-label="Interactive website information architecture">
        <div className="ia-canvas-head">
          <div><strong>IA map</strong><span>Drag nodes · zoom · pan · select a page</span></div>
          <div className="ia-legend"><span><i style={{ background: "#4f9569" }} /> HTTP 2xx/3xx</span><span><i style={{ background: "#d97757" }} /> HTTP error</span></div>
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

      {selectedPage ? (
        <section className="ia-page-detail">
          <div><span className="ia-kicker">SELECTED PAGE</span><h2>{selectedPage.title}</h2><a href={selectedPage.url} target="_blank" rel="noreferrer">{selectedPage.url}</a></div>
          <div><strong>Depth</strong><span>L{selectedPage.depth + 1}</span></div>
          <div><strong>HTTP status</strong><span>{selectedPage.status ?? "Not fetched"}</span></div>
          <div><strong>H1–H6 headings</strong>{selectedPage.headings?.length ? selectedPage.headings.slice(0, 8).map((heading, i) => <span key={i}>{heading}</span>) : <span>No headings extracted</span>}</div>
        </section>
      ) : null}

      {result ? (
        <section className="ia-table-wrap">
          <div className="ia-canvas-head"><div><strong>Discovered pages</strong><span>Sorted by level, then title</span></div></div>
          <div className="ia-table-scroll"><table className="ia-table"><thead><tr><th>Level</th><th>Page</th><th>URL</th><th>Status</th><th>Headings</th></tr></thead>
            <tbody>{pages.map((page) => <tr key={page.id}>
              <td>L{page.depth + 1}</td><td><button type="button" className="ia-page-select" onClick={() => setSelectedPage(page)}>{page.title}</button></td>
              <td><a href={page.url} target="_blank" rel="noreferrer">{new URL(page.url).pathname || "/"}</a></td>
              <td>{page.status ?? "Failed"}</td><td>{page.headings?.length ?? 0}</td>
            </tr>)}</tbody></table></div>
        </section>
      ) : null}
      <footer className="ia-footer">UX DIRECT <span>·</span> IA DISCOVERY / INTERACTIVE MAP</footer>

      <style jsx global>{`
        .ia-workbench{min-height:100vh;background:#fbfcfa;color:#17211f;padding:42px clamp(18px,4vw,64px) 28px}
        .ia-head{max-width:1400px;margin:0 auto 28px}
        .ia-back{color:#466956;text-decoration:none;font-size:12px;font-weight:800}
        .ia-workbench h1{font-family:Manrope,sans-serif;font-size:clamp(32px,4vw,48px);line-height:1.08;letter-spacing:-1.8px;margin:0 0 14px}
        .ia-toolbar,.ia-canvas,.ia-page-detail,.ia-table-wrap{max-width:1400px;margin:0 auto 18px;border:1px solid #e4e9e3;border-radius:16px;background:#fff;box-shadow:0 4px 20px rgba(28,55,42,.035)}
        .ia-toolbar{padding:18px}
        .ia-url-label{font-size:11px;font-weight:800;display:block;margin-bottom:8px;color:#65766c}
        .ia-controls{display:flex;gap:10px;align-items:end;flex-wrap:wrap}
        .ia-controls input{flex:1;min-width:250px}
        .ia-controls input,.ia-controls select{height:42px;padding:0 12px;border:1px solid #dfe6df;border-radius:9px;background:#fff;color:#17211f;font:inherit;font-size:12px}
        .ia-controls label{display:flex;flex-direction:column;gap:5px;font-size:10px;font-weight:800;color:#65766c}
        .ia-controls .submit-button{height:42px}
        .ia-note{font-size:11px;color:#748078;margin:12px 0 0;line-height:1.5}
        .ia-error{max-width:1400px;margin:0 auto 15px;padding:12px 15px;background:#fff3ef;color:#963f2c;border:1px solid #f0c7bc;border-radius:10px;font-size:12px}
        .ia-sample-note{max-width:1400px;margin:0 auto 12px;font-size:11px;color:#77837a}
        .ia-metrics{max-width:1400px;margin:0 auto 15px;display:flex;gap:10px;align-items:stretch;flex-wrap:wrap}
        .ia-metrics>div{min-width:115px;background:#fff;border:1px solid #e4e9e3;border-radius:12px;padding:12px 15px}
        .ia-metrics strong,.ia-metrics span{display:block}.ia-metrics strong{font-size:20px;font-family:Manrope,sans-serif}.ia-metrics span{font-size:10px;color:#748078;margin-top:4px}
        .ia-origin{align-self:center;margin-left:auto;color:#758078;font-size:11px;overflow-wrap:anywhere}
        .ia-canvas{overflow:hidden}
        .ia-canvas-head{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 18px;border-bottom:1px solid #edf0eb;flex-wrap:wrap}
        .ia-canvas-head strong,.ia-canvas-head span{display:block}.ia-canvas-head strong{font-size:13px}.ia-canvas-head span{font-size:10px;color:#79847b;margin-top:3px}
        .ia-legend{display:flex;gap:12px;flex-wrap:wrap}.ia-legend span{display:flex;align-items:center;gap:5px}.ia-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}
        .ia-page-detail{padding:18px;display:grid;grid-template-columns:minmax(220px,2fr) repeat(3,minmax(100px,1fr));gap:18px}
        .ia-page-detail h2{font-size:20px;margin:8px 0}.ia-page-detail a{font-size:11px;color:#456f54;overflow-wrap:anywhere}
        .ia-page-detail>div>strong,.ia-page-detail>div>span{display:block;font-size:11px;margin-bottom:7px}.ia-page-detail>div>strong{color:#78847b;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
        .ia-kicker{font-size:9px;font-weight:900;letter-spacing:.12em;color:#6b846f}
        .ia-table-wrap{overflow:hidden}.ia-table-scroll{overflow:auto}.ia-table{border-collapse:collapse;width:100%;font-size:11px}.ia-table th,.ia-table td{text-align:left;border-bottom:1px solid #edf0eb;padding:12px 16px;white-space:nowrap}.ia-table th{color:#748078;text-transform:uppercase;font-size:9px;letter-spacing:.08em;background:#fafbf9}.ia-table a{color:#4d725b}
        .ia-page-select{border:0;background:transparent;padding:0;color:#234c37;font-weight:800;text-align:left}
        .ia-footer{max-width:1400px;margin:28px auto 0;text-align:right;font-size:9px;letter-spacing:.14em;font-weight:800;color:#758078}.ia-footer span{color:#b6c8b4;margin:0 6px}
        @media(max-width:750px){.ia-workbench{padding-top:24px}.ia-controls input{min-width:100%}.ia-page-detail{grid-template-columns:1fr 1fr}.ia-origin{margin-left:0;width:100%}}
      `}</style>
    </main>
  );
}
