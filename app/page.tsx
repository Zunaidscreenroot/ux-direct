"use client";

import { useState } from "react";

const starterTasks = [
  {
    label: "Express Computers",
    title: "Continue Batch 3 wireframes",
    detail: "Extract patterns from Batch 1 and 2, map requirements, then prepare review-ready screens.",
    tag: "Design task",
  },
  {
    label: "DMI Finance",
    title: "VKYC journey and credit report entry",
    detail: "Infer the current product language and plan the journey, verification states, and entry point.",
    tag: "Design task",
  },
];

type PlanResult = {
  task: { id: string; status: string; steps: Array<{ id: string; label: string; status: string }> };
  plan: {
    summary: string;
    assumptions: string[];
    steps: Array<{ id: string; label: string; capabilityId: string }>;
    qualityChecks: string[];
    requiresHumanReview: boolean;
  };
  mode: string;
  cost: { currency: string; amount: number };
};

export default function Home() {
  const [task, setTask] = useState("");
  const [activeProject, setActiveProject] = useState("General UX");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);

  async function submitTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task.trim() || loading) return;
    setLoading(true);
    setError("");
    setPlanResult(null);
    setSubmitted(false);

    const projectMap: Record<string, "general" | "express-computers" | "dmi-finance"> = {
      "General UX": "general",
      "Express Computers": "express-computers",
      "DMI Finance": "dmi-finance",
    };

    try {
      const response = await fetch("/api/tasks/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.trim().split(/[.!?\n]/)[0].slice(0, 160) || "UX task",
          request: task.trim(),
          project: projectMap[activeProject] ?? "general",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to plan this task");
      setPlanResult(result as PlanResult);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="UX Direct home">
          <span className="brand-mark">ux</span>
          <span>UX Direct</span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <button className="nav-item active" type="button">
          <span aria-hidden="true">◈</span> Cockpit
        </button>
        <button className="nav-item" type="button" onClick={() => setActiveProject("Express Computers")}>
          <span aria-hidden="true">▤</span> Projects
        </button>
        <button className="nav-item" type="button">
          <span aria-hidden="true">⌘</span> Capabilities
        </button>
        <button className="nav-item" type="button">
          <span aria-hidden="true">◷</span> Task history
        </button>
        <div className="sidebar-bottom">
          <div className="status-dot" />
          <div>
            <strong>Zero-cost foundation</strong>
            <span>Mock provider · no API calls</span>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Cockpit</div>
          <div className="topbar-right"><span className="environment">MVP · mock mode</span><div className="avatar">Z</div></div>
        </header>

        <div className="content">
          <div className="eyebrow"><span className="pulse" /> YOUR AI UX EMPLOYEE</div>
          <h1>Good design starts<br />with <em>good thinking.</em></h1>
          <p className="intro">
            Give UX Direct a real product problem. It structures the task, surfaces assumptions,
            and creates a reviewable plan. This first vertical slice uses a deterministic mock provider.
          </p>

          <form className="task-composer" onSubmit={submitTask}>
            <label htmlFor="task">What should we work on?</label>
            <textarea
              id="task"
              value={task}
              onChange={(event) => { setTask(event.target.value); setSubmitted(false); setPlanResult(null); setError(""); }}
              placeholder="e.g. Analyse the existing DMI screens and plan the VKYC entry journey. Preserve product patterns and cover failure states."
              rows={4}
              maxLength={8000}
              required
            />
            <div className="composer-footer">
              <label className="select-label" htmlFor="project">Project context</label>
              <select id="project" value={activeProject} onChange={(event) => { setActiveProject(event.target.value); setPlanResult(null); }}>
                <option>General UX</option>
                <option>Express Computers</option>
                <option>DMI Finance</option>
              </select>
              <button className="submit-button" type="submit" disabled={loading}>
                {loading ? "Planning…" : "Plan task"} <span aria-hidden="true">↗</span>
              </button>
            </div>
            {error && <p className="inline-note" role="alert">{error}</p>}
            {submitted && planResult && (
              <p className="inline-note" role="status">
                Plan created in mock mode. Model/API cost: ₹0. No Figma file was accessed or modified.
              </p>
            )}
          </form>

          {planResult && (
            <section className="plan-results" aria-labelledby="plan-heading">
              <div className="section-heading">
                <div><span className="section-kicker">TASK PLAN · MOCK MODE</span><h2 id="plan-heading">Work breakdown</h2></div>
                <span className="count">₹0 API COST</span>
              </div>
              <p className="plan-summary">{planResult.plan.summary}</p>
              <ol className="plan-steps">
                {planResult.plan.steps.map((step) => (
                  <li key={step.id}>
                    <span className="step-index">{String(planResult.plan.steps.findIndex((item) => item.id === step.id) + 1).padStart(2, "0")}</span>
                    <div><strong>{step.label}</strong><span>{step.capabilityId}</span></div>
                    <span className="step-state">Planned</span>
                  </li>
                ))}
              </ol>
              <div className="plan-columns">
                <div><h3>Quality gates</h3><ul>{planResult.plan.qualityChecks.map((check) => <li key={check}>{check}</li>)}</ul></div>
                <div><h3>Assumptions to validate</h3><ul>{planResult.plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div>
              </div>
              <p className="review-note">Human review required · Planning only. Execution and Figma integration are not connected yet.</p>
            </section>
          )}

          <div className="section-heading">
            <div><span className="section-kicker">FIRST PROVING GROUNDS</span><h2>Where we begin</h2></div>
            <span className="count">02 PROJECTS</span>
          </div>

          <div className="project-grid">
            {starterTasks.map((item, index) => (
              <button className="project-card" key={item.label} type="button" onClick={() => { setActiveProject(item.label); setTask(item.title + ". " + item.detail); setSubmitted(false); setPlanResult(null); setError(""); }}>
                <div className="card-top"><span className={"project-icon icon-" + index}>{index === 0 ? "EC" : "DM"}</span><span className="card-arrow">↗</span></div>
                <span className="card-tag">{item.tag}</span>
                <h3>{item.label}</h3>
                <p className="card-title">{item.title}</p>
                <p className="card-detail">{item.detail}</p>
                <span className="card-action">Prepare task <span aria-hidden="true">→</span></span>
              </button>
            ))}
          </div>

          <div className="principle-strip">
            <span className="principle-icon">✳</span>
            <div><strong>Senior-level thinking. Evidence before confidence.</strong><p>Plan → Design → Critique → Validate → Improve. Human judgement stays in the loop for consequential decisions.</p></div>
          </div>
          <footer>UX DIRECT <span>·</span> BUILDING THE NEXT LEVEL OF PRODUCT DESIGN</footer>
        </div>
      </section>
    </main>
  );
}
