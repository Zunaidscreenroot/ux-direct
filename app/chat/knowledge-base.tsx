"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

/**
 * Knowledge base page of the command center: view, search, add and edit the UX knowledge
 * every model is given, and preview what a role would receive for a task.
 * File upload and training come later.
 */
type Entry = {
  id: string; title: string; category: string; roles: string[]; domains?: string[]; tags: string[];
  body: string; sources: string[]; pinned?: boolean; origin: "core" | "custom" | "edited"; updatedAt?: string;
};
type LegacyRule = { id: string; title: string; rule: string; scope: string; kind: string; source: string; updatedAt: string };
type LegacyDoc = { id: string; title: string; projectKey: string; sourceType: string; updatedAt: string };
type Payload = {
  entries: Entry[]; hidden: Array<{ id: string; title: string }>; ownerLayer: "ok" | "unavailable";
  legacy: { rules: LegacyRule[]; documents: LegacyDoc[] };
  version: string; categories: Record<string, string>; roles: string[]; domains: string[];
  edit: { allowed: boolean; reason?: string };
};
type Preview = { results: Array<{ id: string; title: string; category: string; score: number | string }>; packedChars: number; preview: string };
type Draft = { id?: string; title: string; category: string; roles: string[]; domains: string[]; tags: string; body: string; sources: string };

const EMPTY_DRAFT: Draft = { title: "", category: "patterns", roles: ["all"], domains: [], tags: "", body: "", sources: "" };
const ORIGIN_LABEL: Record<Entry["origin"], string> = { core: "Core", edited: "Edited", custom: "Added" };

export function KnowledgeBase({ accessHeader, accessKey, onLocked }: { accessHeader: string; accessKey: string; onLocked: (response: Response) => Promise<void> }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [role, setRole] = useState("all");
  const [domain, setDomain] = useState("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testTask, setTestTask] = useState("");
  const [testRole, setTestRole] = useState("");
  const [testDomain, setTestDomain] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);

  const authHeaders = useMemo(() => ({ [accessHeader]: accessKey }), [accessHeader, accessKey]);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/command-center/knowledge", { cache: "no-store", headers: authHeaders });
      if (response.status === 401) { await onLocked(response); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load the knowledge base.");
      setData(payload as Payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the knowledge base.");
    } finally {
      setBusy(false);
    }
  }, [authHeaders, onLocked]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return data.entries.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (role !== "all" && !entry.roles.includes("all") && !entry.roles.includes(role)) return false;
      if (domain !== "all" && !(entry.domains || []).includes(domain)) return false;
      if (!words.length) return true;
      const hay = (entry.title + " " + entry.tags.join(" ") + " " + entry.body + " " + entry.sources.join(" ")).toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }, [data, query, category, role, domain]);

  const counts = useMemo(() => {
    const entries = data?.entries || [];
    return {
      total: entries.length,
      edited: entries.filter((entry) => entry.origin === "edited").length,
      custom: entries.filter((entry) => entry.origin === "custom").length,
      categories: new Set(entries.map((entry) => entry.category)).size,
    };
  }, [data]);

  async function post(body: unknown, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/command-center/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save.");
      setNotice(success);
      setDraft(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(entry?: Entry) {
    setNotice("");
    setDraft(entry ? {
      id: entry.id, title: entry.title, category: entry.category, roles: entry.roles, domains: entry.domains || [],
      tags: entry.tags.join(", "), body: entry.body, sources: entry.sources.join("\n"),
    } : { ...EMPTY_DRAFT });
    window.requestAnimationFrame(() => document.getElementById("ud-kb-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function submitDraft(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const entry = {
      ...(draft.id ? { id: draft.id } : {}),
      title: draft.title.trim(),
      category: draft.category,
      roles: draft.roles.length ? draft.roles : ["all"],
      domains: draft.domains,
      tags: draft.tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 24),
      body: draft.body.trim(),
      sources: draft.sources.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8),
    };
    void post({ action: "save", entry }, draft.id ? "Entry updated. Models use it from the next task." : "Entry added. Models use it from the next task.");
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

  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const label = (id: string) => data?.categories[id] || id;
  const canEdit = data?.edit.allowed === true;

  return <>
    <div className="ud-connections-heading">
      <div><h1>Knowledge base.</h1><p>The UX knowledge every model gets for each task: principles, laws, accessibility, design systems, patterns and industry rules. Search it, test what a task retrieves, and add or edit entries.</p></div>
      <div className="ud-cc-actions">
        <button className="ud-secondary-button" onClick={() => startEdit()} disabled={!canEdit}>Add entry ＋</button>
        <button className="ud-secondary-button" onClick={() => void load()} disabled={busy}>{busy ? "Loading…" : "Refresh ↻"}</button>
      </div>
    </div>
    {error && <div className="ud-chat-error" role="alert">{error}</div>}
    {notice && <div className="ud-kb-notice" role="status">{notice}</div>}
    {data && !canEdit && <div className="ud-cc-lock"><strong>Read-only</strong><p>{data.edit.reason}</p></div>}
    {data?.ownerLayer === "unavailable" && <div className="ud-chat-error" role="alert">Added and edited entries could not be loaded (database unreachable). Showing the core knowledge only.</div>}

    {data && <>
      <div className="ud-cc-stats">
        <div><b>{counts.total}</b><span>Entries in use</span></div>
        <div><b>{counts.categories}</b><span>Categories</span></div>
        <div><b>{counts.edited}</b><span>Edited by you</span></div>
        <div><b>{counts.custom}</b><span>Added by you</span></div>
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
      <p className="ud-kb-hint">{filtered.length} of {data.entries.length} entries · core version {data.version}</p>

      {draft && <form id="ud-kb-editor" className="ud-kb-editor" onSubmit={submitDraft}>
        <h2 className="ud-cc-section">{draft.id ? "Edit entry" : "New entry"}</h2>
        <label>Title<input className="ud-kb-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required minLength={3} maxLength={200} /></label>
        <label>Category<select className="ud-kb-select" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{Object.entries(data.categories).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <fieldset><legend>Who uses it</legend><div className="ud-kb-chips">{["all", ...data.roles].map((item) => <button type="button" key={item} className={"ud-kb-chip" + (draft.roles.includes(item) ? " on" : "")} aria-pressed={draft.roles.includes(item)} onClick={() => setDraft({ ...draft, roles: item === "all" ? ["all"] : toggle(draft.roles.filter((r) => r !== "all"), item) })}>{item}</button>)}</div></fieldset>
        <fieldset><legend>Only for these domains (leave empty for all)</legend><div className="ud-kb-chips">{data.domains.filter((item) => item !== "general").map((item) => <button type="button" key={item} className={"ud-kb-chip" + (draft.domains.includes(item) ? " on" : "")} aria-pressed={draft.domains.includes(item)} onClick={() => setDraft({ ...draft, domains: toggle(draft.domains, item) })}>{item}</button>)}</div></fieldset>
        <label>Tags (comma separated, used for search and retrieval)<input className="ud-kb-input" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="checkout, payment, total" /></label>
        <label>Knowledge (write it as instructions a designer can follow)<textarea className="ud-kb-textarea" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} required minLength={20} maxLength={4000} rows={7} /></label>
        <label>Sources (one per line)<textarea className="ud-kb-textarea" value={draft.sources} onChange={(event) => setDraft({ ...draft, sources: event.target.value })} rows={2} /></label>
        <div className="ud-cc-actions"><button className="ud-secondary-button active" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button><button className="ud-secondary-button" type="button" onClick={() => setDraft(null)}>Cancel</button></div>
      </form>}

      <div className="ud-cc-list">{filtered.map((entry) => <article className="ud-cc-row" key={entry.id}>
        <div className="ud-cc-row-top"><strong>{entry.title}</strong><span className="ud-cc-actions">
          <span className="ud-status-pill muted">{label(entry.category)}</span>
          <span className={"ud-status-pill " + (entry.origin === "core" ? "muted" : "ok")}>{ORIGIN_LABEL[entry.origin]}</span>
        </span></div>
        <p>{entry.body}</p>
        <small>{["for " + entry.roles.join(", "), entry.domains?.length ? "domains: " + entry.domains.join(", ") : "", entry.tags.slice(0, 8).join(", ")].filter(Boolean).join(" · ")}</small>
        {entry.sources.length > 0 && <small>Sources: {entry.sources.join(" · ")}</small>}
        {canEdit && <div className="ud-cc-actions">
          <button className="ud-secondary-button" onClick={() => startEdit(entry)}>Edit</button>
          {entry.origin === "edited" && <button className="ud-secondary-button" disabled={saving} onClick={() => void post({ action: "restore", id: entry.id }, "Original entry restored.")}>Restore original</button>}
          <button className="ud-secondary-button" disabled={saving} onClick={() => { if (window.confirm("Remove “" + entry.title + "” from the knowledge base?")) void post({ action: "remove", id: entry.id }, "Entry removed."); }}>Remove</button>
        </div>}
      </article>)}</div>
      {!filtered.length && <p className="ud-cc-empty">No entries match.</p>}

      {data.hidden.length > 0 && <>
        <h2 className="ud-cc-section">Removed core entries</h2>
        <div className="ud-cc-list">{data.hidden.map((item) => <article className="ud-cc-row" key={item.id}>
          <div className="ud-cc-row-top"><strong>{item.title}</strong>{canEdit && <button className="ud-secondary-button" disabled={saving} onClick={() => void post({ action: "restore", id: item.id }, "Entry restored.")}>Restore</button>}</div>
        </article>)}</div>
      </>}

      <h2 className="ud-cc-section"><button className="ud-kb-link" onClick={() => setShowLegacy(!showLegacy)} aria-expanded={showLegacy}>{showLegacy ? "▾" : "▸"} Learned memories and documents ({data.legacy.rules.length + data.legacy.documents.length})</button></h2>
      {showLegacy && <div className="ud-cc-list">
        {data.legacy.rules.map((rule) => <article className="ud-cc-row" key={rule.id}>
          <div className="ud-cc-row-top"><strong>{rule.title}</strong><span className="ud-status-pill muted">{rule.scope || "shared"}</span></div>
          <p>{rule.rule}</p><small>{[rule.kind, rule.source, rule.updatedAt.slice(0, 10)].filter(Boolean).join(" · ")}</small>
        </article>)}
        {data.legacy.documents.map((doc) => <article className="ud-cc-row" key={doc.id}>
          <div className="ud-cc-row-top"><strong>{doc.title}</strong><span className="ud-status-pill muted">{doc.projectKey || "shared"}</span></div>
          <small>{[doc.sourceType, doc.updatedAt.slice(0, 10)].filter(Boolean).join(" · ")}</small>
        </article>)}
      </div>}
    </>}
  </>;
}
