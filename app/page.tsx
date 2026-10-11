"use client";

import { useCallback, useEffect, useState } from "react";

type Health = {
  service: string; status: string; checkedAt: string; mode: string;
  deployment?: { platform: string; host: string };
  modelProviderConfigured: boolean;
  figma: { oauthConfigured: boolean; status: string; note: string };
  capabilities: { taskPlanning: boolean; figmaRead: boolean; figmaWrite: boolean; operationalLog: string };
};
type EventItem = {
  id: string; at: string; source: string; event: string;
  status: "success" | "warning" | "error" | "info";
  summary: string; requestId?: string; project?: string; durationMs?: number; mode?: string; category?: string; action?: string; testType?: "availability" | "functional" | "not-tested";
};
type PlanResult = {
  task: { id: string; status: string; steps: Array<{ id: string; label: string; status: string }> };
  plan: { summary: string; assumptions: string[]; steps: Array<{ id: string; label: string; capabilityId: string }>; qualityChecks: string[]; requiresHumanReview: boolean };
  mode: string; cost: { currency: string; amount: number }; requestId?: string;
};
type PluginCheck = { category: string; name: string; level: "availability" | "functional" | "not-tested"; status: "success" | "error" | "not-tested"; reason: string };
type PluginHealthReport = { passed: number; available?: number; failed: number; notTested: number; checkedAt: string; checks: PluginCheck[] };
type PersistedHealthReport = { clientId: string; commandId?: string; savedAt: string; healthReport: PluginHealthReport };
type PluginSession = {
  clientId: string; status: "online" | "offline"; connectedAt: string; lastHeartbeatAt: string;
  disconnectedAt?: string; lastTestAt?: string; isOnline: boolean;
  latestCommand?: { commandId: string; action: string; status: "pending" | "claimed" | "completed" | "failed"; issuedAt: string; completedAt?: string; failure?: string };
  healthReport?: PluginHealthReport;
};

const API = "";
const navItems = [
  { id: "cockpit", label: "Cockpit", icon: "◈" },
  { id: "projects", label: "Projects", icon: "▤" },
  { id: "capabilities", label: "Capabilities", icon: "⌘" },
  { id: "history", label: "Task history", icon: "◷" },
  { id: "connections", label: "Connections", icon: "⌁" },
  { id: "gateway", label: "Model Gateway", icon: "◎" },
] as const;
type Tab = typeof navItems[number]["id"];


type GatewayDashboardPayload = {
  gateway: { name: string; status: string; paidModelsEnabled: boolean; monthlyBudgetInr: number; pricingConfigured: boolean; gatewayFeeInr: number };
  providers: Array<{ id: string; label: string; envName: string; configured: boolean; keyDetected: boolean; tier: string; secretRequired: boolean }>;
  models: Array<{ id: string; provider: string; label: string; tier: string; tasks: string[]; configured: boolean; notes: string }>;
  budget: {
    currency: string; monthlyBudgetInr: number; spentThisMonthInr: number; remainingInr: number;
    percentUsed: number; inputPriceInrPerMillion: number; outputPriceInrPerMillion: number;
    pricingConfigured: boolean; month: string; records: Array<{
      id: string; at: string; requestId: string; provider: string; model: string; tier: string;
      promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostInr: number;
      latencyMs: number; status: string; note?: string;
    }>; retention: string;
  };
  checkedAt: string;
};

function inr(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: value < 10 ? 4 : 2 }).format(value);
}

function ModelGatewayPanel() {
  const [data, setData] = useState<GatewayDashboardPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);
  const loadDashboard = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/model-gateway/dashboard", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load gateway dashboard.");
      setData(payload as GatewayDashboardPayload);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Gateway dashboard is unavailable.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void loadDashboard(); }, [loadDashboard]);
  const records = data?.budget.records ?? [];
  const maxTokens = Math.max(1, ...records.map(record => record.totalTokens));
  const models = (data?.models ?? []).filter(model => showAllModels || model.configured || model.tier === "mock");
  const budget = data?.budget;
  const keyReady = (data?.providers ?? []).filter(provider => provider.keyDetected).length;
  return (
    <div className="content gateway-content">
      <div className="eyebrow"><span className="pulse" /> MODEL OPERATIONS</div>
      <div className="gateway-title-row">
        <div><h1>Model gateway.<br /><em>Every token accounted for.</em></h1>
          <p className="intro">Provider routing, per-request token usage, estimated spend and budget guardrails. API keys stay server-side and are intentionally left for your final activation step.</p>
        </div>
        <button className="submit-button" type="button" onClick={() => void loadDashboard()} disabled={busy}>{busy ? "Refreshing…" : "Refresh data ↻"}</button>
      </div>
      {loadError && <p className="inline-note" role="alert">{loadError}</p>}
      <div className="gateway-mode-banner">
        <span className={"gateway-status-dot " + (data?.gateway.paidModelsEnabled ? "gateway-dot-live" : "gateway-dot-idle")} />
        <div><strong>{data?.gateway.paidModelsEnabled ? "Paid routing explicitly enabled" : "Safe setup mode · API keys not required yet"}</strong>
          <p>{data?.gateway.paidModelsEnabled ? "Paid requests are subject to the configured monthly budget and token prices." : "Mock mode is available now. Local/free providers can be connected before enabling any paid model."}</p>
        </div>
        <span className="gateway-fee">₹0 gateway fee</span>
      </div>

      <div className="gateway-stat-grid">
        <article className="gateway-stat-card"><span>MONTH-TO-DATE SPEND</span><strong>{inr(budget?.spentThisMonthInr ?? 0)}</strong><small>{budget?.month ?? "Current month"} · estimated from token usage</small></article>
        <article className="gateway-stat-card"><span>MONTHLY BUDGET</span><strong>{inr(budget?.monthlyBudgetInr ?? 3000)}</strong><small>Default cap · ₹3,000 unless configured otherwise</small></article>
        <article className="gateway-stat-card"><span>BUDGET REMAINING</span><strong>{inr(budget?.remainingInr ?? 3000)}</strong><small>{budget?.percentUsed ?? 0}% used this month</small></article>
        <article className="gateway-stat-card"><span>MODEL CALLS RECORDED</span><strong>{records.length}</strong><small>{records.reduce((sum, item) => sum + item.totalTokens, 0).toLocaleString("en-IN")} tokens in current ledger</small></article>
      </div>

      <section className="gateway-panel budget-panel">
        <div className="gateway-panel-heading"><div><span className="section-kicker">BUDGET GUARDRAIL</span><h2>Monthly usage</h2></div><span className={"status-chip " + (budget?.percentUsed && budget.percentUsed >= 80 ? "status-warning" : "status-success")}>{budget?.percentUsed ?? 0}% consumed</span></div>
        <div className="budget-track"><div className={"budget-fill " + ((budget?.percentUsed ?? 0) >= 80 ? "budget-fill-warning" : "")} style={{ width: Math.min(100, budget?.percentUsed ?? 0) + "%" }} /></div>
        <div className="budget-scale"><span>{inr(0)} used</span><strong>{inr(budget?.remainingInr ?? 3000)} remaining</strong><span>{inr(budget?.monthlyBudgetInr ?? 3000)} cap</span></div>
        <div className="budget-config-grid">
          <div><span>Input token price</span><strong>{budget?.pricingConfigured ? inr(budget.inputPriceInrPerMillion) + " / 1M" : "Not configured"}</strong></div>
          <div><span>Output token price</span><strong>{budget?.pricingConfigured ? inr(budget.outputPriceInrPerMillion) + " / 1M" : "Not configured"}</strong></div>
          <div><span>Paid model status</span><strong>{data?.gateway.paidModelsEnabled ? "Enabled with guardrails" : "Locked"}</strong></div>
        </div>
        {!budget?.pricingConfigured && <p className="gateway-inline-warning">Paid requests are blocked until input and output prices are entered in server environment settings. This prevents unpriced calls from being treated as free.</p>}
        <p className="gateway-footnote">Cost figures are estimates based on configured prices. Free-tier and local calls show ₹0 API cost; provider quota limits still apply. Budget/usage records are currently best-effort runtime memory and may reset on serverless restarts.</p>
      </section>

      <div className="gateway-section-heading"><div><span className="section-kicker">PROVIDER REGISTRY</span><h2>Connections &amp; API key placeholders</h2></div><span className="count">{keyReady} PROVIDER KEYS DETECTED</span></div>
      <div className="gateway-provider-grid">
        {(data?.providers ?? []).map(provider => (
          <article className="gateway-provider-card" key={provider.id}>
            <div className="gateway-provider-top"><span className="gateway-provider-mark">{provider.label.split(" ").map(word => word[0]).join("").slice(0, 2)}</span><span className={"status-chip " + (provider.configured ? "status-success" : "status-neutral")}>{provider.configured ? "Configured · unverified" : provider.keyDetected ? "Key detected · setup incomplete" : provider.tier === "local" ? "Endpoint not configured" : "Key not added"}</span></div>
            <h3>{provider.label}</h3><p>{provider.tier === "paid" ? "Paid provider · stays disabled until explicitly activated." : provider.tier === "local" ? "Local inference · no model API key or per-token provider charge." : "Free-tier candidate · account quotas and availability apply."}</p>
            <label className="gateway-key-label" htmlFor={"key-slot-" + provider.id}>{provider.envName}</label>
            <div className="gateway-key-placeholder"><input id={"key-slot-" + provider.id} type="password" placeholder={provider.secretRequired ? "API key placeholder · add in final step" : "Local endpoint placeholder"} disabled readOnly aria-label={provider.envName + " placeholder; edit disabled"} /><span>{provider.keyDetected ? "KEY DETECTED" : provider.configured ? "CONNECTED" : "PLACEHOLDER"}</span></div>
            <small className="gateway-provider-note">{provider.secretRequired ? "No key is requested or stored in this dashboard. Add it later as a server-side environment variable; live provider health is not verified here." : "Configure the endpoint in server environment settings when local inference is ready. Reachability is not verified by this status check."}</small>
          </article>
        ))}
      </div>

      <div className="gateway-section-heading"><div><span className="section-kicker">MODEL CATALOG</span><h2>Available routing options</h2></div><button className="secondary-button" type="button" onClick={() => setShowAllModels(value => !value)}>{showAllModels ? "Show configured only" : "Show all models"}</button></div>
      <div className="gateway-table-wrap"><table className="gateway-table"><thead><tr><th>MODEL</th><th>PROVIDER</th><th>TIER</th><th>STATUS</th><th>BEST FOR</th></tr></thead><tbody>
        {models.map(model => <tr key={model.provider + model.id}><td><strong>{model.id}</strong><small>{model.label}</small></td><td>{model.provider}</td><td><span className={"gateway-tier tier-" + model.tier}>{model.tier}</span></td><td>{model.configured ? <span className="gateway-configured">Ready</span> : <span className="gateway-unconfigured">Not configured</span>}</td><td>{model.tasks.join(", ")}</td></tr>)}
      </tbody></table></div>

      <div className="gateway-section-heading"><div><span className="section-kicker">TOKEN LEDGER</span><h2>Request-by-request usage</h2></div><span className="count">LATEST {Math.min(records.length, 200)} RECORDS THIS MONTH</span></div>
      <section className="gateway-panel token-ledger-panel">
        <div className="token-ledger-intro"><div><strong>Prompt tokens vs completion tokens</strong><p>Each completed gateway request records input tokens, output tokens, total tokens, provider/model, latency and estimated cost. Prompt and response content are never displayed here.</p></div><span className="ledger-retention">Runtime ledger</span></div>
        {records.length === 0 ? <div className="gateway-empty-state"><div className="gateway-empty-icon">◷</div><strong>No real model calls recorded yet</strong><p>This is expected before providers are connected. Mock requests can verify the gateway wiring but do not count as real AI inference.</p></div> : <>
          <div className="token-ledger-table-wrap"><table className="gateway-table token-table"><thead><tr><th>TIME / REQUEST</th><th>MODEL</th><th>INPUT</th><th>OUTPUT</th><th>TOTAL TOKENS</th><th>EST. COST</th><th>LATENCY</th></tr></thead><tbody>
            {records.map(record => <tr key={record.id}><td><strong>{new Date(record.at).toLocaleString()}</strong><small>#{record.requestId.slice(0, 8)} · {record.status}</small></td><td><strong>{record.model}</strong><small>{record.provider}</small></td><td>{record.promptTokens.toLocaleString("en-IN")}</td><td>{record.completionTokens.toLocaleString("en-IN")}</td><td><div className="token-value">{record.totalTokens.toLocaleString("en-IN")}</div><div className="token-mini-track"><div style={{ width: Math.min(100, record.totalTokens / maxTokens * 100) + "%" }} /></div></td><td>{inr(record.estimatedCostInr)}</td><td>{record.latencyMs.toLocaleString("en-IN")} ms</td></tr>)}
          </tbody></table></div>
        </>}
      </section>
      <p className="gateway-footer-note">Last refreshed: {data?.checkedAt ? new Date(data.checkedAt).toLocaleTimeString() : "not checked"} · API key placeholders are intentionally non-editable here. The final activation step should add keys to server-side environment variables, never browser storage or client-side code.</p>
      <footer>UX DIRECT <span>·</span> MODEL GATEWAY &amp; COST CONTROL</footer>
    </div>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("cockpit");
  const [task, setTask] = useState("");
  const [activeProject, setActiveProject] = useState("General UX");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [bridgeSessions, setBridgeSessions] = useState<PluginSession[]>([]);
  const [latestSavedReport, setLatestSavedReport] = useState<PersistedHealthReport | null>(null);
  const [pluginHealthBusy, setPluginHealthBusy] = useState(false);
  const [pluginHealthMessage, setPluginHealthMessage] = useState("");
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [refreshingConnections, setRefreshingConnections] = useState(false);

  const refreshConnections = useCallback(async () => {
    setRefreshingConnections(true);
    try {
      const [healthResponse, eventsResponse, bridgeResponse] = await Promise.all([
        fetch(API + "/api/health", { cache: "no-store" }),
        fetch(API + "/api/telemetry?limit=30", { cache: "no-store" }),
        fetch(API + "/api/plugin-bridge?mode=sessions", { cache: "no-store" }).catch(() => null)
      ]);
      if (!healthResponse.ok) throw new Error("Health endpoint returned " + healthResponse.status);
      const nextHealth = await healthResponse.json() as Health;
      setHealth(nextHealth);
      setHealthError("");
      if (eventsResponse.ok) {
        const payload = await eventsResponse.json();
        setEvents(Array.isArray(payload.events) ? payload.events : []);
      }
      if (bridgeResponse && bridgeResponse.ok) {
        const bridgePayload = await bridgeResponse.json();
        setBridgeSessions(Array.isArray(bridgePayload.sessions) ? bridgePayload.sessions : []);
        setLatestSavedReport(bridgePayload.latestReport ?? null);
      } else {
        setBridgeSessions([]);
        setLatestSavedReport(null);
      }
      setLastRefresh(new Date().toISOString());
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Backend health check failed");
    } finally {
      setRefreshingConnections(false);
    }
  }, []);

  useEffect(() => {
    void refreshConnections();
    const timer = window.setInterval(() => void refreshConnections(), 30000);
    return () => window.clearInterval(timer);
  }, [refreshConnections]);

  async function logDashboardEvent(event: string, status: EventItem["status"], summary: string, details: Record<string, unknown> = {}) {
    try {
      await fetch("/api/telemetry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "dashboard", event, status, summary, ...details })
      });
    } catch { /* The task response remains authoritative if telemetry is unavailable. */ }
  }

  async function runPluginHealthCheck() {
    if (!activePluginSession || pluginHealthBusy) {
      setPluginHealthMessage("Open UX Direct in Figma and keep the plugin panel open first.");
      return;
    }
    setPluginHealthBusy(true);
    setPluginHealthMessage("Sending a native API test request to the active Figma plugin…");
    const clientId = activePluginSession.clientId;
    try {
      await logDashboardEvent("Plugin health check requested", "info", "User requested the native Figma API self-test from the Netlify dashboard.");
      const response = await fetch("/api/plugin-bridge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "command", clientId, action: "native-api-health-check" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not send the command to Figma");
      const commandId = String(payload.commandId);
      setPluginHealthMessage("Command sent. Waiting for Figma to run the test and return its report…");
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        // Poll one persisted state endpoint at a restrained cadence instead of rapidly probing the backend.
        await new Promise((resolve) => window.setTimeout(resolve, 8000));
        const stateResponse = await fetch("/api/plugin-bridge?mode=state&clientId=" + encodeURIComponent(clientId), { cache: "no-store" });
        if (!stateResponse.ok) continue;
        const statePayload = await stateResponse.json();
        const session = statePayload.session as PluginSession;
        const savedReport = statePayload.latestReport as PersistedHealthReport | null;
        if (savedReport?.commandId === commandId && savedReport.healthReport) {
          const report = savedReport.healthReport;
          setLatestSavedReport(savedReport);
          setPluginHealthMessage("Completed in Figma: " + report.passed + " passed, " + report.failed + " failed, " + (report.available ?? 0) + " available, " + report.notTested + " not tested.");
          await logDashboardEvent("Plugin health check completed", report.failed ? "warning" : "success", "Figma returned its native Plugin API inventory.", { requestId: commandId });
          await refreshConnections();
          return;
        }
        if (session.latestCommand?.commandId !== commandId) continue;
        if (session.latestCommand.status === "completed" && session.healthReport) {
          const report = session.healthReport;
          setPluginHealthMessage("Completed in Figma: " + report.passed + " passed, " + report.failed + " failed, " + (report.available ?? 0) + " available, " + report.notTested + " not tested.");
          await logDashboardEvent("Plugin health check completed", report.failed ? "warning" : "success", "Figma returned its native Plugin API inventory.", { requestId: commandId });
          setBridgeSessions((current) => current.map((item) => item.clientId === session.clientId ? session : item));
          await refreshConnections();
          return;
        }
        if (session.latestCommand.status === "failed") {
          throw new Error(session.latestCommand.failure ?? "Plugin health check failed.");
        }
      }
      setPluginHealthMessage("No result received yet. Keep the Figma plugin panel open and refresh plugin activity. The command may have expired.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plugin health check failed.";
      setPluginHealthMessage(message);
      await logDashboardEvent("Plugin health check failed", "error", message);
    } finally {
      setPluginHealthBusy(false);
      await refreshConnections();
    }
  }

  async function submitTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task.trim() || loading) return;
    setLoading(true); setError(""); setPlanResult(null); setSubmitted(false);
    const projectMap: Record<string, "general" | "express-computers" | "dmi-finance"> = {
      "General UX": "general", "Express Computers": "express-computers", "DMI Finance": "dmi-finance",
    };
    const startedAt = Date.now();
    await logDashboardEvent("Task request started", "info", "Planning request initiated from the dashboard.", { project: projectMap[activeProject] ?? "general" });
    try {
      const response = await fetch("/api/tasks/plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.trim().split(/[.!?\n]/)[0].slice(0, 160) || "UX task",
          request: task.trim(), project: projectMap[activeProject] ?? "general",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to plan this task");
      setPlanResult(result as PlanResult); setSubmitted(true);
      await logDashboardEvent("Task response received", "success", "Planning response returned to the dashboard.", { requestId: result.requestId, project: projectMap[activeProject] ?? "general", durationMs: Date.now() - startedAt, mode: result.mode });
      await refreshConnections();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      setError(message);
      await logDashboardEvent("Task request failed", "error", "Dashboard could not complete the planning request.");
      await refreshConnections();
    } finally { setLoading(false); }
  }

  const backendHealthy = health?.status === "ok" && !healthError;
  const orderedPluginSessions = [...bridgeSessions].sort((a, b) => Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt));
  const activePluginSession = orderedPluginSessions.find((session) => session.isOnline) ?? null;
  const displayPluginSession = activePluginSession ?? orderedPluginSessions[0] ?? null;
  const pluginOnline = Boolean(activePluginSession);
  const pluginStatusLabel = pluginOnline ? "Online" : displayPluginSession ? "Offline" : "Not connected";
  const latestPluginTest = latestSavedReport?.healthReport ?? displayPluginSession?.healthReport ?? null;
  const latestPluginTestSummary = latestPluginTest
    ? latestPluginTest.passed + " passed · " + latestPluginTest.failed + " failed · " + (latestPluginTest.available ?? 0) + " available · " + latestPluginTest.notTested + " not tested"
    : "Not run yet";
  const breadcrumb = navItems.find((item) => item.id === activeTab)?.label ?? "Cockpit";

  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="UX Direct home"><span className="brand-mark">ux</span><span>UX Direct</span></a>
        <div className="sidebar-label">WORKSPACE</div>
        {navItems.map((item) => (
          <button key={item.id} className={"nav-item" + (activeTab === item.id ? " active" : "")} type="button" onClick={() => setActiveTab(item.id)}>
            <span aria-hidden="true">{item.icon}</span>{item.label}
          </button>
        ))}
        <div className="sidebar-bottom">
          <div className="status-dot" style={{ background: backendHealthy ? "#26966b" : "#d9a84d" }} />
          <div><strong>{backendHealthy ? "Backend reachable" : "Connection status"}</strong><span>{backendHealthy ? "Health check passed" : "Check Connections"}</span></div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> {breadcrumb}</div>
          <div className="topbar-right"><span className="environment">{health?.mode ? health.mode + " mode" : "Checking backend"}</span><div className="avatar">Z</div></div>
        </header>

        {activeTab === "gateway" ? (
          <ModelGatewayPanel />
        ) : activeTab === "connections" ? (
          <div className="content">
            <div className="eyebrow"><span className="pulse" /> SYSTEM STATUS</div>
            <h1>Connections &amp;<br /><em>health checks.</em></h1>
            <p className="intro">Separate backend availability from the plugin’s recent heartbeat. Review plugin events, request failures, and the latest native API self-test.</p>
            <div className="connection-toolbar">
              <span className="last-checked">Last checked: {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "Not checked yet"}</span>
              <button className="submit-button" type="button" onClick={() => void refreshConnections()}>Run health check ↻</button>
            </div>
            {healthError && <p className="inline-note" role="alert">Health check failed: {healthError}</p>}
            <div className="connection-grid">
              <article className="connection-card">
                <div className="connection-card-top"><span className="service-icon">API</span><span className={"status-chip " + (backendHealthy ? "status-success" : "status-error")}>{backendHealthy ? "Healthy" : "Unreachable"}</span></div>
                <h2>UX Direct backend</h2><p>Dashboard → Netlify production API</p>
                <dl><div><dt>Health endpoint</dt><dd>{backendHealthy ? "Responding" : "Not verified"}</dd></div><div><dt>Task planning</dt><dd>{health?.capabilities.taskPlanning ? "Available" : "Unknown"}</dd></div><div><dt>Last checked</dt><dd>{lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "—"}</dd></div></dl>
              </article>
              <article className="connection-card plugin-bridge-card">
                <div className="connection-card-top"><span className="service-icon">FG</span><span className={"status-chip " + (pluginOnline ? "status-success" : "status-neutral")}>{pluginOnline ? "Online" : "Offline"}</span></div>
                <h2>Figma plugin bridge</h2><p>Two-way control · Native Plugin API</p>
                <dl><div><dt>Plugin activity</dt><dd>{pluginStatusLabel}</dd></div><div><dt>Last heartbeat</dt><dd>{displayPluginSession ? new Date(displayPluginSession.lastHeartbeatAt).toLocaleTimeString() : "Not received"}</dd></div><div><dt>Open session</dt><dd>{activePluginSession ? activePluginSession.clientId.slice(0, 8) : "None"}</dd></div><div><dt>Last health check</dt><dd>{latestPluginTest ? new Date(latestPluginTest.checkedAt).toLocaleTimeString() : "Not run yet"}</dd></div></dl>
                <p className="connection-note">The dashboard sends a command to the open Figma plugin. The native test runs inside Figma, then its detailed report is saved back to this card. No Figma REST API or OAuth is used.</p>
                <button className="secondary-button plugin-health-button" type="button" onClick={() => void runPluginHealthCheck()} disabled={!activePluginSession || pluginHealthBusy}>{pluginHealthBusy ? "Running in Figma…" : "Run Plugin Health Check ↗"}</button>
                {!activePluginSession && <p className="plugin-help">Open the UX Direct plugin in Figma and keep its panel open to enable remote tests.</p>}
                {pluginHealthMessage && <p className="plugin-health-message" role="status">{pluginHealthMessage}</p>}
                {latestPluginTest && <div className="plugin-health-report">
                  <div className="health-counts">
                    <span><strong>{latestPluginTest.passed}</strong> PASS</span>
                    <span><strong>{latestPluginTest.failed}</strong> FAIL</span>
                    <span><strong>{latestPluginTest.available ?? 0}</strong> AVAILABLE</span>
                    <span><strong>{latestPluginTest.notTested}</strong> NOT TESTED</span>
                  </div>
                  <details>
                    <summary>View action inventory ({latestPluginTest.checks.length} checks)</summary>
                    <div className="plugin-check-list">
                      {latestPluginTest.checks.map((item, index) => <div className="plugin-check-row" key={item.category + item.name + index}>
                        <span className={"plugin-check-badge " + (item.level === "not-tested" ? "check-untested" : item.status === "success" ? (item.level === "availability" ? "check-available" : "check-pass") : "check-fail")}>{item.level === "not-tested" ? (/team library/i.test(item.name) ? "NOT TESTED INTENTIONALLY" : "NOT TESTED") : item.status === "success" ? (item.level === "availability" ? "AVAILABLE" : "PASS") : "FAIL"}</span>
                        <div><strong>{item.name}</strong><span>{item.category} · {item.level}</span><p>{item.reason}</p></div>
                      </div>)}
                    </div>
                  </details>
                </div>}
                <button className="secondary-button" type="button" onClick={() => void refreshConnections()} disabled={refreshingConnections}>{refreshingConnections ? "Refreshing…" : "Refresh plugin activity ↻"}</button>
              </article>
              <article className="connection-card">
                <div className="connection-card-top"><span className="service-icon">AI</span><span className={"status-chip " + (health?.modelProviderConfigured ? "status-warning" : "status-neutral")}>{health?.modelProviderConfigured ? "Key detected" : "Mock mode"}</span></div>
                <h2>AI model provider</h2><p>Model execution readiness</p>
                <dl><div><dt>Configured provider</dt><dd>{health?.mode ?? "Unknown"}</dd></div><div><dt>API key detected</dt><dd>{health ? (health.modelProviderConfigured ? "Yes" : "No") : "Unknown"}</dd></div><div><dt>Figma writes</dt><dd>Disabled</dd></div></dl>
                <p className="connection-note">A detected API key does not prove the provider is usable. Model calls are not enabled by this health check.</p>
              </article>
            </div>

            <div className="section-heading connection-log-heading">
              <div><span className="section-kicker">OPERATIONAL LOG</span><h2>Recent request activity</h2></div>
              <button className="secondary-button" type="button" onClick={() => void refreshConnections()}>Refresh logs</button>
            </div>
            <div className="log-panel">
              <div className="log-intro"><strong>Readable status trail</strong><span>Requests, responses, duration, project and errors. Prompt contents and secrets are not shown.</span></div>
              {events.length === 0 ? (
                <div className="empty-log"><strong>No recent events available in this runtime.</strong><p>Run a health check or submit a task. Plugin events will appear when its telemetry reaches this same backend instance.</p></div>
              ) : (
                <div className="event-list">{events.map((item) => (
                  <article className="event-row" key={item.id}>
                    <span className={"event-indicator event-" + item.status} />
                    <div className="event-main"><div className="event-title-line"><strong>{item.event}</strong><span className={"status-chip status-" + (item.status === "success" ? "success" : item.status === "error" ? "error" : item.status === "warning" ? "warning" : "neutral")}>{item.status}</span></div>
                      <p>{item.summary}</p><div className="event-meta"><span>{item.source}</span>{item.project && <span>{item.project}</span>}{item.mode && <span>{item.mode} mode</span>}{item.category && <span>{item.category}</span>}{item.testType && <span>{item.testType}</span>}{typeof item.durationMs === "number" && <span>{item.durationMs} ms</span>}{item.requestId && <span>Request {item.requestId.slice(0, 8)}</span>}</div>
                    </div><time>{new Date(item.at).toLocaleTimeString()}</time>
                  </article>
                ))}</div>
              )}
              <p className="retention-note">Log retention: best-effort recent events. Netlify serverless memory may reset between requests; structured runtime events are also emitted to Netlify runtime logs. Durable cross-session history needs persistent storage.</p>
            </div>
            <footer>UX DIRECT <span>·</span> CONNECTIONS &amp; OPERATIONS</footer>
          </div>
        ) : (
          <div className="content">
            <div className="eyebrow"><span className="pulse" /> YOUR AI UX EMPLOYEE</div>
            <h1>Good design starts<br />with <em>good thinking.</em></h1>
            <p className="intro">Give UX Direct a real product problem. It structures the task, surfaces assumptions, and creates a reviewable plan. This first vertical slice uses a deterministic mock provider.</p>
            <form className="task-composer" onSubmit={submitTask}>
              <label htmlFor="task">What should we work on?</label>
              <textarea id="task" value={task} onChange={(event) => { setTask(event.target.value); setSubmitted(false); setPlanResult(null); setError(""); }} placeholder="e.g. Analyse the existing DMI screens and plan the VKYC entry journey. Preserve product patterns and cover failure states." rows={4} maxLength={8000} required />
              <div className="composer-footer"><label className="select-label" htmlFor="project">Project context</label><select id="project" value={activeProject} onChange={(event) => { setActiveProject(event.target.value); setPlanResult(null); }}><option>General UX</option><option>Express Computers</option><option>DMI Finance</option></select><button className="submit-button" type="submit" disabled={loading}>{loading ? "Planning…" : "Plan task"} <span aria-hidden="true">↗</span></button></div>
              {error && <p className="inline-note" role="alert">{error}</p>}
              {submitted && planResult && <p className="inline-note" role="status">Plan created in mock mode. Model/API cost: ₹0. Request ID: {planResult.requestId ?? "not returned"}. No Figma file was modified.</p>}
            </form>
            {planResult && <section className="plan-results" aria-labelledby="plan-heading"><div className="section-heading"><div><span className="section-kicker">TASK PLAN · MOCK MODE</span><h2 id="plan-heading">Work breakdown</h2></div><span className="count">₹0 API COST</span></div><p className="plan-summary">{planResult.plan.summary}</p><ol className="plan-steps">{planResult.plan.steps.map((step, index) => <li key={step.id}><span className="step-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{step.label}</strong><span>{step.capabilityId}</span></div><span className="step-state">Planned</span></li>)}</ol><div className="plan-columns"><div><h3>Quality gates</h3><ul>{planResult.plan.qualityChecks.map((check) => <li key={check}>{check}</li>)}</ul></div><div><h3>Assumptions to validate</h3><ul>{planResult.plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div></div><p className="review-note">Human review required · Planning only. Execution and Figma integration are not connected yet.</p></section>}
            <div className="section-heading"><div><span className="section-kicker">FIRST PROVING GROUNDS</span><h2>{activeTab === "projects" ? "Projects" : activeTab === "capabilities" ? "Capabilities" : activeTab === "history" ? "Task history" : "Where we begin"}</h2></div><span className="count">02 PROJECTS</span></div>
            <div className="project-grid">
              {[{ label: "Express Computers", title: "Continue Batch 3 wireframes", detail: "Extract patterns from Batch 1 and 2, map requirements, then prepare review-ready screens.", tag: "Design task" }, { label: "DMI Finance", title: "VKYC journey and credit report entry", detail: "Infer the current product language and plan the journey, verification states, and entry point.", tag: "Design task" }].map((item, index) => <button className="project-card" key={item.label} type="button" onClick={() => { setActiveProject(item.label); setTask(item.title + ". " + item.detail); setSubmitted(false); setPlanResult(null); setError(""); setActiveTab("cockpit"); }}><div className="card-top"><span className={"project-icon icon-" + index}>{index === 0 ? "EC" : "DM"}</span><span className="card-arrow">↗</span></div><span className="card-tag">{item.tag}</span><h3>{item.label}</h3><p className="card-title">{item.title}</p><p className="card-detail">{item.detail}</p><span className="card-action">Prepare task <span aria-hidden="true">→</span></span></button>)}
            </div>
            <div className="principle-strip"><span className="principle-icon">✳</span><div><strong>Senior-level thinking. Evidence before confidence.</strong><p>Plan → Design → Critique → Validate → Improve. Human judgement stays in the loop for consequential decisions.</p></div></div>
            <footer>UX DIRECT <span>·</span> BUILDING THE NEXT LEVEL OF PRODUCT DESIGN</footer>
          </div>
        )}
      </section>
    </main>
  );
}
