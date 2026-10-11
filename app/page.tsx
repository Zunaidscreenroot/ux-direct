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

export default function Home() {
  const [task, setTask] = useState("");
  const [activeProject, setActiveProject] = useState("General UX");
  const [submitted, setSubmitted] = useState(false);

  function submitTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task.trim()) return;
    setSubmitted(true);
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
            <strong>Foundation mode</strong>
            <span>Model gateway not connected</span>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Cockpit</div>
          <div className="topbar-right"><span className="environment">MVP · local-ready</span><div className="avatar">Z</div></div>
        </header>

        <div className="content">
          <div className="eyebrow"><span className="pulse" /> YOUR AI UX EMPLOYEE</div>
          <h1>Good design starts<br />with <em>good thinking.</em></h1>
          <p className="intro">
            Give UX Direct a real product problem. It will structure the task, surface assumptions,
            plan the work, and prepare a reasoned design outcome—not just generate a screen.
          </p>

          <form className="task-composer" onSubmit={submitTask}>
            <label htmlFor="task">What should we work on?</label>
            <textarea
              id="task"
              value={task}
              onChange={(event) => { setTask(event.target.value); setSubmitted(false); }}
              placeholder="e.g. Analyse the existing DMI screens and plan the VKYC entry journey. Preserve product patterns and cover failure states."
              rows={4}
            />
            <div className="composer-footer">
              <label className="select-label" htmlFor="project">Project context</label>
              <select id="project" value={activeProject} onChange={(event) => setActiveProject(event.target.value)}>
                <option>General UX</option>
                <option>Express Computers</option>
                <option>DMI Finance</option>
              </select>
              <button className="submit-button" type="submit">Plan task <span aria-hidden="true">↗</span></button>
            </div>
            {submitted && (
              <p className="inline-note" role="status">
                Task captured in the cockpit UI. Execution is not connected yet; the next milestone is the task orchestrator and mock provider.
              </p>
            )}
          </form>

          <div className="section-heading">
            <div><span className="section-kicker">FIRST PROVING GROUNDS</span><h2>Where we begin</h2></div>
            <span className="count">02 PROJECTS</span>
          </div>

          <div className="project-grid">
            {starterTasks.map((item, index) => (
              <button className="project-card" key={item.label} type="button" onClick={() => { setActiveProject(item.label); setTask(item.title + ". " + item.detail); setSubmitted(false); }}>
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
