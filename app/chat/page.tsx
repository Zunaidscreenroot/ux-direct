"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import "./chat.css";
import { ThinkingOrb } from "thinking-orbs";
import { MarkdownContent } from "@/src/components/markdown-content";

/**
 * UX Direct command center: a chat scoped to UX Direct data, the shared knowledge
 * brain, and the last 7 days of Figma plugin activity. Everything else (audits, IA,
 * benchmarking) was removed; new sections are added under "Coming next".
 */
type Role = "user" | "assistant";
type ChatMessage = { id: string; role: Role; content: string; model?: string };
type Tab = "chat" | "knowledge" | "activity";
type ServiceStatus = { connected: boolean; provider?: string; defaultModel?: string; providerId?: string; error?: string };
type ActivityItem = {
  id: string; at: string; title: string; request: string;
  outcome: "attempted" | "succeeded" | "verified" | "failed" | "unknown";
  durationMs: number | null; model: string | null; summary: string; error: string; projectKey: string;
};
type ActivityPayload = {
  items: ActivityItem[];
  summary: { windowDays: number; total: number; byOutcome: Record<ActivityItem["outcome"], number>; byDay: Array<{ day: string; count: number }> };
};
type KnowledgePayload = {
  rules: Array<{ id: string; title: string; rule: string; scope: string; kind: string; source: string; status: string; updatedAt: string }>;
  documents: Array<{ id: string; title: string; projectKey: string; sourceType: string; status: string; updatedAt: string }>;
};

const HISTORY_KEY = "ux-direct-command-chat-v1";
const ACCESS_KEY_STORAGE = "ux-direct-command-key";
const ACCESS_HEADER = "X-UXD-Command-Key";
const TABS: Array<{ id: Tab; label: string; glyph: string }> = [
  { id: "chat", label: "Chat", glyph: "◌" },
  { id: "knowledge", label: "Shared knowledge", glyph: "✦" },
  { id: "activity", label: "Plugin activity", glyph: "⌁" },
];
// Skeleton only: planned command-center sections, not implemented yet.
const COMING_NEXT = ["Context files", "Brain training", "Quality reports"];
const OUTCOME_LABEL: Record<ActivityItem["outcome"], string> = { verified: "Verified", succeeded: "Succeeded", attempted: "In progress", failed: "Failed", unknown: "Unknown" };

function readStorage(key: string): string {
  try { return window.localStorage.getItem(key) || ""; } catch { return ""; }
}
function writeStorage(key: string, value: string) {
  try { if (value) window.localStorage.setItem(key, value); else window.localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function CommandCenter() {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [accessKey, setAccessKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [locked, setLocked] = useState<{ message: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [activity, setActivity] = useState<ActivityPayload | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgePayload | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataError, setDataError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setAccessKey(readStorage(ACCESS_KEY_STORAGE));
    try {
      const parsed = JSON.parse(readStorage(HISTORY_KEY) || "[]") as ChatMessage[];
      if (Array.isArray(parsed)) setMessages(parsed.filter((m) => m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-100));
    } catch { /* Ignore stale history. */ }
    const hash = window.location.hash.replace("#", "");
    if (TABS.some((tab) => tab.id === hash)) setActiveTab(hash as Tab);
    setHistoryReady(true);
    fetch("/api/assistant/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<ServiceStatus>)
      .then(setStatus)
      .catch(() => setStatus({ connected: false, error: "Could not reach the UX Direct status endpoint." }));
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => { if (historyReady) writeStorage(HISTORY_KEY, JSON.stringify(messages.slice(-100))); }, [messages, historyReady]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth", block: "end" }); }, [messages, busy]);

  const handleLocked = useCallback(async (response: Response) => {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    setLocked({ message: payload.error || "Command center access key is required." });
  }, []);

  const loadView = useCallback(async (view: "activity" | "knowledge") => {
    setDataBusy(true);
    setDataError("");
    try {
      const response = await fetch("/api/command-center?view=" + view, { cache: "no-store", headers: { [ACCESS_HEADER]: accessKey } });
      if (response.status === 401 || response.status === 503 && (await response.clone().json().catch(() => ({}))).locked) { await handleLocked(response); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load " + view + ".");
      setLocked(null);
      if (view === "activity") setActivity(payload as ActivityPayload); else setKnowledge(payload as KnowledgePayload);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Could not load data.");
    } finally {
      setDataBusy(false);
    }
  }, [accessKey, handleLocked]);

  useEffect(() => {
    if (!historyReady) return;
    if (activeTab === "activity" && !activity) void loadView("activity");
    if (activeTab === "knowledge" && !knowledge) void loadView("knowledge");
  }, [activeTab, historyReady, activity, knowledge, loadView]);

  function navigate(next: Tab) {
    setActiveTab(next);
    setMobileNavOpen(false);
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#" + next);
  }

  function unlock(event: FormEvent) {
    event.preventDefault();
    const value = keyDraft.trim();
    if (!value) return;
    writeStorage(ACCESS_KEY_STORAGE, value);
    setAccessKey(value);
    setKeyDraft("");
    setLocked(null);
    setActivity(null);
    setKnowledge(null);
  }

  function newChat() {
    abortRef.current?.abort();
    setBusy(false);
    setChatError("");
    setMessages([]);
    setDraft("");
    navigate("chat");
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }

  async function sendText(value?: string) {
    const text = (value ?? draft).trim();
    if (!text || busy) return;
    const conversation = [...messages, { id: crypto.randomUUID(), role: "user" as const, content: text }];
    const assistantId = crypto.randomUUID();
    setMessages([...conversation, { id: assistantId, role: "assistant", content: "" }]);
    setDraft("");
    setChatError("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", [ACCESS_HEADER]: accessKey },
        body: JSON.stringify({ mode: "command-center", messages: conversation.map(({ role, content }) => ({ role, content })) }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 503 && response.headers.get("content-type")?.includes("json") && (await response.clone().json().catch(() => ({}))).locked) {
        await handleLocked(response);
        setMessages(conversation);
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "Chat returned HTTP " + response.status + ".");
      }
      if (!response.body) throw new Error("The model response stream was empty.");
      const model = response.headers.get("X-UXD-Model") || undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            fullText += delta;
            setMessages([...conversation, { id: assistantId, role: "assistant", content: fullText, model }]);
          }
        } catch { /* Ignore non-text SSE frames. */ }
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(consumeLine);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer);
      if (!fullText.trim() && !controller.signal.aborted) {
        setMessages([...conversation, { id: assistantId, role: "assistant", content: "No readable answer came back. Please try again.", model }]);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "Chat request failed.";
        setChatError(message);
        setMessages([...conversation, { id: assistantId, role: "assistant", content: "I couldn't complete that response. " + message }]);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) { event.preventDefault(); void sendText(); }
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendText(); }
  }

  const activeTitle = TABS.find((tab) => tab.id === activeTab)?.label || "Chat";
  const lockPanel = locked && <form className="ud-cc-lock" onSubmit={unlock}>
    <strong>Command center locked</strong>
    <p>{locked.message}</p>
    <div><input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder="Access key" aria-label="Command center access key" autoComplete="off" /><button type="submit" className="ud-secondary-button">Unlock</button></div>
  </form>;

  return (
    <main className="ud-shell">
      <aside className={"ud-sidebar" + (mobileNavOpen ? " ud-sidebar-open" : "")}>
        <div className="ud-brand-row">
          <div className="ud-brand-mark" aria-hidden="true"><span>u</span><i /></div>
          <span className="ud-brand-name">UX <strong>Direct</strong></span>
          <button className="ud-mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>×</button>
        </div>
        <button className="ud-new-chat" onClick={newChat}><span>＋</span> New chat</button>
        <div className="ud-nav-label">COMMAND CENTER</div>
        <nav className="ud-nav" aria-label="Main navigation">
          {TABS.map((tab) => <button key={tab.id} className={"ud-nav-item" + (activeTab === tab.id ? " active" : "")} onClick={() => navigate(tab.id)}><span className="ud-nav-glyph">{tab.glyph}</span><span>{tab.label}</span><span className="ud-nav-trailing">↗</span></button>)}
        </nav>
        <div className="ud-history">
          <div className="ud-nav-label">COMING NEXT</div>
          {COMING_NEXT.map((label) => <div className="ud-cc-soon" key={label}><span>{label}</span><i>Soon</i></div>)}
        </div>
        <div className="ud-sidebar-bottom">
          <div className="ud-user-dot">Z</div>
          <div className="ud-user-copy"><strong>UX Direct</strong><span>{accessKey ? "Access key saved" : "Locked"}</span></div>
          <span className={"ud-live-dot" + (status?.connected ? " online" : "")} title={status?.connected ? "Model connected" : "Model not connected"} />
        </div>
      </aside>

      <section className="ud-main">
        <header className="ud-topbar">
          <div className="ud-mobile-head">
            <button className="ud-mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>☰</button>
            <span className="ud-mobile-brand">UX <strong>Direct</strong></span>
          </div>
          <div className="ud-breadcrumb"><span>Command center</span><b>/</b><strong>{activeTitle}</strong></div>
          <div className="ud-top-actions">
            <span className={"ud-provider-chip" + (status?.connected ? " connected" : status ? " disconnected" : "")}><i />{status?.connected ? (status.provider || "Model") + " · " + (status.defaultModel || "auto") : status ? "Model offline" : "Connecting…"}</span>
          </div>
        </header>

        {activeTab === "chat" && <section className="ud-chat-workspace">
          {lockPanel && <div className="ud-cc-lock-wrap">{lockPanel}</div>}
          {messages.length === 0 ? <div className="ud-welcome">
            <div className="ud-thinking-orb" aria-label="UX Direct thinking orb">
              <ThinkingOrb state={busy ? "working" : "breathing"} size={64} theme="dark" />
            </div>
            <div className="ud-welcome-kicker"><span /> UX DIRECT DATA ONLY</div>
            <h1>Ask about our<br /><em>UX Direct work.</em></h1>
            <p className="ud-welcome-copy">Answers come only from the shared knowledge brain and the last 7 days of Figma plugin activity. General questions are declined.</p>
            <div className="ud-prompt-grid">
              <button onClick={() => void sendText("Is hafte plugin se humne kya kya kiya?")}><span>⌁</span><strong>This week in the plugin</strong><small>Runs, outcomes and failures from the last 7 days.</small><b>↗</b></button>
              <button onClick={() => void sendText("Kaunse plugin tasks fail hue aur kyun?")}><span>!</span><strong>What failed and why</strong><small>Failed runs with their recorded errors.</small><b>↗</b></button>
              <button onClick={() => void sendText("Shared brain mein Figma output ke liye kaunse rules hain?")}><span>✦</span><strong>Rules the brain knows</strong><small>Stored rules for Figma output.</small><b>↗</b></button>
              <button onClick={() => void sendText("Kal humne kya kiya tha plugin mein?")}><span>◷</span><strong>What did we do yesterday</strong><small>Look up a specific day.</small><b>↗</b></button>
            </div>
          </div> : <div className="ud-messages">
            <div className="ud-thread-heading"><span className="ud-thread-mark">◌</span><div><strong>UX Direct chat</strong><small>Scoped to shared knowledge + plugin activity</small></div><button onClick={newChat}>New chat ＋</button></div>
            {messages.map((message) => <article className={"ud-message " + message.role} key={message.id}>
              <div className={"ud-message-avatar " + message.role}>{message.role === "assistant" ? "u" : "Z"}</div>
              <div className="ud-message-body">
                <div className="ud-message-role">{message.role === "assistant" ? "UX Direct" : "You"}</div>
                <div className="ud-message-text">{message.content ? (message.role === "assistant" ? <MarkdownContent content={message.content} /> : message.content) : (busy && message.role === "assistant" ? <span className="ud-typing"><ThinkingOrb state="solving" size={20} theme="dark" /><span>Looking through UX Direct data…</span></span> : "")}</div>
                {message.model && <div className="ud-message-meta"><span>{message.model}</span></div>}
              </div>
            </article>)}
            <div ref={endRef} />
          </div>}
          <div className="ud-composer-zone">
            {chatError && <div className="ud-chat-error" role="alert">{chatError}</div>}
            <form className="ud-composer" onSubmit={onSubmit}>
              <textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="Ask about UX Direct work…" rows={1} aria-label="Message UX Direct" />
              <div className="ud-composer-bottom">
                <div className="ud-composer-meta"><span className="ud-mode-tag"><i /> UX DIRECT DATA ONLY</span></div>
                {busy ? <button type="button" className="ud-send-button stop" onClick={() => abortRef.current?.abort()}><span>■</span> Stop</button> : <button type="submit" className="ud-send-button" disabled={!draft.trim()} aria-label="Send message"><span>↑</span></button>}
              </div>
            </form>
          </div>
        </section>}

        {activeTab === "knowledge" && <section className="ud-connections-workspace">
          <div className="ud-page-overline">SHARED BRAIN</div>
          <div className="ud-connections-heading"><div><h1>Shared knowledge.</h1><p>Active rules and reference documents the plugin and chat learn from.</p></div><button className="ud-secondary-button" onClick={() => void loadView("knowledge")} disabled={dataBusy}>{dataBusy ? "Loading…" : "Refresh ↻"}</button></div>
          {lockPanel}
          {dataError && <div className="ud-chat-error" role="alert">{dataError}</div>}
          {knowledge && <>
            <div className="ud-cc-stats"><div><b>{knowledge.rules.length}</b><span>Active rules</span></div><div><b>{knowledge.documents.length}</b><span>Reference documents</span></div></div>
            <h2 className="ud-cc-section">Rules</h2>
            {knowledge.rules.length ? <div className="ud-cc-list">{knowledge.rules.map((rule) => <article className="ud-cc-row" key={rule.id}>
              <div className="ud-cc-row-top"><strong>{rule.title}</strong><span className="ud-status-pill muted">{rule.scope || "shared"}</span></div>
              <p>{rule.rule}</p>
              <small>{[rule.kind, rule.source, formatWhen(rule.updatedAt)].filter(Boolean).join(" · ")}</small>
            </article>)}</div> : <p className="ud-cc-empty">No active rules yet.</p>}
            <h2 className="ud-cc-section">Reference documents</h2>
            {knowledge.documents.length ? <div className="ud-cc-list">{knowledge.documents.map((doc) => <article className="ud-cc-row" key={doc.id}>
              <div className="ud-cc-row-top"><strong>{doc.title}</strong><span className="ud-status-pill muted">{doc.projectKey || "shared"}</span></div>
              <small>{[doc.sourceType, formatWhen(doc.updatedAt)].filter(Boolean).join(" · ")}</small>
            </article>)}</div> : <p className="ud-cc-empty">No reference documents yet. File uploads come later.</p>}
          </>}
        </section>}

        {activeTab === "activity" && <section className="ud-connections-workspace">
          <div className="ud-page-overline">FIGMA PLUGIN · LAST 7 DAYS</div>
          <div className="ud-connections-heading"><div><h1>Plugin activity.</h1><p>Every recorded plugin task from the last 7 days, newest first.</p></div><button className="ud-secondary-button" onClick={() => void loadView("activity")} disabled={dataBusy}>{dataBusy ? "Loading…" : "Refresh ↻"}</button></div>
          {lockPanel}
          {dataError && <div className="ud-chat-error" role="alert">{dataError}</div>}
          {activity && <>
            <div className="ud-cc-stats">
              <div><b>{activity.summary.total}</b><span>Runs</span></div>
              <div><b>{activity.summary.byOutcome.verified}</b><span>Verified</span></div>
              <div><b>{activity.summary.byOutcome.succeeded}</b><span>Succeeded</span></div>
              <div><b>{activity.summary.byOutcome.failed}</b><span>Failed</span></div>
            </div>
            {activity.items.length ? <div className="ud-cc-list">{activity.items.map((item) => <article className="ud-cc-row" key={item.id}>
              <div className="ud-cc-row-top"><strong>{item.title}</strong><span className={"ud-status-pill " + (item.outcome === "failed" ? "error" : item.outcome === "verified" || item.outcome === "succeeded" ? "ok" : "muted")}>{OUTCOME_LABEL[item.outcome]}</span></div>
              {item.request && item.request !== item.title && <p>{item.request}</p>}
              {item.summary && <p>{item.summary}</p>}
              {item.error && <p className="ud-cc-error-text">{item.error}</p>}
              <small>{[formatWhen(item.at), item.model, item.durationMs !== null ? Math.round(item.durationMs / 1000) + "s" : ""].filter(Boolean).join(" · ")}</small>
            </article>)}</div> : <p className="ud-cc-empty">No plugin runs in the last 7 days.</p>}
          </>}
        </section>}
      </section>
      {mobileNavOpen && <button className="ud-mobile-scrim" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
    </main>
  );
}
