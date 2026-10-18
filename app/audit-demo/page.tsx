"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { regionToPercentStyle } from "@/src/ux-audit/annotations";
import { SEVERITY_LABELS, type AuditFinding, type AuditScreenshot, type UXAuditReport } from "@/src/ux-audit/types";

type AuditApiResult = {
  report: UXAuditReport;
  model: string;
  provider: string;
  latencyMs: number;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};
type LighthouseResult = { url: string; provider: string; checkedAt: string; report: unknown };

const categoryTitle = (category: string) => category.replaceAll("-", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
function severityColor(finding: AuditFinding): string {
  if (finding.kind === "positive") return "#31825d";
  if (finding.severity === 4) return "#b83f36";
  if (finding.severity === 3) return "#c96735";
  if (finding.severity === 2) return "#a57520";
  return "#426fbd";
}

function parseScreenshotLines(text: string, fallbackSite: string): AuditScreenshot[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    const siteName = parts.length >= 3 ? parts[0] : fallbackSite;
    const label = parts.length >= 3 ? parts[1] : "Screen " + (index + 1);
    const url = parts.length >= 3 ? parts.slice(2).join("|").trim() : parts[0];
    return { siteName: siteName || fallbackSite, label: label || "Screen " + (index + 1), url, pageType: label || undefined };
  });
}

function JsonReport({ value }: { value: unknown }) {
  return <pre style={{ maxHeight: 380, overflow: "auto", background: "#f4f7f2", border: "1px solid #e1e8df", borderRadius: 10, padding: 14, fontSize: 10, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(value, null, 2)}</pre>;
}

export default function AuditDemoPage() {
  const [product, setProduct] = useState("Indian BFSI website");
  const [journey, setJourney] = useState("Website product discovery");
  const [goal, setGoal] = useState("Help a customer find the right product, understand key terms and take the intended next step with confidence.");
  const [platform, setPlatform] = useState("desktop web");
  const [screenshotText, setScreenshotText] = useState("");
  const [auditResult, setAuditResult] = useState<AuditApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lighthouseUrl, setLighthouseUrl] = useState("");
  const [lighthouseResult, setLighthouseResult] = useState<LighthouseResult | null>(null);
  const [lighthouseBusy, setLighthouseBusy] = useState(false);
  const [lighthouseError, setLighthouseError] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  const screenshots = useMemo(() => parseScreenshotLines(screenshotText, product || "Product"), [screenshotText, product]);
  const report = auditResult?.report ?? null;
  const findingsByScreenshot = useMemo(() => {
    const map = new Map<number, AuditFinding[]>();
    for (const finding of report?.findings ?? []) {
      const values = map.get(finding.screenshotIndex) ?? [];
      values.push(finding);
      map.set(finding.screenshotIndex, values);
    }
    return map;
  }, [report]);
  const benchmarkSiteCount = new Set(screenshots.map((screenshot) => screenshot.siteName.trim().toLowerCase()).filter(Boolean)).size;

  async function runAudit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setAuditResult(null); setShowRaw(false);
    try {
      const cleanScreenshots = screenshots.filter((s) => s.url.startsWith("https://"));
      if (cleanScreenshots.length !== screenshots.length || cleanScreenshots.length === 0) {
        throw new Error("Use one public HTTPS screenshot URL per line, preferably from thum.io or a public R2 image URL.");
      }
      const response = await fetch("/api/ux-audit/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, journey, goal, platform, screenshots: cleanScreenshots })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "UX audit failed.");
      setAuditResult(payload as AuditApiResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "UX audit failed.");
    } finally { setBusy(false); }
  }

  async function runLighthouse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLighthouseBusy(true); setLighthouseError(""); setLighthouseResult(null);
    try {
      const response = await fetch("/api/ux-audit/lighthouse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: lighthouseUrl })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Lighthouse check failed.");
      setLighthouseResult(payload as LighthouseResult);
    } catch (cause) {
      setLighthouseError(cause instanceof Error ? cause.message : "Lighthouse check failed.");
    } finally { setLighthouseBusy(false); }
  }

  return (
    <main className="audit-workbench">
      <header className="audit-heading">
        <div>
          <Link href="/" className="audit-back">← UX Direct cockpit</Link>
          <div className="eyebrow" style={{ marginTop: 24 }}><span className="pulse" /> UX AUDIT & BENCHMARKING</div>
          <h1>Find friction. <em>Show the evidence.</em></h1>
          <p className="intro">Use the existing OpenRouter Model Gateway to audit supplied screenshots, label evidence regions, calibrate severity against the user goal, and compare named competitor pages.</p>
        </div>
      </header>

      <section className="audit-work-card">
        <form onSubmit={runAudit}>
          <div className="audit-form-grid">
            <label>Product / site
              <input value={product} onChange={(event) => setProduct(event.target.value)} required maxLength={120} />
            </label>
            <label>Journey / task
              <input value={journey} onChange={(event) => setJourney(event.target.value)} required maxLength={180} />
            </label>
            <label>Platform
              <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
                <option>desktop web</option><option>mobile web</option><option>iOS</option><option>Android</option>
              </select>
            </label>
            <label className="audit-goal-field">User goal
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} required maxLength={500} rows={3} />
            </label>
          </div>
          <label className="audit-screens-label" htmlFor="auditScreens">Screenshots to review</label>
          <textarea id="auditScreens" className="audit-screens-input" value={screenshotText} onChange={(event) => setScreenshotText(event.target.value)} rows={5} placeholder={"One screenshot per line:\nUjjivan SFB | Cards page | https://image.thum.io/get/width/1440/https://example.com/cards\nAU SFB | Cards page | https://your-public-r2-url/cards.png"} required />
          <p className="audit-help">Format: Site name | Page or journey step | Public HTTPS image URL. Use matched page types across sites for useful benchmarking. Screenshot images will be sent to the model provider selected in Model Gateway; do not send confidential client screens to an unapproved provider.</p>
          <button className="submit-button" type="submit" disabled={busy}>{busy ? "Auditing screenshots…" : "Run UX audit & benchmark →"}</button>
        </form>
      </section>

      {error ? <div className="audit-error" role="alert">{error}</div> : null}

      {report ? (
        <>
          <section className="audit-summary">
            <div><span className="audit-overline">EXECUTIVE SUMMARY</span><p>{report.summary}</p></div>
            <div className="audit-run-meta"><span>{auditResult?.provider} · {auditResult?.model}</span><span>{((auditResult?.latencyMs ?? 0) / 1000).toFixed(1)}s · {auditResult?.usage?.total_tokens ?? "?"} tokens reported</span></div>
          </section>

          <section className="audit-metrics">
            {[4,3,2,1].map((severity) => <div key={severity}><strong>{report.findings.filter((finding) => finding.kind === "issue" && finding.severity === severity).length}</strong><span>{SEVERITY_LABELS[severity as 1|2|3|4]}</span></div>)}
            <div><strong>{report.findings.filter((finding) => finding.kind === "positive").length}</strong><span>Strengths to keep</span></div>
            <div><strong>{report.benchmark.length}</strong><span>Comparison observations</span></div>
          </section>

          <section className="audit-section">
            <div className="audit-section-title"><div><h2>Evidence with region marking</h2><p>Boxes use normalized image coordinates, so they stay aligned when the screenshot resizes.</p></div></div>
            <div className="audit-evidence-grid">
              {screenshots.map((screenshot, index) => {
                const findings = findingsByScreenshot.get(index) ?? [];
                return <article className="audit-evidence-card" key={screenshot.url + index}>
                  <div className="audit-evidence-caption"><span>{screenshot.siteName}</span><strong>{screenshot.label}</strong></div>
                  <div className="audit-image-stage">
                    <img src={screenshot.url} alt={screenshot.siteName + " — " + screenshot.label} />
                    {findings.filter((finding) => finding.region).map((finding) => {
                      const region = regionToPercentStyle(finding.region!);
                      return <div key={finding.id} className="audit-region" style={{ ...region, borderColor: severityColor(finding), color: severityColor(finding) }} title={finding.title}>
                        <span style={{ background: severityColor(finding) }}>{finding.id}</span>
                      </div>;
                    })}
                  </div>
                  {findings.length ? <div className="audit-annotations-list">{findings.map((finding) => <div key={finding.id}><span style={{ color: severityColor(finding), fontWeight: 900 }}>{finding.id}</span><span>{finding.title}</span></div>)}</div> : <div className="audit-no-annotation">No finding assigned to this screenshot.</div>}
                </article>;
              })}
            </div>
          </section>

          <section className="audit-section">
            <div className="audit-section-title"><div><h2>Findings</h2><p>Stable recurring-check categories keep similar issues labelled consistently across audits.</p></div></div>
            <div className="audit-finding-list">
              {report.findings.map((finding) => <article key={finding.id} className="audit-finding">
                <div className="audit-finding-top">
                  <span className="audit-finding-id" style={{ color: severityColor(finding) }}>{finding.id}</span>
                  <span className="audit-category">{categoryTitle(finding.category)}</span>
                  <span className="audit-severity" style={{ color: severityColor(finding) }}>{finding.kind === "positive" ? "Positive" : SEVERITY_LABELS[finding.severity as 1|2|3|4]}</span>
                  <span className="audit-confidence">{Math.round(finding.confidence * 100)}% confidence</span>
                </div>
                <h3>{finding.title}</h3>
                <p><strong>Evidence.</strong> {finding.evidence}</p>
                <p><strong>Impact on goal.</strong> {finding.impact || "Not specified."}</p>
                <p><strong>Recommendation.</strong> {finding.recommendation}</p>
                {finding.heuristic ? <p className="audit-heuristic">Heuristic: {finding.heuristic}</p> : null}
                <div className="audit-source-link">Evidence source: {screenshots[finding.screenshotIndex]?.siteName} · {screenshots[finding.screenshotIndex]?.label}</div>
              </article>)}
            </div>
          </section>

          <section className="audit-section">
            <div className="audit-section-title"><div><h2>Competitor benchmark</h2><p>Comparisons use only named sites and visible evidence in the supplied screenshots.</p></div></div>
            {benchmarkSiteCount < 2
              ? <p style={{ padding: "14px 18px", margin: 0, color: "#748078", fontSize: 11, lineHeight: 1.6 }}>Add screenshots from at least two named sites to compare competitors. For a fair comparison, match the same page type or journey step across sites.</p>
              : report.benchmark.length
                ? <div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Criterion</th><th>Site</th><th>Relative position</th><th>Evidence</th><th>Opportunity</th></tr></thead>
                    <tbody>{report.benchmark.map((item, index) => <tr key={item.criterion + item.siteName + index}><td>{item.criterion}</td><td>{item.siteName}</td><td><span className={"audit-position audit-position-" + item.relativePosition}>{item.relativePosition.replace("-", " ")}</span></td><td>{item.evidence}</td><td>{item.improvementOpportunity || "—"}</td></tr>)}</tbody></table></div>
                : <p style={{ padding: "14px 18px", margin: 0, color: "#748078", fontSize: 11, lineHeight: 1.6 }}>No comparable observations were validated from this run. Check that screenshots show equivalent page types and that every site has a clear, unique name; retry with matched pages when appropriate.</p>}
          </section>

          {report.limitations.length ? <section className="audit-limitations"><strong>Not assessed / limitations</strong>{report.limitations.map((limitation, index) => <p key={index}>• {limitation}</p>)}</section> : null}
          <div className="audit-raw-toggle"><button type="button" onClick={() => setShowRaw(!showRaw)}>{showRaw ? "Hide" : "Show"} report JSON</button></div>
          {showRaw ? <JsonReport value={report} /> : null}
        </>
      ) : null}

      <section className="audit-work-card audit-lighthouse-card">
        <div className="audit-section-title"><div><h2>Technical quality · Lighthouse</h2><p>Runs the Browserless Performance endpoint. It is a separate measurement from the screenshot-based UX judgement.</p></div></div>
        <form className="audit-lighthouse-form" onSubmit={runLighthouse}>
          <label htmlFor="lighthouseUrl">Public HTTPS website URL</label>
          <div><input id="lighthouseUrl" type="url" value={lighthouseUrl} onChange={(event) => setLighthouseUrl(event.target.value)} placeholder="https://www.example.com" required /><button type="submit" className="submit-button" disabled={lighthouseBusy}>{lighthouseBusy ? "Checking…" : "Run Lighthouse"}</button></div>
        </form>
        {lighthouseError ? <div className="audit-error" role="alert">{lighthouseError}</div> : null}
        {lighthouseResult ? <div className="audit-lighthouse-result"><p><strong>Provider:</strong> {lighthouseResult.provider} · <strong>Checked:</strong> {new Date(lighthouseResult.checkedAt).toLocaleString()}</p><JsonReport value={lighthouseResult.report} /></div> : null}
      </section>

      <footer className="audit-footer">UX DIRECT <span>·</span> OPENROUTER-POWERED AUDIT / EVIDENCE-BASED BENCHMARKING</footer>
      <style jsx global>{`
        .audit-workbench{min-height:100vh;background:#fbfcfa;color:#17211f;padding:42px clamp(18px,4vw,64px) 28px}
        .audit-heading{max-width:1400px;margin:0 auto 28px}.audit-back{color:#466956;text-decoration:none;font-size:12px;font-weight:800}
        .audit-workbench h1{font-family:Manrope,sans-serif;font-size:clamp(32px,4vw,48px);line-height:1.08;letter-spacing:-1.8px;margin:0 0 14px}
        .audit-work-card,.audit-summary,.audit-section,.audit-limitations{max-width:1400px;margin:0 auto 18px;border:1px solid #e4e9e3;border-radius:16px;background:#fff;box-shadow:0 4px 20px rgba(28,55,42,.035)}
        .audit-work-card{padding:20px}.audit-form-grid{display:grid;grid-template-columns:1fr 1fr 180px;gap:14px}.audit-form-grid label,.audit-lighthouse-form label{display:flex;flex-direction:column;gap:6px;font-size:11px;font-weight:800;color:#65766c}
        .audit-form-grid input,.audit-form-grid select,.audit-form-grid textarea,.audit-screens-input,.audit-lighthouse-form input{width:100%;border:1px solid #dfe6df;border-radius:9px;background:#fff;padding:11px 12px;color:#17211f;font:inherit;font-size:12px;outline-offset:2px}
        .audit-goal-field{grid-column:1/-1}.audit-form-grid textarea,.audit-screens-input{resize:vertical;line-height:1.5}.audit-screens-label{display:block;margin:18px 0 7px;font-size:11px;font-weight:800;color:#65766c}
        .audit-screens-input{font-family:ui-monospace,monospace;font-size:11px}.audit-help{font-size:11px;color:#748078;line-height:1.55;margin:10px 0 16px}
        .audit-error{max-width:1400px;margin:0 auto 16px;border:1px solid #f0c7bc;background:#fff3ef;color:#963f2c;padding:12px 15px;border-radius:10px;font-size:12px}
        .audit-summary{padding:20px;display:flex;justify-content:space-between;gap:25px;align-items:start}.audit-overline{font-size:9px;font-weight:900;letter-spacing:.12em;color:#71836f}.audit-summary p{font-size:14px;line-height:1.65;max-width:900px;margin-bottom:0}.audit-run-meta{min-width:190px;display:flex;flex-direction:column;gap:6px;color:#748078;font-size:10px}
        .audit-metrics{max-width:1400px;display:flex;gap:10px;flex-wrap:wrap;margin:0 auto 18px}.audit-metrics div{background:#fff;border:1px solid #e4e9e3;border-radius:12px;padding:13px 16px;min-width:110px}.audit-metrics strong,.audit-metrics span{display:block}.audit-metrics strong{font:800 22px Manrope,sans-serif}.audit-metrics span{font-size:10px;color:#748078;margin-top:4px}
        .audit-section{overflow:hidden}.audit-section-title{padding:16px 18px;border-bottom:1px solid #edf0eb;display:flex;align-items:center;justify-content:space-between;gap:10px}.audit-section-title h2{font-size:15px;margin:0 0 5px}.audit-section-title p{margin:0;font-size:10px;color:#748078;line-height:1.5}
        .audit-evidence-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px;padding:16px}.audit-evidence-card{border:1px solid #edf0eb;border-radius:12px;overflow:hidden;min-width:0}.audit-evidence-caption{padding:10px 12px;display:flex;flex-direction:column;gap:4px}.audit-evidence-caption span{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#71836f;font-weight:800}.audit-evidence-caption strong{font-size:12px}.audit-image-stage{position:relative;width:100%;background:#f2f5f1;overflow:hidden}.audit-image-stage img{display:block;width:100%;height:auto;min-height:120px;object-fit:contain}.audit-region{position:absolute;border:2px solid;border-radius:5px;pointer-events:none;box-shadow:0 0 0 999px rgba(15,35,25,.04)}.audit-region span{position:absolute;left:-2px;top:-2px;color:white;font-size:9px;line-height:1;padding:4px 5px;border-radius:4px;font-weight:900}
        .audit-annotations-list{padding:10px 12px;display:flex;flex-direction:column;gap:7px}.audit-annotations-list div{display:flex;gap:8px;font-size:10px;line-height:1.45}.audit-no-annotation{padding:12px;font-size:10px;color:#748078}
        .audit-finding-list{padding:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}.audit-finding{border:1px solid #edf0eb;border-radius:12px;padding:14px}.audit-finding-top{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.audit-finding-id{font:900 10px ui-monospace,monospace}.audit-category{font-size:9px;background:#f1f5ef;border-radius:5px;padding:4px 6px;color:#53695a}.audit-severity{margin-left:auto;font-size:10px;font-weight:900}.audit-confidence{font-size:9px;color:#849087}.audit-finding h3{font-size:14px;margin:13px 0 10px;line-height:1.4}.audit-finding p{font-size:11px;line-height:1.6;margin:7px 0;color:#53605a}.audit-finding p strong{color:#25352c}.audit-finding .audit-heuristic{color:#68766c;font-style:italic}.audit-source-link{margin-top:11px;border-top:1px solid #edf0eb;padding-top:9px;color:#7b867e;font-size:9px}
        .audit-table-wrap{overflow:auto}.audit-table{border-collapse:collapse;width:100%;font-size:11px}.audit-table th,.audit-table td{padding:12px;border-bottom:1px solid #edf0eb;text-align:left;vertical-align:top;min-width:100px;max-width:360px;line-height:1.5}.audit-table th{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#748078;background:#fafbf9}.audit-position{font-size:9px;text-transform:uppercase;white-space:nowrap;font-weight:900}.audit-position-stronger{color:#31825d}.audit-position-at-par{color:#65766c}.audit-position-weaker{color:#b83f36}.audit-position-not-comparable{color:#8b8e88}
        .audit-limitations{padding:16px 20px;font-size:11px;color:#58665d}.audit-limitations strong{display:block;margin-bottom:7px}.audit-limitations p{margin:5px 0;line-height:1.55}.audit-raw-toggle{max-width:1400px;margin:0 auto 10px;text-align:right}.audit-raw-toggle button{border:1px solid #dfe6df;border-radius:8px;background:#fff;padding:8px 12px;font-size:10px;color:#56665a}
        .audit-lighthouse-card{margin-top:30px}.audit-lighthouse-form{margin-top:16px}.audit-lighthouse-form>div{display:flex;gap:10px;margin-top:7px}.audit-lighthouse-form input{flex:1}.audit-lighthouse-result{margin-top:16px}.audit-lighthouse-result p{font-size:10px;color:#69766e}.audit-footer{max-width:1400px;margin:28px auto 0;text-align:right;font-size:9px;letter-spacing:.14em;font-weight:800;color:#758078}.audit-footer span{color:#b6c8b4;margin:0 6px}
        @media(max-width:760px){.audit-workbench{padding-top:24px}.audit-form-grid{grid-template-columns:1fr}.audit-goal-field{grid-column:auto}.audit-summary{flex-direction:column}.audit-run-meta{min-width:0}.audit-lighthouse-form>div{flex-direction:column}}
      `}</style>
    </main>
  );
}
