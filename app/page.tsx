"use client";

import { useCallback, useEffect, useState } from "react";

type Health = {
  service: string; status: string; checkedAt: string; mode: string;
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

const API = "";
const navItems = [
  { id: "cockpit", label: "Cockpit", icon: "◈" },
  { id: "projects", label: "Projects", icon: "▤" },
  { id: "capabilities", label: "Capabilities", icon: "⌘" },
  { id: "history", label: "Task history", icon: "◷" },
  { id: "connections", label: "Connections", icon: "⌁" },
] as const;
type Tab = typeof navItems[number]["id"];

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
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [refreshingConnections, setRefreshingConnections] = useState(false);

  const refreshConnections = useCallback(async () => {
    setRefreshingConnections(true);
    try {
      const [healthResponse, eventsResponse] = await Promise.all([
        fetch(API + "/api/health", { cache: "no-store" }),
        fetch(API + "/api/telemetry?limit=30", { cache: "no-store" })
      ]);
      if (!healthResponse.ok) throw new Error("Health endpoint returned " + healthResponse.status);
      const nextHealth = await healthResponse.json() as Health;
      setHealth(nextHealth);
      setHealthError("");
      if (eventsResponse.ok) {
        const payload = await eventsResponse.json();
        setEvents(Array.isArray(payload.events) ? payload.events : []);
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
    const timer = window.setInterval(() => void refreshConnections(), 15000);
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
  const lastHeartbeat = events.find((item) => item.source === "figma-plugin" && item.event === "Plugin heartbeat");
  const heartbeatAgeMs = lastHeartbeat ? Date.now() - Date.parse(lastHeartbeat.at) : null;
  const pluginOnline = heartbeatAgeMs !== null && heartbeatAgeMs >= 0 && heartbeatAgeMs < 65000;
  const pluginStatusLabel = pluginOnline ? "Online" : lastHeartbeat ? "No recent heartbeat" : "Unknown";
  const latestPluginTest = events.find((item) => item.source === "figma-plugin" && item.event === "Plugin API health check completed");
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

        {activeTab === "connections" ? (
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
                <h2>UX Direct backend</h2><p>Dashboard → Vercel API</p>
                <dl><div><dt>Health endpoint</dt><dd>{backendHealthy ? "Responding" : "Not verified"}</dd></div><div><dt>Task planning</dt><dd>{health?.capabilities.taskPlanning ? "Available" : "Unknown"}</dd></div><div><dt>Last checked</dt><dd>{lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "—"}</dd></div></dl>
              </article>
              <article className="connection-card">
                <div className="connection-card-top"><span className="service-icon">FG</span><span className="status-chip status-success">OAuth not required</span></div>
                <h2>Figma plugin bridge</h2><p>Native Plugin API + backend reachability</p>
                <dl><div><dt>Plugin activity</dt><dd>{pluginStatusLabel}</dd></div><div><dt>Last heartbeat</dt><dd>{lastHeartbeat ? new Date(lastHeartbeat.at).toLocaleTimeString() : "Not received"}</dd></div><div><dt>Plugin → backend</dt><dd>{backendHealthy ? "Backend healthy" : "Not verified"}</dd></div><div><dt>Latest API self-test</dt><dd>{latestPluginTest ? latestPluginTest.summary.slice(0, 90) : "Not run yet"}</dd></div></dl>
                <p className="connection-note">No Figma OAuth or REST API is used. Run the native API self-test inside the open plugin; its result will appear in activity when telemetry reaches this backend instance.</p>
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
              <p className="retention-note">Log retention: best-effort recent events. Vercel serverless memory may reset between requests; structured runtime events are also emitted to Vercel logs. Durable cross-session history needs persistent storage.</p>
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
