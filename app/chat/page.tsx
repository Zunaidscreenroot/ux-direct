"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import "./chat.css";

type Role = "user" | "assistant";
type ChatMessage = { id: string; role: Role; content: string };
type FreeModel = { id: string; name: string; contextLength?: number };
type ServiceStatus = {
  connected: boolean;
  checkedAt?: string;
  error?: string;
  defaultModel?: string;
  freeModels: FreeModel[];
  uxAudit: { reachable: boolean; baseUrl: string; error?: string };
  brain: { reachable: boolean; error?: string };
};
type Tab = "chat" | "audit" | "connections";
type AuditTool = "ia" | "audit" | "benchmark";

const HISTORY_KEY = "ux-direct-chat-v1";
const AUDIT_URL = "https://uxaudit.zunaid-cb7.workers.dev";
const auditTools: Array<{ id: AuditTool; title: string; description: string; icon: string; path: string }> = [
  { id: "ia", title: "Information architecture", description: "Discover a website, inspect nested page structure, and select the journeys worth auditing.", icon: "⌘", path: "/site-map" },
  { id: "audit", title: "Website UX audit", description: "Audit a live page or upload screenshots, then review evidence-marked findings and recommendations.", icon: "◉", path: "/" },
  { id: "benchmark", title: "Competitive benchmarking", description: "Compare a client and competitors at the same desktop or mobile viewport.", icon: "⇄", path: "/benchmark" },
];

function shortModelName(value: string) {
  return value.split("/").slice(-1)[0].replace(/:free$/, "").replace(/[-_]/g, " ");
}

export default function ChatWorkspace() {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [auditTool, setAuditTool] = useState<AuditTool | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  async function refreshStatus() {
    setStatusBusy(true);
    try {
      const response = await fetch("/api/assistant/status", { cache: "no-store" });
      const payload = await response.json() as ServiceStatus;
      setStatus(payload);
      setSelectedModel((current) => {
        if (current && payload.freeModels.some((model) => model.id === current)) return current;
        return payload.defaultModel || payload.freeModels[0]?.id || "";
      });
    } catch {
      setStatus({
        connected: false,
        error: "Could not reach the UX Direct status endpoint.",
        freeModels: [],
        uxAudit: { reachable: false, baseUrl: AUDIT_URL },
        brain: { reachable: false },
      });
    } finally {
      setStatusBusy(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatMessage[];
        if (Array.isArray(parsed)) setMessages(parsed.filter((item) =>
          item && typeof item.id === "string" &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string"
        ).slice(-100));
      }
    } catch { /* Ignore stale or invalid local history. */ }
    const hash = window.location.hash.replace("#", "");
    if (hash === "audit" || hash === "connections" || hash === "chat") setActiveTab(hash);
    setHistoryReady(true);
    void refreshStatus();
    const onHash = () => {
      const next = window.location.hash.replace("#", "");
      if (next === "audit" || next === "connections" || next === "chat") setActiveTab(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => { mounted = false; window.removeEventListener("hashchange", onHash); if (!mounted) abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (historyReady) {
      try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-100))); } catch { /* Storage may be disabled. */ }
    }
  }, [messages, historyReady]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth", block: "end" }); }, [messages, busy]);

  function navigate(next: Tab) {
    setActiveTab(next);
    setMobileNavOpen(false);
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#" + next);
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
    if (!status?.connected || !selectedModel) {
      setChatError("OpenRouter is not ready. Refresh the connection status and make sure a free model is available.");
      return;
    }
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
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: selectedModel, messages: conversation.map((message) => ({ role: message.role, content: message.content })) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "OpenRouter returned HTTP " + response.status + ".");
      }
      if (!response.body) throw new Error("The model response stream was empty.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const payload = JSON.parse(data);
            const delta = payload.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              fullText += delta;
              setMessages([...conversation, { id: assistantId, role: "assistant", content: fullText }]);
            }
          } catch { /* Ignore incomplete or non-text event frames. */ }
        }
      }
      if (!fullText.trim() && !controller.signal.aborted) {
        setMessages([...conversation, { id: assistantId, role: "assistant", content: "The free model returned an empty response. Try a different free model or ask again." }]);
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

  const activeTitle = activeTab === "chat" ? "Chat" : activeTab === "audit" ? "Audit studio" : "Connections";
  const activeModel = status?.freeModels.find((model) => model.id === selectedModel);
  const auditToolInfo = auditTools.find((tool) => tool.id === auditTool);

  return (
    <main className="ud-shell">
      <aside className={"ud-sidebar" + (mobileNavOpen ? " ud-sidebar-open" : "")}>
        <div className="ud-brand-row">
          <div className="ud-brand-mark" aria-hidden="true"><span>u</span><i /></div>
          <span className="ud-brand-name">UX <strong>Direct</strong></span>
          <button className="ud-mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>×</button>
        </div>
        <button className="ud-new-chat" onClick={newChat}><span>＋</span> New chat <kbd>⌘ K</kbd></button>
        <div className="ud-nav-label">WORKSPACE</div>
        <nav className="ud-nav" aria-label="Main navigation">
          <button className={"ud-nav-item" + (activeTab === "chat" ? " active" : "")} onClick={() => navigate("chat")}><span className="ud-nav-glyph">◌</span><span>Chat</span><span className="ud-nav-trailing">↗</span></button>
          <button className={"ud-nav-item" + (activeTab === "audit" ? " active" : "")} onClick={() => navigate("audit")}><span className="ud-nav-glyph">⌘</span><span>Audit</span><span className="ud-nav-trailing">↗</span></button>
          <button className={"ud-nav-item" + (activeTab === "connections" ? " active" : "")} onClick={() => navigate("connections")}><span className="ud-nav-glyph">⌁</span><span>Connections</span><span className="ud-nav-trailing">↗</span></button>
        </nav>
        <div className="ud-history">
          <div className="ud-nav-label">RECENT CHATS</div>
          {messages.length ? <button className="ud-history-item" onClick={() => navigate("chat")}><span>◌</span><span>{messages.find((message) => message.role === "user")?.content.slice(0, 36) || "Current conversation"}</span></button> : <p className="ud-empty-history">Your conversations will appear here.</p>}
        </div>
        <div className="ud-sidebar-bottom">
          <div className="ud-user-dot">Z</div>
          <div className="ud-user-copy"><strong>UX Intelligence</strong><span>Shared brain enabled</span></div>
          <span className={"ud-live-dot" + (status?.connected ? " online" : "")} title={status?.connected ? "OpenRouter connected" : "OpenRouter not connected"} />
        </div>
      </aside>

      <section className="ud-main">
        <header className="ud-topbar">
          <div className="ud-mobile-head">
            <button className="ud-mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>☰</button>
            <span className="ud-mobile-brand">UX <strong>Direct</strong></span>
          </div>
          <div className="ud-breadcrumb"><span>Workspace</span><b>/</b><strong>{activeTitle}</strong></div>
          <div className="ud-top-actions">
            <span className={"ud-provider-chip" + (status?.connected ? " connected" : status ? " disconnected" : "")}><i />{status?.connected ? "OpenRouter · Free" : statusBusy ? "Connecting…" : "Connection needed"}</span>
            <button className="ud-icon-button" onClick={() => void refreshStatus()} title="Refresh service connections" aria-label="Refresh service connections">↻</button>
            <div className="ud-avatar">Z</div>
          </div>
        </header>

        {activeTab === "chat" && <section className="ud-chat-workspace">
          {messages.length === 0 ? <div className="ud-welcome">
            <div className="ud-brain-orb" aria-label="Animated UX Direct intelligence globe" role="img">
              <div className="ud-orb-halo" /><div className="ud-orb-ring ud-ring-a" /><div className="ud-orb-ring ud-ring-b" /><div className="ud-orb-ring ud-ring-c" />
              <div className="ud-orb-latitude ud-lat-a" /><div className="ud-orb-latitude ud-lat-b" /><div className="ud-orb-latitude ud-lat-c" />
              <div className="ud-orb-core"><span>UX</span><i /><b /></div><div className="ud-orb-spark ud-spark-a" /><div className="ud-orb-spark ud-spark-b" /><div className="ud-orb-spark ud-spark-c" />
            </div>
            <div className="ud-welcome-kicker"><span /> YOUR AI UX PARTNER</div>
            <h1>Think it through.<br /><em>Make it better.</em></h1>
            <p className="ud-welcome-copy">A senior UX partner for product decisions, audits, information architecture, and the details that make experiences work.</p>
            <div className="ud-prompt-grid">
              <button onClick={() => void sendText("Help me plan a UX audit for an Indian banking website.")}><span>◉</span><strong>Plan a UX audit</strong><small>Turn a brief into an evidence-led workflow.</small><b>↗</b></button>
              <button onClick={() => void sendText("Help me improve the information architecture of a banking website.")}><span>⌘</span><strong>Improve information architecture</strong><small>Structure journeys and simplify navigation.</small><b>↗</b></button>
              <button onClick={() => void sendText("Help me benchmark Ujjivan Small Finance Bank against its competitors.")}><span>⇄</span><strong>Benchmark competitors</strong><small>Compare journeys at the same viewport.</small><b>↗</b></button>
              <button onClick={() => void sendText("Review this UX problem like a senior designer. Help me frame evidence, severity, and recommendations.")}><span>✦</span><strong>Think through a UX problem</strong><small>Reason about evidence, severity, and trade-offs.</small><b>↗</b></button>
            </div>
          </div> : <div className="ud-messages">
            <div className="ud-thread-heading"><span className="ud-thread-mark">◌</span><div><strong>UX Direct</strong><small>Free OpenRouter model · responses are streamed</small></div><button onClick={newChat}>New chat ＋</button></div>
            {messages.map((message) => <article className={"ud-message " + message.role} key={message.id}>
              <div className={"ud-message-avatar " + message.role}>{message.role === "assistant" ? "u" : "Z"}</div>
              <div className="ud-message-body"><div className="ud-message-role">{message.role === "assistant" ? "UX Direct" : "You"}</div><div className="ud-message-text">{message.content || (busy && message.role === "assistant" ? <span className="ud-typing"><i /><i /><i /></span> : "")}</div></div>
            </article>)}
            <div ref={endRef} />
          </div>}
          <div className="ud-composer-zone">
            {chatError && <div className="ud-chat-error" role="alert">{chatError}</div>}
            <form className="ud-composer" onSubmit={onSubmit}>
              <textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={status?.connected ? "Message UX Direct…" : "Connecting to OpenRouter…"} rows={1} aria-label="Message UX Direct" disabled={statusBusy} />
              <div className="ud-composer-bottom">
                <div className="ud-composer-meta">
                  <span className="ud-mode-tag"><i /> FREE MODEL</span>
                  <label className="ud-model-select-label"><span>Model</span><select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!status?.freeModels.length} aria-label="Select a free OpenRouter model">{status?.freeModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>
                </div>
                {busy ? <button type="button" className="ud-send-button stop" onClick={() => abortRef.current?.abort()}><span>■</span> Stop</button> : <button type="submit" className="ud-send-button" disabled={!draft.trim() || !status?.connected || !selectedModel} aria-label="Send message"><span>↑</span></button>}
              </div>
            </form>
            <p className="ud-disclaimer">UX Direct uses free-tier OpenRouter models for chat. Availability and rate limits depend on the model provider.</p>
          </div>
        </section>}

        {activeTab === "audit" && <section className="ud-audit-workspace">
          {!auditTool ? <div className="ud-audit-landing">
            <div className="ud-page-overline">UX INTELLIGENCE · AUDIT</div><h1>Your audit workspace.</h1><p>Discover structure, inspect real screens, and benchmark the experience — all from UX Direct.</p>
            <div className="ud-audit-tool-grid">{auditTools.map((tool, index) => <button className="ud-audit-tool-card" key={tool.id} onClick={() => setAuditTool(tool.id)}>
              <div className="ud-audit-card-top"><span>{tool.icon}</span><i>0{index + 1}</i></div><h2>{tool.title}</h2><p>{tool.description}</p><b>Open workspace <span>→</span></b>
            </button>)}</div>
            <div className="ud-audit-note"><span>✦</span><p><strong>Evidence first, recommendations second.</strong> UX Direct opens the existing audit engine inside this workspace. Findings continue to use the current audit API and Past Findings flow.</p></div>
          </div> : <div className="ud-audit-embedded">
            <div className="ud-audit-toolbar">
              <button className="ud-audit-back" onClick={() => setAuditTool(null)}>← Audit workspace</button>
              <div className="ud-audit-tool-switcher">{auditTools.map((tool) => <button className={auditTool === tool.id ? "active" : ""} key={tool.id} onClick={() => setAuditTool(tool.id)}>{tool.title}</button>)}</div>
            </div>
            <iframe className="ud-audit-frame" key={auditTool} title={auditToolInfo?.title || "UX Audit"} src={AUDIT_URL + (auditToolInfo?.path || "/") + "?embed=1"} allow="clipboard-read; clipboard-write" />
          </div>}
        </section>}

        {activeTab === "connections" && <section className="ud-connections-workspace">
          <div className="ud-page-overline">SYSTEM STATUS</div><div className="ud-connections-heading"><div><h1>Connections.</h1><p>Your AI model, audit engine, and shared brain — in one place.</p></div><button className="ud-secondary-button" onClick={() => void refreshStatus()} disabled={statusBusy}>{statusBusy ? "Checking…" : "Check again ↻"}</button></div>
          <div className="ud-connection-grid">
            <article className="ud-connection-card"><div className="ud-connection-card-top"><span className="ud-connection-icon purple">◎</span><span className={"ud-status-pill " + (status?.connected ? "ok" : "error")}>{status?.connected ? "Connected" : statusBusy ? "Checking" : "Needs attention"}</span></div><h2>OpenRouter · Free models</h2><p>Chat inference is routed only to models with the <code>:free</code> model ID suffix. Paid-model fallbacks are disabled.</p><dl><div><dt>Free models found</dt><dd>{status?.freeModels.length ?? "—"}</dd></div><div><dt>Selected model</dt><dd>{activeModel?.name || (status?.defaultModel ? shortModelName(status.defaultModel) : "Not selected")}</dd></div><div><dt>Last check</dt><dd>{status?.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : "Not checked"}</dd></div></dl>{status?.error && <p className="ud-connection-error">{status.error}</p>}</article>
            <article className="ud-connection-card"><div className="ud-connection-card-top"><span className="ud-connection-icon green">⌘</span><span className={"ud-status-pill " + (status?.uxAudit.reachable ? "ok" : "error")}>{status?.uxAudit.reachable ? "Reachable" : statusBusy ? "Checking" : "Unavailable"}</span></div><h2>UX Audit engine</h2><p>The existing audit product is embedded here. It remains a separate backend Worker, but you do not need to open it as a second product.</p><dl><div><dt>Service</dt><dd>Cloudflare Worker</dd></div><div><dt>Workspace route</dt><dd>/#audit</dd></div><div><dt>Audit endpoint</dt><dd>Server-side</dd></div></dl>{!status?.uxAudit.reachable && <p className="ud-connection-error">{status?.uxAudit.error || "Audit worker did not respond during the last check."}</p>}</article>
            <article className="ud-connection-card"><div className="ud-connection-card-top"><span className="ud-connection-icon cyan">✦</span><span className={"ud-status-pill " + (status?.brain.reachable ? "ok" : "muted")}>{status?.brain.reachable ? "Reachable" : statusBusy ? "Checking" : "Not verified"}</span></div><h2>Shared Knowledge Brain</h2><p>Approved shared context is retrieved for chat when the server-side brain key is configured. Chat continues if memory retrieval is temporarily unavailable.</p><dl><div><dt>Memory context</dt><dd>{status?.brain.reachable ? "Available" : "Best effort"}</dd></div><div><dt>Scope</dt><dd>UX Direct + UX Audit</dd></div></dl></article>
          </div>
          <section className="ud-connector-footer"><div><span className="ud-connector-icon">⌁</span><div><strong>ChatGPT MCP connector</strong><p>Use this endpoint when connecting UX Direct as a ChatGPT tool provider. It exposes audit and shared-brain tools through OAuth, separately from this app chat.</p><code>{typeof window !== "undefined" ? window.location.origin + "/api/mcp" : "/api/mcp"}</code></div></div><a href="/.well-known/oauth-authorization-server" target="_blank" rel="noreferrer">View OAuth metadata ↗</a></section>
        </section>}
      </section>
      {mobileNavOpen && <button className="ud-mobile-scrim" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
    </main>
  );
}
