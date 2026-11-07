"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Knowledge base page of the command center: view and search the UX knowledge every model
 * is given, and preview what a role would receive for a task. Read-only for now (owner,
 * 2026-11-07): no add/edit/remove UI; the POST route stays dormant for later.
 * Entries load a few at a time; "View more" fetches the next page.
 */
type Entry = {
  id: string; title: string; category: string; roles: string[]; domains?: string[]; tags: string[];
  body: string; sources: string[]; pinned?: boolean; origin: "core" | "custom" | "edited"; updatedAt?: string;
};
type LegacyRule = { id: string; title: string; rule: string; scope: string; kind: string; source: string; updatedAt: string };
type LegacyDoc = { id: string; title: string; projectKey: string; sourceType: string; updatedAt: string };
type Legacy = { rules: LegacyRule[]; documents: LegacyDoc[] };
type Payload = {
  items: Entry[]; total: number; nextOffset: number | null;
  counts: { entries: number; categories: number };
  version: string; categories: Record<string, string>; roles: string[]; domains: string[];
};
type Preview = { results: Array<{ id: string; title: string; category: string; score: number | string }>; packedChars: number; preview: string };

const PAGE_SIZE = 6;
const ORIGIN_LABEL: Record<Entry["origin"], string> = { core: "Core", edited: "Edited", custom: "Added" };

export function KnowledgeBase({ accessHeader, accessKey, onLocked }: { accessHeader: string; accessKey: string; onLocked: (response: Response) => Promise<void> }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [role, setRole] = useState("all");
  const [domain, setDomain] = useState("all");
  const [testTask, setTestTask] = useState("");
  const [testRole, setTestRole] = useState("");
  const [testDomain, setTestDomain] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);
  const [legacy, setLegacy] = useState<Legacy | null>(null);
  const requestId = useRef(0);

  const authHeaders = useMemo(() => ({ [accessHeader]: accessKey }), [accessHeader, accessKey]);

  // Debounce typing so search does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (offset = 0) => {
    const id = ++requestId.current;
    if (offset) setMoreBusy(true); else setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
      if (search) params.set("search", search);
      if (category !== "all") params.set("category", category);
      if (role !== "all") params.set("role", role);
      if (domain !== "all") params.set("domain", domain);
      const response = await fetch("/api/command-center/knowledge?" + params.toString(), { cache: "no-store", headers: authHeaders });
      if (response.status === 401) { await onLocked(response); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load the knowledge base.");
      if (id !== requestId.current) return;
      setData((current) => offset && current ? { ...(payload as Payload), items: [...current.items, ...(payload as Payload).items] } : payload as Payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the knowledge base.");
    } finally {
      if (offset) setMoreBusy(false); else setBusy(false);
    }
  }, [authHeaders, onLocked, search, category, role, domain]);

  useEffect(() => { void load(0); }, [load]);

  async function toggleLegacy() {
    const next = !showLegacy;
    setShowLegacy(next);
    if (!next || legacy) return;
    try {
      const response = await fetch("/api/command-center/knowledge?legacy=1", { cache: "no-store", headers: authHeaders });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load learned memories.");
      setLegacy(payload as Legacy);
    } catch (legacyError) {
      setError(legacyError instanceof Error ? legacyError.message : "Could not load learned memories.");
    }
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!testTask.trim()) return;
    setPreview(null);
    const params = new URLSearchParams({ q: testTask.trim() });
    if (testRole) params.set("role", testRole);
    if (testDomain) params.set("domain", testDomain);
    try {
      const response = await fetch("/api/command-center/knowledge?" + params.toString(), { cache: "no-store", headers: authHeaders });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Preview failed.");
      setPreview(payload as Preview);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Preview failed.");
    }
  }

  const label = (id: string) => data?.categories[id] || id;

  return <>
    <div className="ud-connections-heading">
      <div><h1>Knowledge base.</h1><p>The UX knowledge every model gets for each task: principles, laws, accessibility, design systems, patterns and industry rules. Search it and test what a task retrieves.</p></div>
      <div className="ud-cc-actions">
        <button className="ud-secondary-button" onClick={() => void load(0)} disabled={busy}>{busy ? "Loading…" : "Refresh ↻"}</button>
      </div>
    </div>
    {error && <div className="ud-chat-error" role="alert">{error}</div>}

    {data && <>
      <div className="ud-cc-stats">
        <div><b>{data.counts.entries}</b><span>Entries in use</span></div>
        <div><b>{data.counts.categories}</b><span>Categories</span></div>
      </div>

      <form className="ud-kb-test" onSubmit={runPreview}>
        <h2 className="ud-cc-section">Test retrieval</h2>
        <p className="ud-kb-hint">Type a task to see which entries a model would get. Role and domain are optional; the plugin detects them itself.</p>
        <div className="ud-kb-row">
          <input className="ud-kb-input" value={testTask} onChange={(event) => setTestTask(event.target.value)} placeholder="e.g. improve this loan EMI dashboard" aria-label="Task to test" />
          <select className="ud-kb-select" value={testRole} onChange={(event) => setTestRole(event.target.value)} aria-label="Role"><option value="">Any role</option>{data.roles.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <select className="ud-kb-select" value={testDomain} onChange={(event) => setTestDomain(event.target.value)} aria-label="Domain"><option value="">Auto domain</option>{data.domains.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <button className="ud-secondary-button" type="submit">Test</button>
        </div>
        {preview && <div className="ud-cc-list">
          <article className="ud-cc-row"><small>{preview.results.length} entries · {preview.packedChars} characters sent</small>
            <p>{preview.results.map((item, index) => (index + 1) + ". " + item.title).join("   ")}</p>
            <details><summary className="ud-kb-hint">Show exactly what the model reads</summary><pre className="ud-kb-preview">{preview.preview}</pre></details>
          </article>
        </div>}
      </form>

      <h2 className="ud-cc-section">Browse</h2>
      <div className="ud-kb-row">
        <input className="ud-kb-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, tags, text or source" aria-label="Search knowledge" />
        <select className="ud-kb-select" value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category"><option value="all">All categories</option>{Object.entries(data.categories).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select className="ud-kb-select" value={role} onChange={(event) => setRole(event.target.value)} aria-label="Role filter"><option value="all">All roles</option>{data.roles.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <select className="ud-kb-select" value={domain} onChange={(event) => setDomain(event.target.value)} aria-label="Domain filter"><option value="all">All domains</option>{data.domains.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      </div>
      <p className="ud-kb-hint">{data.total} of {data.counts.entries} entries{data.total > data.items.length ? " · showing " + data.items.length : ""} · core version {data.version}</p>

      <div className="ud-cc-list">{data.items.map((entry) => <article className="ud-cc-row" key={entry.id}>
        <div className="ud-cc-row-top"><strong>{entry.title}</strong><span className="ud-cc-actions">
          <span className="ud-status-pill muted">{label(entry.category)}</span>
          <span className={"ud-status-pill " + (entry.origin === "core" ? "muted" : "ok")}>{ORIGIN_LABEL[entry.origin]}</span>
        </span></div>
        <p>{entry.body}</p>
        <small>{["for " + entry.roles.join(", "), entry.domains?.length ? "domains: " + entry.domains.join(", ") : "", entry.tags.slice(0, 8).join(", ")].filter(Boolean).join(" · ")}</small>
        {entry.sources.length > 0 && <small>Sources: {entry.sources.join(" · ")}</small>}
      </article>)}</div>
      {!data.items.length && <p className="ud-cc-empty">{busy ? "Loading…" : "No entries match."}</p>}
      {data.nextOffset !== null && <div className="ud-cc-more"><button className="ud-secondary-button" onClick={() => void load(data.nextOffset || 0)} disabled={moreBusy}>{moreBusy ? "Loading…" : "View more (" + (data.total - data.items.length) + " more) ▾"}</button></div>}

      <h2 className="ud-cc-section"><button className="ud-kb-link" onClick={toggleLegacy} aria-expanded={showLegacy}>{showLegacy ? "▾" : "▸"} Learned memories and documents {legacy ? "(" + (legacy.rules.length + legacy.documents.length) + ")" : ""}</button></h2>
      {showLegacy && !legacy && <p className="ud-cc-empty">Loading…</p>}
      {showLegacy && legacy && <div className="ud-cc-list">
        {legacy.rules.map((rule) => <article className="ud-cc-row" key={rule.id}>
          <div className="ud-cc-row-top"><strong>{rule.title}</strong><span className="ud-status-pill muted">{rule.scope || "shared"}</span></div>
          <p>{rule.rule}</p><small>{[rule.kind, rule.source, rule.updatedAt.slice(0, 10)].filter(Boolean).join(" · ")}</small>
        </article>)}
        {legacy.documents.map((doc) => <article className="ud-cc-row" key={doc.id}>
          <div className="ud-cc-row-top"><strong>{doc.title}</strong><span className="ud-status-pill muted">{doc.projectKey || "shared"}</span></div>
          <small>{[doc.sourceType, doc.updatedAt.slice(0, 10)].filter(Boolean).join(" · ")}</small>
        </article>)}
      </div>}
    </>}
  </>;
}
