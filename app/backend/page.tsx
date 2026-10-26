"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackendStatus } from "@/src/backend/status";
import { NODE_H, NODE_W, buildGraph, edgePath, eventMatchesNode, type GraphNode, type LogEvent, type NodeHealth } from "./graph";

const REFRESH_MS = 8000;
const HEALTH_LABEL: Record<NodeHealth, string> = { ok: "Healthy", warn: "Attention", down: "Down", unknown: "Unknown" };
const POSITIONS_KEY = "uxd-backend-node-positions";

function loadPositions(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(window.localStorage.getItem(POSITIONS_KEY) || "{}") as Record<string, { x: number; y: number }>; } catch { return {}; }
}
function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false }) + " · " + date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function BackendPage() {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [paused, setPaused] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("backend");
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [scopeToNode, setScopeToNode] = useState(false);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => { setPositions(loadPositions()); }, []);

  const refresh = useCallback(async () => {
    try {
      const [statusResponse, eventResponse] = await Promise.all([
        fetch("/api/backend/status", { cache: "no-store" }),
        fetch("/api/telemetry?limit=200", { cache: "no-store" }),
      ]);
      if (!statusResponse.ok) throw new Error("Status request failed (HTTP " + statusResponse.status + ").");
      setStatus(await statusResponse.json() as BackendStatus);
      if (eventResponse.ok) setEvents(((await eventResponse.json()) as { events?: LogEvent[] }).events ?? []);
      setError("");
      setUpdatedAt(new Date().toLocaleTimeString([], { hour12: false }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not reach the backend.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (paused) return;
    const timer = window.setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, paused]);

  const graph = useMemo(() => buildGraph(status), [status]);
  const nodes = useMemo(() => graph.nodes.map((node) => ({ ...node, ...(positions[node.id] ?? {}) })), [graph, positions]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = byId.get(selectedId) ?? nodes[0];

  const onPointerDown = (event: React.PointerEvent, node: GraphNode) => {
    const box = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { id: node.id, dx: event.clientX - box.left - node.x, dy: event.clientY - box.top - node.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSelectedId(node.id);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const box = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(1180 - NODE_W, event.clientX - box.left - current.dx));
    const y = Math.max(0, Math.min(500 - NODE_H, event.clientY - box.top - current.dy));
    setPositions((previous) => ({ ...previous, [current.id]: { x, y } }));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try { window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions)); } catch { /* optional */ }
  };
  const resetLayout = () => {
    setPositions({});
    try { window.localStorage.removeItem(POSITIONS_KEY); } catch { /* optional */ }
  };

  const visibleEvents = useMemo(() => events.filter((event) => {
    if (statusFilter !== "all" && event.status !== statusFilter) return false;
    if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
    if (scopeToNode && selected && !eventMatchesNode(event, selected.logMatch)) return false;
    if (query && !(event.event + " " + event.summary + " " + (event.action ?? "")).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [events, statusFilter, sourceFilter, query, scopeToNode, selected]);

  const recentAgeMs = (id: string) => {
    const node = byId.get(id);
    if (!node) return Infinity;
    const hit = events.find((event) => eventMatchesNode(event, node.logMatch));
    return hit ? Date.now() - Date.parse(hit.at) : Infinity;
  };

  return (
    <main className="bk">
      <style>{CSS}</style>
      <header className="bk-top">
        <div>
          <h1>UX Direct · Backend</h1>
          <p>Live map of everything connected to the central brain, with the activity behind it.</p>
        </div>
        <div className="bk-actions">
          <span className={"bk-pill " + (error ? "down" : "ok")}><i />{error ? "Backend unreachable" : "Live"}</span>
          <span className="bk-muted">{updatedAt ? "Updated " + updatedAt : ""}</span>
          <button onClick={() => setPaused((value) => !value)}>{paused ? "Resume" : "Pause"}</button>
          <button onClick={() => void refresh()}>Refresh</button>
          <button onClick={resetLayout}>Reset layout</button>
        </div>
      </header>
      {error ? <div className="bk-error" role="alert">{error}</div> : null}

      <section className="bk-canvas-wrap" aria-label="Connection graph">
        <div className="bk-canvas" style={{ width: 1180, height: 500 }}>
          <svg width={1180} height={500} className="bk-edges" aria-hidden="true">
            {graph.edges.map((edge) => {
              const from = byId.get(edge.from), to = byId.get(edge.to);
              if (!from || !to) return null;
              const hot = edge.active && (recentAgeMs(edge.from) < 60000 || recentAgeMs(edge.to) < 60000);
              return <path key={edge.id} d={edgePath(from, to)} className={"bk-edge " + (edge.active ? "active" : "idle") + (hot ? " hot" : "")} />;
            })}
          </svg>
          {nodes.map((node) => (
            <div
              key={node.id} role="button" tabIndex={0} aria-pressed={selectedId === node.id}
              className={"bk-node " + node.health + (selectedId === node.id ? " selected" : "")}
              style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
              onPointerDown={(event) => onPointerDown(event, node)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(node.id); }}
            >
              <span className="bk-kind">{node.kind}</span>
              <strong>{node.label}</strong>
              <span className="bk-summary"><i />{node.summary}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="bk-grid">
        <aside className="bk-detail" aria-label="Selected node">
          {selected ? (
            <>
              <span className={"bk-pill " + selected.health}><i />{HEALTH_LABEL[selected.health]}</span>
              <h2>{selected.label}</h2>
              <p className="bk-muted">{selected.kind}</p>
              <p>{selected.summary}</p>
              <p className="bk-muted">{selected.detail}</p>
              <button onClick={() => setScopeToNode((value) => !value)}>{scopeToNode ? "Show all activity" : "Show only this node's activity"}</button>
            </>
          ) : null}
        </aside>
        <section className="bk-log" aria-label="Activity log">
          <div className="bk-log-head">
            <h2>Activity &amp; logs <span className="bk-muted">{visibleEvents.length} of {events.length}</span></h2>
            <div className="bk-filters">
              <input placeholder="Search events" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search events" />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status">
                <option value="all">All status</option><option value="success">Success</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option>
              </select>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} aria-label="Filter by source">
                <option value="all">All sources</option><option value="backend">Backend</option><option value="figma-plugin">Figma plugin</option><option value="dashboard">Dashboard</option>
              </select>
            </div>
          </div>
          <div className="bk-rows" role="log">
            {visibleEvents.length === 0 ? <p className="bk-empty">No events match. Run a generation in the plugin and it will show up here.</p> : null}
            {visibleEvents.map((event) => (
              <div key={event.id} className={"bk-row " + event.status}>
                <i className="bk-dot" />
                <div>
                  <div className="bk-row-top">
                    <strong>{event.event}</strong>
                    <span className="bk-tag">{event.source}</span>
                    {event.action ? <span className="bk-tag">{event.action}</span> : null}
                    {typeof event.durationMs === "number" ? <span className="bk-tag">{event.durationMs >= 1000 ? (event.durationMs / 1000).toFixed(1) + "s" : event.durationMs + "ms"}</span> : null}
                  </div>
                  <div className="bk-row-sum">{event.summary}</div>
                </div>
                <time>{clock(event.at)}</time>
              </div>
            ))}
          </div>
          <p className="bk-foot">Logs are kept in memory and mirrored to R2 (last 300). They contain event summaries only, never prompts, keys or design content.</p>
        </section>
      </section>
    </main>
  );
}

const CSS = `
.bk{min-height:100vh;background:#0f1115;color:#e8eaee;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px 20px 40px}
.bk h1{font-size:20px;margin:0}.bk h2{font-size:15px;margin:0 0 6px}.bk p{margin:4px 0}
.bk-top{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.bk-top p,.bk-muted{color:#9aa1ad;font-size:12px}
.bk-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bk button{background:#1a1e26;color:#e8eaee;border:1px solid #2c323d;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
.bk button:hover{background:#232834}.bk button:focus-visible,.bk-node:focus-visible,.bk input:focus-visible,.bk select:focus-visible{outline:2px solid #6ea8fe;outline-offset:2px}
.bk-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:600;border:1px solid #2c323d;background:#171b22}
.bk-pill i,.bk-summary i,.bk-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#6b7280;flex:0 0 auto}
.bk-pill.ok i,.bk-node.ok .bk-summary i{background:#3ecf8e}.bk-pill.warn i,.bk-node.warn .bk-summary i{background:#f5b84b}
.bk-pill.down i,.bk-node.down .bk-summary i{background:#f26b6b}
.bk-error{background:#3a1d1f;border:1px solid #7a2e33;color:#ffb4b4;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px}
.bk-canvas-wrap{overflow:auto;border:1px solid #232834;border-radius:14px;background:#12151b;background-image:radial-gradient(#242a35 1px,transparent 1px);background-size:20px 20px}
.bk-canvas{position:relative}.bk-edges{position:absolute;inset:0;pointer-events:none}
.bk-edge{fill:none;stroke:#3a4150;stroke-width:2}.bk-edge.active{stroke:#4f7cff}
.bk-edge.active{stroke-dasharray:6 6;animation:bk-flow 1.2s linear infinite}.bk-edge.hot{stroke:#3ecf8e;stroke-width:2.5}
@keyframes bk-flow{to{stroke-dashoffset:-12}}
@media (prefers-reduced-motion:reduce){.bk-edge.active{animation:none}}
.bk-node{position:absolute;box-sizing:border-box;background:#1a1e26;border:1px solid #2c323d;border-left:4px solid #6b7280;border-radius:12px;padding:8px 12px;cursor:grab;user-select:none;touch-action:none;display:flex;flex-direction:column;justify-content:center;gap:2px;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.bk-node:active{cursor:grabbing}.bk-node.ok{border-left-color:#3ecf8e}.bk-node.warn{border-left-color:#f5b84b}.bk-node.down{border-left-color:#f26b6b}
.bk-node.selected{border-color:#6ea8fe;box-shadow:0 0 0 2px rgba(110,168,254,.35),0 4px 14px rgba(0,0,0,.35)}
.bk-kind{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8a92a0}.bk-node strong{font-size:13px}
.bk-summary{display:flex;align-items:center;gap:6px;font-size:11px;color:#b6bcc8;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.bk-grid{display:grid;grid-template-columns:minmax(240px,300px) 1fr;gap:14px;margin-top:14px}
@media (max-width:820px){.bk-grid{grid-template-columns:1fr}}
.bk-detail,.bk-log{background:#171b22;border:1px solid #232834;border-radius:14px;padding:14px}
.bk-log-head{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;margin-bottom:8px}
.bk-filters{display:flex;flex-wrap:wrap;gap:6px}
.bk input,.bk select{background:#12151b;color:#e8eaee;border:1px solid #2c323d;border-radius:8px;padding:6px 8px;font-size:12px}
.bk-rows{max-height:420px;overflow:auto;border-top:1px solid #232834}
.bk-row{display:grid;grid-template-columns:10px 1fr auto;gap:10px;padding:9px 2px;border-bottom:1px solid #20252f;align-items:start}
.bk-row .bk-dot{margin-top:6px}.bk-row.success .bk-dot{background:#3ecf8e}.bk-row.warning .bk-dot{background:#f5b84b}.bk-row.error .bk-dot{background:#f26b6b}.bk-row.info .bk-dot{background:#4f7cff}
.bk-row-top{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.bk-row-sum{color:#b6bcc8;font-size:12px;overflow-wrap:anywhere}
.bk-tag{font-size:10px;border:1px solid #2c323d;border-radius:6px;padding:0 6px;color:#9aa1ad}.bk-row time{font-size:11px;color:#8a92a0;white-space:nowrap}
.bk-empty{color:#8a92a0;padding:16px 4px}.bk-foot{color:#7b8392;font-size:11px;margin-top:10px}
`;
