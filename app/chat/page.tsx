"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import "./chat.css";
import { ThinkingOrb } from "thinking-orbs";
import { MarkdownContent } from "@/src/components/markdown-content";
import { KnowledgeBase } from "./knowledge-base";

/**
 * UX Direct command center: a chat scoped to UX Direct data, the shared knowledge
 * brain, and the last 7 days of Figma plugin activity. Everything else (audits, IA,
 * benchmarking) was removed; new sections are added under "Coming next".
 */
type Role = "user" | "assistant";
type ChatMessage = { id: string; role: Role; content: string; model?: string };
type Tab = "chat" | "knowledge" | "activity" | "models";
type ServiceStatus = { connected: boolean; provider?: string; defaultModel?: string; providerId?: string; error?: string };
type ActivityItem = {
  id: string; at: string; title: string; request: string;
  outcome: "attempted" | "succeeded" | "verified" | "failed" | "unknown";
  durationMs: number | null; model: string | null; summary: string; error: string; projectKey: string;
};
type ActivityPayload = {
  items: ActivityItem[]; total: number; nextOffset: number | null;
  summary: { windowDays: number; total: number; byOutcome: Record<ActivityItem["outcome"], number>; byDay: Array<{ day: string; count: number }> };
};
type ModelsPayload = {
  window: string;
  mode: string;
  totals: { calls: number; ok: number; tokens: number; avgLatencyMs: number };
  models: Array<{ gateway: string; provider: string; model: string; calls: number; ok: number; errors: number; promptTokens: number; completionTokens: number; totalTokens: number; p50LatencyMs: number; p95LatencyMs: number; lastAt: string; lastError?: string }>;
  roles: Array<{ role: string; calls: number; ok: number; topModel: string }>;
  recent: Array<{ at: string; gateway: string; role: string; provider: string; model: string; ok: boolean; status: number; latencyMs: number; tokens: number; error?: string }>;
  providers: Array<{ id: string; label: string; models: Array<{ id: string; tier: string; rpm: number; rpd?: number }> }>;
  missingProviders: Array<{ id: string; label: string; secret: string }>;
};

type BudgetPayload = {
  generatedAt: string; resetsAt: string;
  requests: { limit: number; used: number; remaining: number; coveredModels: number; totalModels: number };
  tokens: { limit: number; usedOnLimited: number; remaining: number; usedToday: number; coveredModels: number; totalModels: number };
  last24h: { calls: number; ok: number; tokens: number; promptTokens: number; completionTokens: number };
  pace: { callsPerHour: number; tokensPerHour: number; projected24hCalls: number; projected24hTokens: number; hoursUntilRequestsOut: number | null };
  hourly: Array<{ hour: string; calls: number; tokens: number }>;
  roles: Array<{ seat: string; label: string; calls: number; ok: number; tokens: number; promptTokens: number; completionTokens: number; share: number; topModel: string; sources: string[] }>;
  providers: Array<{ id: string; label: string; source: string; accountRpd?: number; callsToday: number; tokensToday: number; models: Array<{ model: string; rpd?: number; tpd?: number; callsToday: number; tokensToday: number; requestsLeft?: number; tokensLeft?: number }> }>;
  notes: string[];
};

const HISTORY_KEY = "ux-direct-command-chat-v1";
const ACCESS_KEY_STORAGE = "ux-direct-command-key";
const ACCESS_HEADER = "X-UXD-Command-Key";
const TABS: Array<{ id: Tab; label: string; glyph: string }> = [
  { id: "chat", label: "Chat", glyph: "◌" },
  { id: "knowledge", label: "Knowledge base", glyph: "✦" },
  { id: "activity", label: "Plugin activity", glyph: "⌁" },
  { id: "models", label: "Models", glyph: "◇" },
];
const MODEL_WINDOWS = [1, 24, 168];
type ModelsTab = "models" | "roles" | "providers" | "recent";
// Models page: top stats stay; each tab's data is fetched only when the tab is opened.
const MODEL_TABS: Array<{ id: ModelsTab; label: string }> = [
  { id: "models", label: "By model" },
  { id: "roles", label: "By agent role" },
  { id: "providers", label: "Free providers" },
  { id: "recent", label: "Recent calls" },
];
const LIST_PAGE = 6;
const formatTokens = (value: number) => value >= 1_000_000 ? (value / 1_000_000).toFixed(1) + "M" : value >= 1000 ? (value / 1000).toFixed(1) + "k" : String(value);
const percent = (used: number, limit: number) => limit ? Math.min(100, Math.round(used / limit * 100)) : 0;
const formatMs = (value: number) => value >= 1000 ? (value / 1000).toFixed(1) + "s" : value + "ms";
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
  const [modelTab, setModelTab] = useState<ModelsTab>("models");
  const [modelData, setModelData] = useState<Partial<Record<ModelsTab, ModelsPayload>>>({});
  const [moreBusy, setMoreBusy] = useState(false);
  const [modelHours, setModelHours] = useState(24);
  const [budget, setBudget] = useState<BudgetPayload | null>(null);
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [providerCheck, setProviderCheck] = useState<{ busy: boolean; message?: string; results?: Array<{ provider: string; model: string; ok: boolean; status: number; latencyMs: number; error?: string }> }>({ busy: false });
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

  const fetchView = useCallback(async (query: string): Promise<unknown | null> => {
    const response = await fetch("/api/command-center?" + query, { cache: "no-store", headers: { [ACCESS_HEADER]: accessKey } });
    if (response.status === 401 || response.status === 503 && (await response.clone().json().catch(() => ({}))).locked) { await handleLocked(response); return null; }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load data.");
    setLocked(null);
    return payload;
  }, [accessKey, handleLocked]);

  const loadActivity = useCallback(async (more = false) => {
    if (more) setMoreBusy(true); else setDataBusy(true);
    setDataError("");
    try {
      const offset = more && activity?.nextOffset ? activity.nextOffset : 0;
      const payload = await fetchView("view=activity&offset=" + offset + "&limit=" + LIST_PAGE) as ActivityPayload | null;
      if (!payload) return;
      setActivity((current) => more && current ? { ...payload, items: [...current.items, ...payload.items] } : payload);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Could not load data.");
    } finally {
      if (more) setMoreBusy(false); else setDataBusy(false);
    }
  }, [activity?.nextOffset, fetchView]);

  const loadModelTab = useCallback(async (tab: ModelsTab, hours: number, reset = false) => {
    setDataBusy(true);
    setDataError("");
    try {
      // The "models" tab also carries the top stats, so it is always loaded first.
      const tabs: ModelsTab[] = tab === "models" ? ["models"] : reset ? ["models", tab] : [tab];
      const results = await Promise.all(tabs.map((item) => fetchView("view=models&tab=" + item + "&hours=" + hours)));
      if (results.some((result) => !result)) return;
      setModelData((current) => {
        const next = reset ? {} : { ...current };
        tabs.forEach((item, index) => { next[item] = results[index] as ModelsPayload; });
        return next;
      });
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Could not load data.");
    } finally {
      setDataBusy(false);
    }
  }, [fetchView]);

  const loadBudget = useCallback(async () => {
    setBudgetBusy(true);
    try {
      const result = await fetchView("view=models-budget");
      if (result) setBudget(result as BudgetPayload);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Could not load the budget.");
    } finally {
      setBudgetBusy(false);
    }
  }, [fetchView]);

  useEffect(() => {
    if (!historyReady) return;
    if (activeTab === "activity" && !activity) void loadActivity();
    if (activeTab === "models" && !modelData.models) void loadModelTab("models", modelHours);
    if (activeTab === "models" && !budget && !budgetBusy) void loadBudget();
  }, [activeTab, historyReady, activity, modelData.models, modelHours, loadActivity, loadModelTab, budget, budgetBusy, loadBudget]);

  function openModelTab(tab: ModelsTab) {
    setModelTab(tab);
    if (!modelData[tab]) void loadModelTab(tab, modelHours);
  }

  function changeModelHours(hours: number) {
    setModelHours(hours);
    void loadModelTab(modelTab, hours, true);
  }

  async function checkProviders() {
    setProviderCheck({ busy: true });
    try {
      const response = await fetch("/api/command-center?view=models-check", { cache: "no-store", headers: { [ACCESS_HEADER]: accessKey } });
      const payload = await response.json() as { throttled?: boolean; retryAfterSeconds?: number; error?: string; log?: { ok: boolean; error?: string }; results?: Array<{ provider: string; model: string; ok: boolean; status: number; latencyMs: number; error?: string }> };
      if (!response.ok) throw new Error(payload.error || "Check failed.");
      if (payload.throttled) { setProviderCheck({ busy: false, message: "Checked a moment ago. Try again in " + payload.retryAfterSeconds + "s." }); return; }
      const ok = (payload.results || []).filter((row) => row.ok).length;
      setProviderCheck({ busy: false, results: payload.results, message: ok + " of " + (payload.results || []).length + " providers answered." + (payload.log && !payload.log.ok ? " Call log not writable: " + payload.log.error : "") });
    } catch (error) {
      setProviderCheck({ busy: false, message: error instanceof Error ? error.message : "Check failed." });
    }
  }

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

  const models = modelData.models || null;
  const tabData = modelData[modelTab] || null;
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
          <div className="ud-user-copy"><strong>UX Direct</strong><span>Command center</span></div>
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
          <div className="ud-page-overline">UX DIRECT BRAIN</div>
          {lockPanel}
          <KnowledgeBase accessHeader={ACCESS_HEADER} accessKey={accessKey} onLocked={handleLocked} />
        </section>}

        {activeTab === "activity" && <section className="ud-connections-workspace">
          <div className="ud-page-overline">FIGMA PLUGIN · LAST 7 DAYS</div>
          <div className="ud-connections-heading"><div><h1>Plugin activity.</h1><p>Every recorded plugin task from the last 7 days, newest first.</p></div><button className="ud-secondary-button" onClick={() => void loadActivity()} disabled={dataBusy}>{dataBusy ? "Loading…" : "Refresh ↻"}</button></div>
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
            {activity.nextOffset !== null && <div className="ud-cc-more"><button className="ud-secondary-button" onClick={() => void loadActivity(true)} disabled={moreBusy}>{moreBusy ? "Loading…" : "View more (" + (activity.total - activity.items.length) + " more) ▾"}</button></div>}
          </>}
        </section>}
        {activeTab === "models" && <section className="ud-connections-workspace">
          <div className="ud-page-overline">MODEL GATEWAY · MODE {models ? models.mode.toUpperCase() : "…"}</div>
          <div className="ud-connections-heading"><div><h1>Models.</h1><p>Every model call: which free model answered, tokens, latency and errors, and how much of the free daily budget is left. All calls run through UX Direct&apos;s own gateway inside the Worker.</p></div>
            <div className="ud-cc-actions">
              {MODEL_WINDOWS.map((hours) => <button key={hours} className={"ud-secondary-button" + (modelHours === hours ? " active" : "")} onClick={() => changeModelHours(hours)} disabled={dataBusy}>{hours === 1 ? "1h" : hours === 24 ? "24h" : "7d"}</button>)}
              <button className="ud-secondary-button" onClick={() => void loadModelTab(modelTab, modelHours, true)} disabled={dataBusy}>{dataBusy ? "Loading…" : "Refresh ↻"}</button>
            </div>
          </div>
          {lockPanel}
          {dataError && <div className="ud-chat-error" role="alert">{dataError}</div>}
          {budget && <div className="ud-budget">
            <div className="ud-budget-head"><div className="ud-cc-section">Free budget today</div><button className="ud-secondary-button" onClick={() => void loadBudget()} disabled={budgetBusy}>{budgetBusy ? "Refreshing…" : "Refresh"}</button></div>
            <div className="ud-budget-cards">
              <div className="ud-budget-card">
                <span>Requests today</span>
                <b>{budget.requests.remaining.toLocaleString()} <em>left</em></b>
                <div className="ud-budget-bar"><i style={{ width: percent(budget.requests.used, budget.requests.limit) + "%" }} /></div>
                <small>{budget.requests.used.toLocaleString()} used of {budget.requests.limit.toLocaleString()} · {budget.requests.coveredModels}/{budget.requests.totalModels} models publish a daily limit</small>
              </div>
              <div className="ud-budget-card">
                <span>Tokens today</span>
                <b>{formatTokens(budget.tokens.usedToday)} <em>used</em></b>
                <div className="ud-budget-bar"><i style={{ width: percent(budget.tokens.usedOnLimited, budget.tokens.limit) + "%" }} /></div>
                <small>Published token caps: {formatTokens(budget.tokens.remaining)} left of {formatTokens(budget.tokens.limit)} ({budget.tokens.coveredModels}/{budget.tokens.totalModels} models). The rest have no published token cap.</small>
              </div>
              <div className="ud-budget-card">
                <span>Last 24 hours</span>
                <b>{formatTokens(budget.last24h.tokens)} <em>tokens</em></b>
                <small>{budget.last24h.calls.toLocaleString()} calls · {budget.last24h.calls ? Math.round(budget.last24h.ok / budget.last24h.calls * 100) : 0}% ok · in {formatTokens(budget.last24h.promptTokens)} / out {formatTokens(budget.last24h.completionTokens)}</small>
              </div>
              <div className="ud-budget-card">
                <span>Pace (last 3 h)</span>
                <b>{formatTokens(budget.pace.tokensPerHour)} <em>tokens/h</em></b>
                <small>{budget.pace.callsPerHour} calls/h · 24 h at this pace: {formatTokens(budget.pace.projected24hTokens)} tokens, {budget.pace.projected24hCalls.toLocaleString()} calls · {budget.pace.hoursUntilRequestsOut !== null ? "requests run out in ~" + budget.pace.hoursUntilRequestsOut + " h" : "requests last until the reset"}</small>
              </div>
            </div>
            <details className="ud-budget-acc">
              <summary>By role (last 24 h) <span>{budget.roles.length} roles</span></summary>
              {budget.roles.length ? <div className="ud-cc-table-wrap"><table className="ud-cc-table">
                <thead><tr><th>Role</th><th>Tokens</th><th>Share</th><th>Calls</th><th>In / out</th><th>Most used model</th></tr></thead>
                <tbody>{budget.roles.map((row) => <tr key={row.seat} title={row.sources.length ? "Also counts: " + row.sources.join(", ") : ""}>
                  <td><strong>{row.label}</strong><small>{row.seat}</small></td>
                  <td>{formatTokens(row.tokens)}</td>
                  <td><div className="ud-budget-share"><i style={{ width: row.share + "%" }} /></div><small>{row.share}%</small></td>
                  <td>{row.calls}{row.calls - row.ok ? <small className="ud-cc-error-text">{row.calls - row.ok} failed</small> : null}</td>
                  <td>{formatTokens(row.promptTokens)} / {formatTokens(row.completionTokens)}</td>
                  <td><small>{row.topModel || "—"}</small></td>
                </tr>)}</tbody>
              </table></div> : <p className="ud-cc-empty">No calls in the last 24 hours.</p>}
            </details>
            <details className="ud-budget-acc">
              <summary>By provider and model (today) <span>{budget.providers.length} providers</span></summary>
              <div className="ud-cc-list">{budget.providers.map((provider) => <article className="ud-cc-row" key={provider.id}>
                <div className="ud-cc-row-top"><strong>{provider.label}</strong><span className="ud-status-pill muted">{provider.callsToday} calls · {formatTokens(provider.tokensToday)} tokens{provider.accountRpd ? " · " + Math.max(0, provider.accountRpd - provider.callsToday) + "/" + provider.accountRpd + " left" : ""}</span></div>
                <small>{provider.source}</small>
                <div className="ud-cc-table-wrap"><table className="ud-cc-table">
                  <thead><tr><th>Model</th><th>Requests today</th><th>Tokens today</th></tr></thead>
                  <tbody>{provider.models.map((model) => <tr key={model.model}>
                    <td><strong>{model.model}</strong></td>
                    <td>{model.callsToday}{model.rpd ? " / " + model.rpd.toLocaleString() : provider.accountRpd ? " (shared)" : " / unknown"}</td>
                    <td>{formatTokens(model.tokensToday)}{model.tpd ? " / " + formatTokens(model.tpd) : " / unknown"}</td>
                  </tr>)}</tbody>
                </table></div>
              </article>)}</div>
            </details>
            <details className="ud-budget-acc">
              <summary>Hour by hour (last 24 h)</summary>
              {budget.hourly.length ? <div className="ud-budget-hours">{(() => {
                const max = Math.max(1, ...budget.hourly.map((row) => row.tokens));
                return budget.hourly.map((row) => <div key={row.hour} title={new Date(row.hour).toLocaleString() + " · " + row.calls + " calls · " + row.tokens.toLocaleString() + " tokens"}>
                  <i style={{ height: Math.max(2, Math.round(row.tokens / max * 100)) + "%" }} /><small>{new Date(row.hour).getHours()}</small>
                </div>);
              })()}</div> : <p className="ud-cc-empty">No calls in the last 24 hours.</p>}
            </details>
            <details className="ud-budget-acc">
              <summary>Where these numbers come from</summary>
              <ul className="ud-budget-notes">{budget.notes.map((note) => <li key={note}>{note}</li>)}<li>Resets at {new Date(budget.resetsAt).toLocaleString()}.</li></ul>
            </details>
          </div>}
          {models && <div className="ud-cc-stats">
            <div><b>{models.totals.calls}</b><span>Calls ({models.window})</span></div>
            <div><b>{models.totals.calls ? Math.round(models.totals.ok / models.totals.calls * 100) : 0}%</b><span>Success</span></div>
            <div><b>{formatTokens(models.totals.tokens)}</b><span>Tokens</span></div>
            <div><b>{formatMs(models.totals.avgLatencyMs)}</b><span>Median latency</span></div>
          </div>}
          <div className="ud-cc-tabs" role="tablist" aria-label="Model sections">
            {MODEL_TABS.map((tab) => <button key={tab.id} role="tab" aria-selected={modelTab === tab.id} className={"ud-cc-tab" + (modelTab === tab.id ? " active" : "")} onClick={() => openModelTab(tab.id)}>{tab.label}</button>)}
          </div>
          <div role="tabpanel">
            {!tabData && <p className="ud-cc-empty">{dataBusy ? "Loading…" : "Nothing loaded yet."}</p>}
            {modelTab === "models" && tabData && (tabData.models.length ? <div className="ud-cc-table-wrap"><table className="ud-cc-table">
              <thead><tr><th>Model</th><th>Via</th><th>Calls</th><th>Errors</th><th>Tokens in / out</th><th>p50 / p95</th><th>Last</th></tr></thead>
              <tbody>{tabData.models.map((row) => <tr key={row.gateway + row.provider + row.model} title={row.lastError || ""}>
                <td><strong>{row.model}</strong><small>{row.provider}</small></td>
                <td><span className={"ud-status-pill " + (row.gateway === "uxd" ? "ok" : "muted")}>{row.gateway === "uxd" ? "gateway" : "freellmapi"}</span></td>
                <td>{row.calls}</td>
                <td className={row.errors ? "ud-cc-error-text" : ""}>{row.errors}</td>
                <td>{formatTokens(row.promptTokens)} / {formatTokens(row.completionTokens)}</td>
                <td>{formatMs(row.p50LatencyMs)} / {formatMs(row.p95LatencyMs)}</td>
                <td>{formatWhen(row.lastAt)}</td>
              </tr>)}</tbody>
            </table></div> : <p className="ud-cc-empty">No model calls in this window yet.</p>)}
            {modelTab === "roles" && tabData && (tabData.roles.length ? <div className="ud-cc-list">{tabData.roles.map((role) => <article className="ud-cc-row" key={role.role}>
              <div className="ud-cc-row-top"><strong>{role.role}</strong><span className="ud-status-pill muted">{role.calls} calls · {role.calls ? Math.round(role.ok / role.calls * 100) : 0}% ok</span></div>
              {role.topModel && <small>Most used: {role.topModel}</small>}
            </article>)}</div> : <p className="ud-cc-empty">No agent-role calls in this window yet.</p>)}
            {modelTab === "providers" && tabData && <>
              <div className="ud-cc-actions ud-cc-tab-actions"><button className="ud-secondary-button" onClick={() => void checkProviders()} disabled={providerCheck.busy}>{providerCheck.busy ? "Checking…" : "Check providers live"}</button></div>
              {providerCheck.message && <p className="ud-cc-empty">{providerCheck.message}</p>}
              {providerCheck.results && <div className="ud-cc-list">{providerCheck.results.map((row) => <article className="ud-cc-row" key={row.provider}>
                <div className="ud-cc-row-top"><strong>{row.provider} · {row.model}</strong><span className={"ud-status-pill " + (row.ok ? "ok" : "error")}>{row.ok ? "works · " + formatMs(row.latencyMs) : "failed · " + (row.status || "timeout")}</span></div>
                {row.error && <p className="ud-cc-error-text">{row.error}</p>}
              </article>)}</div>}
              <div className="ud-cc-list">{tabData.providers.map((provider) => <article className="ud-cc-row" key={provider.id}>
                <div className="ud-cc-row-top"><strong>{provider.label}</strong><span className="ud-status-pill ok">connected</span></div>
                <small>{provider.models.map((model) => model.id + " (" + model.tier + ", " + model.rpm + " rpm" + (model.rpd ? ", " + model.rpd + "/day" : "") + ")").join(" · ")}</small>
              </article>)}
              {tabData.missingProviders.map((provider) => <article className="ud-cc-row" key={provider.id}>
                <div className="ud-cc-row-top"><strong>{provider.label}</strong><span className="ud-status-pill muted">no key</span></div>
                <small>Add the Worker secret {provider.secret} to use it.</small>
              </article>)}</div>
            </>}
            {modelTab === "recent" && tabData && (tabData.recent.length ? <div className="ud-cc-table-wrap"><table className="ud-cc-table">
              <thead><tr><th>When</th><th>Role</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens</th></tr></thead>
              <tbody>{tabData.recent.map((row, index) => <tr key={row.at + index} title={row.error || ""}>
                <td>{formatWhen(row.at)}</td>
                <td>{row.role}</td>
                <td><strong>{row.model}</strong><small>{row.gateway === "uxd" ? "gateway · " : "freellmapi · "}{row.provider}</small></td>
                <td className={row.ok ? "" : "ud-cc-error-text"}>{row.ok ? "ok" : (row.status || "timeout") + (row.error ? " · " + row.error.slice(0, 60) : "")}</td>
                <td>{formatMs(row.latencyMs)}</td>
                <td>{formatTokens(row.tokens)}</td>
              </tr>)}</tbody>
            </table></div> : <p className="ud-cc-empty">No calls recorded yet.</p>)}
          </div>
        </section>}
      </section>
      {mobileNavOpen && <button className="ud-mobile-scrim" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
    </main>
  );
}
