"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { buildHealthSmokeChecks, inspectHealthReport, type SmokeCheckResult } from "@/src/quality/health-report";
import { FIGMA_ACTION_CATALOGUE, summarizeActionCatalogue } from "@/src/quality/figma-action-catalogue";

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
type ConnectionsSnapshot = {
  health: Health;
  events: EventItem[] | null;
  bridgeSessions: PluginSession[];
  latestSavedReport: PersistedHealthReport | null;
  bridgeReachable: boolean;
  refreshedAt: string;
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

type GatewayMode = "free" | "paid" | "local" | "mock";
type ModulePolicy = { enabled:boolean; mode:GatewayMode; selectedModelKey:string; monthlyBudgetInr:number; maxRequestCostInr:number; allowFallback:boolean };
type ModelPolicy = { monthlyBudgetInr:number; maxRequestCostInr:number; inputPriceInrPerMillion:number; outputPriceInrPerMillion:number };
type GatewaySettings = { version:1; globalMonthlyBudgetInr:number; usdToInrRate:number; paidRoutingEnabled:boolean; modules:Record<string,ModulePolicy>; models:Record<string,ModelPolicy>; updatedAt?:string };
type GatewayModule = { id:string; label:string; description:string; alias:string; tasks:string[]; suggestedBudgetShare:number };
type GatewayModel = { id:string; provider:string; label:string; tier:string; tasks:string[]; configured:boolean; notes:string; selectionKey:string; usdInputPerMillion?:number; usdOutputPerMillion?:number; pricingSource?:string; pricingReviewedAt?:string };
type GatewayDashboardPayload = {
 gateway:{name:string;status:string;paidModelsEnabled:boolean;monthlyBudgetInr:number;pricingConfigured:boolean;gatewayFeeInr:number};
 providers:Array<{id:string;label:string;envName:string;configured:boolean;keyDetected:boolean;tier:string;secretRequired:boolean}>;
 models:GatewayModel[]; modules:GatewayModule[]; settings:GatewaySettings;
 budget:{currency:string;monthlyBudgetInr:number;spentThisMonthInr:number;remainingInr:number;percentUsed:number;inputPriceInrPerMillion:number;outputPriceInrPerMillion:number;pricingConfigured:boolean;month:string;
 records:Array<{id:string;at:string;requestId:string;provider:string;model:string;moduleId?:string;tier:string;promptTokens:number;completionTokens:number;totalTokens:number;usageReported?:boolean;estimatedCostInr:number;latencyMs:number;status:string;note?:string}>;
 retention:string;spentByModuleInr:Record<string,number>;spentByModelInr:Record<string,number>;paidCallsThisMonth:number};
 checkedAt:string;
};
function inr(value:number){return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:value<10?4:2}).format(value);}
function modeCompatible(mode:GatewayMode,m:GatewayModel){if(mode==="free")return m.tier==="free-tier"||m.id.endsWith(":free");if(mode==="local")return m.tier==="local";if(mode==="mock")return m.tier==="mock";return m.tier!=="local"&&m.tier!=="mock"&&!m.id.endsWith(":free");}
function exampleModelCost(policy:ModelPolicy){return (100000*policy.inputPriceInrPerMillion+20000*policy.outputPriceInrPerMillion)/1_000_000;}
function ModelGatewayPanel(){
 const [data,setData]=useState<GatewayDashboardPayload|null>(null);
 const [draft,setDraft]=useState<GatewaySettings|null>(null);
 const [busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[smokeBusy,setSmokeBusy]=useState(false);
 const [smokeMessage,setSmokeMessage]=useState(""),[message,setMessage]=useState(""),[loadError,setLoadError]=useState("");
 const [adminKey,setAdminKey]=useState("");
 const [filter,setFilter]=useState("all");
 const dirty=useRef(false);
 const load=useCallback(async()=>{
  setBusy(true);
  try{const r=await fetch("/api/model-gateway/dashboard",{cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error||"Could not load gateway dashboard.");setData(p as GatewayDashboardPayload);if(!dirty.current)setDraft((p as GatewayDashboardPayload).settings);setLoadError("");}
  catch(e){setLoadError(e instanceof Error?e.message:"Gateway dashboard unavailable.");}finally{setBusy(false);}
 },[]);
 useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),60000);return()=>window.clearInterval(timer);},[load]);
 function mutate(fn:(s:GatewaySettings)=>GatewaySettings){dirty.current=true;setMessage("Unsaved changes");setDraft(s=>s?fn(s):s);}
 function updateModule(id:string,patch:Partial<ModulePolicy>){mutate(s=>({...s,modules:{...s.modules,[id]:{...s.modules[id],...patch}}}));}
 function updateModel(key:string,patch:Partial<ModelPolicy>){mutate(s=>({...s,models:{...s.models,[key]:{...s.models[key],...patch}}}));}
 async function save(){
  if(!draft||saving)return;setSaving(true);setMessage("");
  try{const r=await fetch("/api/model-gateway/settings",{method:"PUT",headers:{"Content-Type":"application/json","x-model-gateway-admin-key":adminKey},cache:"no-store",body:JSON.stringify(draft)});const p=await r.json();if(!r.ok)throw new Error(p.error||"Could not save settings.");dirty.current=false;setDraft(p.settings);setMessage("Saved · current preview/environment only");await load();}
  catch(e){setMessage(e instanceof Error?e.message:"Save failed.");}finally{setSaving(false);}
 }
 async function smoke(){
  if(smokeBusy)return;setSmokeBusy(true);setSmokeMessage("");
  try{const r=await fetch("/api/model-gateway/smoke",{method:"POST",cache:"no-store"});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||"Smoke test failed.");setSmokeMessage("Passed · 0 tokens · ₹0 · no provider call · request "+String(p.requestId).slice(0,8));await load();}
  catch(e){setSmokeMessage(e instanceof Error?e.message:"Smoke test failed.");}finally{setSmokeBusy(false);}
 }
 const models=data?.models??[], modules=data?.modules??[], settings=draft, records=data?.budget.records??[];
 const spent=data?.budget.spentThisMonthInr??0, globalCap=settings?.globalMonthlyBudgetInr??3000, remaining=Math.max(0,globalCap-spent), fx=settings?.usdToInrRate??97;
 const keyReady=(data?.providers??[]).filter(p=>p.keyDetected).length;
 function policyFor(m:GatewayModel):ModelPolicy{return settings?.models[m.selectionKey]??{monthlyBudgetInr:500,maxRequestCostInr:50,inputPriceInrPerMillion:(m.usdInputPerMillion??0)*fx,outputPriceInrPerMillion:(m.usdOutputPerMillion??0)*fx};}
 function recommendation(module:GatewayModule,mode:GatewayMode){const choices=models.filter(m=>modeCompatible(mode,m)&&(mode!=="paid"||(policyFor(m).inputPriceInrPerMillion>0&&policyFor(m).outputPriceInrPerMillion>0)));const fit=(m:GatewayModel)=>m.tasks.some(t=>module.tasks.some(w=>t.toLowerCase().includes(w.toLowerCase())||w.toLowerCase().includes(t.toLowerCase())))?1:0;choices.sort((a,b)=>fit(b)-fit(a)||Number(b.configured)-Number(a.configured)||(mode==="paid"?exampleModelCost(policyFor(a))-exampleModelCost(policyFor(b)):0)||a.label.localeCompare(b.label));return choices[0]??null;}
 const modeOptions=(mode:GatewayMode)=>models.filter(m=>modeCompatible(mode,m)).sort((a,b)=>Number(b.configured)-Number(a.configured)||a.label.localeCompare(b.label));
 function applySuggestion(module:GatewayModule,mode:GatewayMode){const m=recommendation(module,mode);if(!m)return;updateModule(module.id,{mode,selectedModelKey:m.selectionKey});setMessage("Selected "+m.label+" for "+module.label+". Save to apply.");}
  return <div className="content gateway-content accountant-content">
  <div className="eyebrow"><span className="pulse"/> MODEL OPERATIONS · ACCOUNTANT</div>
  <div className="gateway-title-row"><div><h1>Model gateway.<br/><em>Every rupee accounted for.</em></h1><p className="intro">Control each agent independently. Pick its exact model and free/paid/local mode, set global, module and model budgets, and see where every token and rupee goes.</p></div>
   <div className="gateway-header-actions"><button className="secondary-button" type="button" onClick={()=>void smoke()} disabled={smokeBusy}>{smokeBusy?"Testing…":"Run free smoke test ↗"}</button><button className="submit-button" type="button" onClick={()=>void load()} disabled={busy}>{busy?"Refreshing…":"Refresh ↻"}</button></div></div>
  {loadError&&<p className="inline-note" role="alert">{loadError}</p>}{smokeMessage&&<p className="gateway-smoke-message" role="status">{smokeMessage}</p>}
  <div className="gateway-mode-banner"><span className={"gateway-status-dot "+(settings?.paidRoutingEnabled?"gateway-dot-live":"gateway-dot-idle")}/><div><strong>{settings?.paidRoutingEnabled?"Paid routing switch ON":"Free-first setup · paid routing OFF"}</strong><p>{settings?.paidRoutingEnabled?"Every paid request still requires server opt-in, keys, per-model prices and budget checks.":"You can configure modules before adding API keys. Paid requests remain locked by default."}</p></div><span className="gateway-fee">₹0 gateway fee</span></div>
  <section className="gateway-panel accountant-global-panel">
   <div className="gateway-panel-heading"><div><span className="section-kicker">GLOBAL FINANCIAL GUARDRAILS</span><h2>One account · separate envelopes</h2></div><span className={"status-chip "+(remaining<=0?"status-error":globalCap>0&&spent/globalCap>=.8?"status-warning":"status-success")}>{globalCap>0?Math.round(spent/globalCap*100):100}% used</span></div>
   <div className="accountant-summary-grid">
    <article className="gateway-stat-card"><span>MONTH-TO-DATE SPEND</span><strong>{inr(spent)}</strong><small>{data?.budget.month??"Current month"} · estimated</small></article>
    <article className="gateway-stat-card"><span>GLOBAL MONTHLY CAP</span><strong>{inr(globalCap)}</strong><small>Paid-call guardrail</small></article>
    <article className="gateway-stat-card"><span>AVAILABLE BALANCE</span><strong>{inr(remaining)}</strong><small>Gateway fee ₹0</small></article>
    <article className="gateway-stat-card"><span>REQUEST ACCOUNTING</span><strong>{records.length} calls</strong><small>{records.reduce((s,r)=>s+r.totalTokens,0).toLocaleString("en-IN")} tokens · {data?.budget.paidCallsThisMonth??0} paid-mode calls</small></article>
   </div>
   <div className="budget-track"><div className={"budget-fill "+(globalCap>0&&spent/globalCap>=.8?"budget-fill-warning":"")} style={{width:Math.min(100,globalCap>0?spent/globalCap*100:100)+"%"}}/></div>
   <div className="accountant-global-controls">
    <label className="gateway-control-field"><span>Global monthly budget (₹)</span><input type="number" min="0" step="100" value={globalCap} onChange={e=>mutate(s=>({...s,globalMonthlyBudgetInr:Math.max(0,Number(e.target.value)||0)}))}/></label>
    <label className="gateway-control-field"><span>USD → INR rate</span><input type="number" min="1" max="250" step=".5" value={fx} onChange={e=>mutate(s=>({...s,usdToInrRate:Math.max(1,Math.min(250,Number(e.target.value)||97))}))}/><small>Used to convert published USD rate suggestions; editable.</small></label>
    <label className="gateway-master-toggle"><input type="checkbox" checked={settings?.paidRoutingEnabled??false} onChange={e=>mutate(s=>({...s,paidRoutingEnabled:e.target.checked}))}/><span><strong>Allow paid routing</strong><small>Master switch · also needs server-side ALLOW_PAID_MODELS=true</small></span></label>
   </div>
   <p className="gateway-footnote">{data?.budget.retention==="netlify-blobs"?"Branch-scoped Netlify Blobs persistence is active.":"Runtime fallback may reset on serverless restarts."} Blob storage is not transactional: simultaneous paid requests can race a cap. Treat budgets as best-effort until transactional reservations are implemented.</p>
  </section>
  <div className="gateway-section-heading"><div><span className="section-kicker">01 · MODULE CONTROL</span><h2>One model policy per agent</h2><p>Switch modules on/off. Choose a mode and exact model, then define monthly and per-request caps.</p></div><span className="count">{modules.filter(m=>settings?.modules[m.id]?.enabled).length} / {modules.length} ON</span></div>
  <div className="gateway-module-grid">{modules.map(module=>{const p=settings?.modules[module.id];if(!p)return null;const chosen=models.find(m=>m.selectionKey===p.selectedModelKey);const rec=recommendation(module,p.mode);const paidRec=recommendation(module,"paid");const used=data?.budget.spentByModuleInr?.[module.id]??0;return <article className={"gateway-module-card "+(!p.enabled?"module-disabled":"")} key={module.id}>
   <div className="gateway-module-head"><div><span className="section-kicker">{module.id.toUpperCase()}</span><h3>{module.label}</h3></div><label className="gateway-switch"><input type="checkbox" checked={p.enabled} onChange={e=>updateModule(module.id,{enabled:e.target.checked})}/><span>{p.enabled?"ON":"OFF"}</span></label></div>
   <p className="gateway-module-description">{module.description}</p>
   <div className="gateway-module-usage"><span>Spent {inr(used)}</span><strong>{inr(Math.max(0,p.monthlyBudgetInr-used))} remaining</strong></div><div className="budget-track"><div className={"budget-fill "+(p.monthlyBudgetInr>0&&used/p.monthlyBudgetInr>=.8?"budget-fill-warning":"")} style={{width:Math.min(100,p.monthlyBudgetInr?used/p.monthlyBudgetInr*100:100)+"%"}}/></div>
   <label className="gateway-control-field"><span>Mode</span><select value={p.mode} onChange={e=>{const mode=e.target.value as GatewayMode;const keep=p.selectedModelKey==="auto"||models.some(m=>m.selectionKey===p.selectedModelKey&&modeCompatible(mode,m));updateModule(module.id,{mode,...(!keep?{selectedModelKey:"auto"}:{})});}}><option value="free">Free tier only · estimated ₹0</option><option value="paid">Paid API · budgets enforced</option><option value="local">Local model</option><option value="mock">Mock only · no AI</option></select></label>
   <label className="gateway-control-field"><span>Exact model <i>{p.selectedModelKey==="auto"?"Auto within mode":"Strict allowlist"}</i></span><select disabled={!p.enabled} value={p.selectedModelKey} onChange={e=>updateModule(module.id,{selectedModelKey:e.target.value})}><option value="auto">Auto recommendation · selected mode only</option>{modeOptions(p.mode).map(m=><option key={m.selectionKey} value={m.selectionKey}>{m.label}{m.configured?" · connected":" · not connected"}</option>)}</select></label>
   {chosen&&<p className="gateway-selected-note"><span className={"status-dot-inline "+(chosen.configured?"green":"amber")}/>{chosen.configured?"Configured":"Not connected; request will be blocked"} · {chosen.notes}</p>}
   <div className="gateway-policy-budget-row"><label className="gateway-control-field"><span>Module budget / month (₹)</span><input type="number" min="0" step="50" value={p.monthlyBudgetInr} onChange={e=>updateModule(module.id,{monthlyBudgetInr:Math.max(0,Number(e.target.value)||0)})}/></label><label className="gateway-control-field"><span>Max cost / request (₹)</span><input type="number" min="0" step="1" value={p.maxRequestCostInr} onChange={e=>updateModule(module.id,{maxRequestCostInr:Math.max(0,Number(e.target.value)||0)})}/></label></div>
   <div className="gateway-recommendation"><div><strong>Current-mode suggestion</strong><p>{rec?rec.label+" — task fit and connection status guide this choice." : "No catalog option for this mode yet."}</p></div>{rec&&<button className="text-button" type="button" onClick={()=>applySuggestion(module,p.mode)}>Use suggestion ↗</button>}</div>
   {p.mode!=="paid"&&paidRec&&<div className="gateway-recommendation paid-recommendation"><div><strong>Paid alternative · cost-aware</strong><p>{paidRec.label} — estimated {inr(exampleModelCost(policyFor(paidRec)))} for 100k input + 20k output tokens. {paidRec.configured?"Provider configured, live health unverified.":"Provider/key not configured."} Suggestion only; this does not activate billing.</p></div><button className="text-button" type="button" onClick={()=>applySuggestion(module,"paid")}>Switch module to paid ↗</button></div>}
  </article>;})}</div>
  <div className="gateway-section-heading"><div><span className="section-kicker">02 · MODEL ACCOUNTANT</span><h2>Price and limit every model</h2><p>Rates are INR per 1 million tokens. Example assumes 100k input + 20k output tokens. No live health/pricing calls are made.</p></div><span className="count">{models.length} MODEL OPTIONS</span></div>
  <section className="gateway-panel model-accountant-panel"><div className="model-catalog-toolbar"><label className="gateway-control-field"><span>Filter models</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All</option><option value="connected">Connected only</option><option value="free">Free-tier candidates</option><option value="paid">Billable models</option><option value="local">Local models</option></select></label><span className="gateway-footnote">Published rates are editable suggestions, not a live quote.</span></div>
   <div className="model-accountant-table-wrap"><table className="gateway-table model-pricing-table"><thead><tr><th>MODEL / TASKS</th><th>TIER / STATUS</th><th>INPUT ₹ / 1M</th><th>OUTPUT ₹ / 1M</th><th>MONTHLY CAP</th><th>MAX / REQUEST</th><th>EXAMPLE COST</th><th>PRICE SOURCE</th></tr></thead><tbody>
    {models.filter(m=>filter==="all"||(filter==="connected"&&m.configured)||(filter==="free"&&(m.tier==="free-tier"||m.id.endsWith(":free")))||(filter==="paid"&&modeCompatible("paid",m))||(filter==="local"&&m.tier==="local")).map(m=>{const p=policyFor(m);return <tr key={m.selectionKey}><td><strong>{m.label}</strong><small>{m.tasks.join(" · ")}</small><small>{m.notes}</small></td><td><span className={"gateway-tier tier-"+m.tier}>{m.tier}</span><small>{m.configured?"Configured":"Not connected"}</small></td>
     <td><input className="model-price-input" aria-label={m.label+" input price"} type="number" min="0" step=".01" value={p.inputPriceInrPerMillion} onChange={e=>updateModel(m.selectionKey,{inputPriceInrPerMillion:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><input className="model-price-input" aria-label={m.label+" output price"} type="number" min="0" step=".01" value={p.outputPriceInrPerMillion} onChange={e=>updateModel(m.selectionKey,{outputPriceInrPerMillion:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><input className="model-price-input" aria-label={m.label+" monthly cap"} type="number" min="0" step="50" value={p.monthlyBudgetInr} onChange={e=>updateModel(m.selectionKey,{monthlyBudgetInr:Math.max(0,Number(e.target.value)||0)})}/><small>Spent {inr(data?.budget.spentByModelInr?.[m.selectionKey]??0)}</small></td>
     <td><input className="model-price-input" aria-label={m.label+" per-request cap"} type="number" min="0" step="1" value={p.maxRequestCostInr} onChange={e=>updateModel(m.selectionKey,{maxRequestCostInr:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><strong>{inr(exampleModelCost(p))}</strong>{m.usdInputPerMillion!==undefined&&<small>${m.usdInputPerMillion.toFixed(3)} / ${(m.usdOutputPerMillion??0).toFixed(3)} USD per 1M</small>}</td>
     <td>{m.pricingSource?<><a href={m.pricingSource} target="_blank" rel="noreferrer">Official pricing ↗</a><small>Checked {m.pricingReviewedAt??"date unavailable"}</small><button className="text-button apply-price" type="button" onClick={()=>updateModel(m.selectionKey,{inputPriceInrPerMillion:Number(((m.usdInputPerMillion??0)*fx).toFixed(4)),outputPriceInrPerMillion:Number(((m.usdOutputPerMillion??0)*fx).toFixed(4))})}>Apply USD→INR suggestion</button></>:<small>Enter published provider prices before paid mode.</small>}</td>
    </tr>;})}
   </tbody></table></div>
   <p className="gateway-footnote">A free-mode request is only costed at ₹0 when the provider account/request uses its actual free tier; quota policies still apply. Paid mode applies configured rates even to providers that also offer free quotas. Estimates exclude taxes, caching and search/tool charges unless those are included in entered prices.</p>
  </section>
  <div className="gateway-section-heading"><div><span className="section-kicker">03 · PROVIDER REGISTRY</span><h2>API key placeholders</h2></div><span className="count">{keyReady} KEYS DETECTED</span></div>
  <div className="gateway-provider-grid">{(data?.providers??[]).map(p=><article className="gateway-provider-card" key={p.id}><div className="gateway-provider-top"><span className="gateway-provider-mark">{p.label.split(" ").map(w=>w[0]).join("").slice(0,2)}</span><span className={"status-chip "+(p.configured?"status-success":"status-neutral")}>{p.configured?"Configured · unverified":p.keyDetected?"Key detected · setup incomplete":p.tier==="local"?"Endpoint not configured":"Key not added"}</span></div><h3>{p.label}</h3><p>{p.tier==="paid"?"Paid provider · opt-in required":p.tier==="local"?"Local inference · no API token charge":"Free-tier candidate · verify account and quotas"}</p><label className="gateway-key-label" htmlFor={"key-slot-"+p.id}>{p.envName}</label><div className="gateway-key-placeholder"><input id={"key-slot-"+p.id} type="password" placeholder={p.secretRequired?"API key placeholder · final step":"Local endpoint placeholder"} disabled readOnly aria-label={p.envName+" placeholder; edit disabled"}/><span>{p.keyDetected?"KEY DETECTED":p.configured?"CONNECTED":"PLACEHOLDER"}</span></div><small className="gateway-provider-note">No keys are collected or stored in the dashboard. Add credentials later through server-side environment variables.</small></article>)}</div>
  <div className="gateway-section-heading"><div><span className="section-kicker">04 · TOKEN LEDGER</span><h2>Every request attributed to a purpose</h2><p>Usage, model, latency, status and estimated cost; prompt/response content is never shown.</p></div><span className="count">{Math.min(records.length,200)} / 200 RECORDS</span></div>
  <section className="gateway-panel token-ledger-panel"><div className="token-ledger-intro"><div><strong>Request-by-request accounting</strong><p>Current month only; cost is estimated from configured rates.</p></div><span className="ledger-retention">{data?.budget.retention==="netlify-blobs"?"Persistent · scoped ledger":"Runtime fallback"}</span></div>
   {records.length===0?<div className="gateway-empty-state"><div className="gateway-empty-icon">◷</div><strong>No model calls recorded this month</strong><p>Mock smoke test verifies wiring at ₹0 but isn&apos;t AI inference.</p></div>:<div className="token-ledger-table-wrap"><table className="gateway-table token-table"><thead><tr><th>TIME / REQUEST</th><th>MODULE</th><th>MODEL</th><th>INPUT</th><th>OUTPUT</th><th>TOTAL</th><th>EST. COST</th><th>LATENCY</th></tr></thead><tbody>{records.map(r=><tr key={r.id}><td><strong>{new Date(r.at).toLocaleString()}</strong><small>#{r.requestId.slice(0,8)} · {r.status}</small></td><td>{modules.find(m=>m.id===r.moduleId)?.label??r.moduleId??"Unattributed"}</td><td><strong>{r.model}</strong><small>{r.provider} · {r.tier}</small></td><td>{r.usageReported===false?"—":r.promptTokens.toLocaleString("en-IN")}</td><td>{r.usageReported===false?"—":r.completionTokens.toLocaleString("en-IN")}</td><td>{r.usageReported===false?"Unavailable":r.totalTokens.toLocaleString("en-IN")}</td><td>{inr(r.estimatedCostInr)}</td><td>{r.latencyMs.toLocaleString("en-IN")} ms</td></tr>)}</tbody></table></div>}
  </section>
  <div className="gateway-savebar"><div><strong>{dirty.current?"Unsaved configuration":message||"Settings saved"}</strong><p>Applies to this Netlify environment/branch only. Provider API keys stay server-side. Saving requires the server-side MODEL_GATEWAY_ADMIN_KEY.</p></div><label className="gateway-admin-key"><span>Gateway settings admin key</span><input type="password" autoComplete="off" value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="Enter admin key to save" aria-label="Gateway settings admin key" /><small>Kept in memory only; never saved in browser storage.</small></label><button className="submit-button" type="button" onClick={()=>void save()} disabled={!draft||saving||!dirty.current}>{saving?"Saving…":"Save gateway settings ↗"}</button></div>
  {message&&<p className="gateway-smoke-message" role="status">{message}</p>}
  <p className="gateway-footer-note">Last refreshed {data?.checkedAt?new Date(data.checkedAt).toLocaleTimeString():"not checked"}. Dashboard refresh is one read-only GET per minute; it never calls providers or Figma.</p>
  <footer>UX DIRECT <span>·</span> TECHNICAL ACCOUNTANT / MODEL GATEWAY</footer>
 </div>;
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
  const [smokeChecks, setSmokeChecks] = useState<SmokeCheckResult[] | null>(null);
  const [smokeCheckedAt, setSmokeCheckedAt] = useState<string | null>(null);
  const [smokeBusy, setSmokeBusy] = useState(false);

  const readConnectionsSnapshot = useCallback(async (): Promise<ConnectionsSnapshot> => {
    const [healthResponse, eventsResponse, bridgeResponse] = await Promise.all([
      fetch(API + "/api/health", { cache: "no-store" }),
      fetch(API + "/api/telemetry?limit=30", { cache: "no-store" }),
      fetch(API + "/api/plugin-bridge?mode=sessions", { cache: "no-store" }).catch(() => null),
    ]);
    if (!healthResponse.ok) throw new Error("Health endpoint returned " + healthResponse.status);
    const nextHealth = await healthResponse.json() as Health;
    let nextEvents: EventItem[] | null = null;
    if (eventsResponse.ok) {
      const payload = await eventsResponse.json();
      nextEvents = Array.isArray(payload.events) ? payload.events as EventItem[] : [];
    }

    let nextSessions: PluginSession[] = [];
    let nextSavedReport: PersistedHealthReport | null = null;
    if (bridgeResponse?.ok) {
      const bridgePayload = await bridgeResponse.json();
      nextSessions = Array.isArray(bridgePayload.sessions) ? bridgePayload.sessions as PluginSession[] : [];
      nextSavedReport = bridgePayload.latestReport ?? null;
    }
    return {
      health: nextHealth,
      events: nextEvents,
      bridgeSessions: nextSessions,
      latestSavedReport: nextSavedReport,
      bridgeReachable: Boolean(bridgeResponse?.ok),
      refreshedAt: new Date().toISOString(),
    };
  }, []);

  const applyConnectionsSnapshot = useCallback((snapshot: ConnectionsSnapshot) => {
    setHealth(snapshot.health);
    setHealthError("");
    if (snapshot.events) setEvents(snapshot.events);
    setBridgeSessions(snapshot.bridgeSessions);
    setLatestSavedReport(snapshot.latestSavedReport);
    setLastRefresh(snapshot.refreshedAt);
  }, []);

  const refreshConnections = useCallback(async () => {
    setRefreshingConnections(true);
    try {
      const snapshot = await readConnectionsSnapshot();
      applyConnectionsSnapshot(snapshot);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Backend health check failed");
    } finally {
      setRefreshingConnections(false);
    }
  }, [applyConnectionsSnapshot, readConnectionsSnapshot]);

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

  async function runHealthSmokeTest() {
    setSmokeBusy(true);
    setSmokeChecks(null);
    try {
      // One bounded snapshot (health + log + bridge) is reused for every assertion.
      // Smoke checks never trigger Figma actions or issue per-check telemetry.
      const snapshot = await readConnectionsSnapshot();
      applyConnectionsSnapshot(snapshot);
      const orderedSessions = [...snapshot.bridgeSessions].sort((a, b) => Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt));
      const onlineSession = orderedSessions.find((session) => session.isOnline) ?? null;
      const report = snapshot.latestSavedReport?.healthReport
        ?? onlineSession?.healthReport
        ?? orderedSessions[0]?.healthReport
        ?? null;
      setSmokeChecks(buildHealthSmokeChecks({
        backendHealthy: snapshot.health.status === "ok" && snapshot.health.deployment?.platform === "netlify",
        bridgeReachable: snapshot.bridgeReachable,
        pluginOnline: Boolean(onlineSession),
        report,
      }));
      setSmokeCheckedAt(snapshot.refreshedAt);
    } catch (err) {
      setSmokeChecks([{
        name: "Snapshot retrieval",
        status: "fail",
        message: err instanceof Error ? err.message : "Could not retrieve the health snapshot.",
      }]);
      setSmokeCheckedAt(new Date().toISOString());
    } finally {
      setSmokeBusy(false);
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
  const latestPluginAudit = latestPluginTest ? inspectHealthReport(latestPluginTest) : null;
  const smokePassed = smokeChecks?.filter((item) => item.status === "pass").length ?? 0;
  const smokeFailed = smokeChecks?.filter((item) => item.status === "fail").length ?? 0;
  const smokeBlocked = smokeChecks?.filter((item) => item.status === "blocked").length ?? 0;
  const breadcrumb = navItems.find((item) => item.id === activeTab)?.label ?? "Cockpit";

  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="UX Direct home"><span className="brand-mark">ux</span><span>UX Direct</span></Link>
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

        {activeTab === "gateway" ? <ModelGatewayPanel /> : activeTab === "connections" ? (
          <div className="content">
            <div className="eyebrow"><span className="pulse" /> SYSTEM STATUS</div>
            <h1>Connections &amp;<br /><em>health checks.</em></h1>
            <p className="intro">Separate backend availability from the plugin’s recent heartbeat. Review plugin events, request failures, and the latest native API self-test.</p>
            <div className="connection-toolbar">
              <span className="last-checked">Last checked: {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "Not checked yet"}</span>
              <button className="submit-button" type="button" onClick={() => void refreshConnections()} disabled={refreshingConnections}>{refreshingConnections ? "Refreshing…" : "Refresh health data ↻"}</button>
            </div>
            <section className="smoke-test-panel" aria-labelledby="smoke-test-heading">
              <div className="smoke-test-heading">
                <div>
                  <span className="section-kicker">LOW-REQUEST VALIDATION</span>
                  <h2 id="smoke-test-heading">Health smoke tests</h2>
                  <p>Checks one saved snapshot across backend, bridge, persisted report, totals and Figma-action coverage. It does not trigger Figma mutations or send one request per check.</p>
                </div>
                <button className="secondary-button" type="button" onClick={() => void runHealthSmokeTest()} disabled={smokeBusy}>
                  {smokeBusy ? "Checking…" : "Run smoke tests ↻"}
                </button>
              </div>
              {smokeChecks && <div className="smoke-test-results" aria-live="polite">
                <div className="smoke-test-summary">
                  <strong>{smokePassed} passed</strong><span>{smokeFailed} failed</span><span>{smokeBlocked} blocked</span>
                  <time>{smokeCheckedAt ? new Date(smokeCheckedAt).toLocaleTimeString() : ""}</time>
                </div>
                {smokeChecks.map((item) => <div className="smoke-check-row" key={item.name}>
                  <span className={"smoke-check-badge smoke-" + item.status}>{item.status.toUpperCase()}</span>
                  <div><strong>{item.name}</strong><p>{item.message}</p></div>
                </div>)}
              </div>}
            </section>
            {healthError && <p className="inline-note" role="alert">Health check failed: {healthError}</p>}
            <div className="connection-grid">
              <article className="connection-card">
                <div className="connection-card-top"><span className="service-icon">API</span><span className={"status-chip " + (backendHealthy ? "status-success" : "status-error")}>{backendHealthy ? "Healthy" : "Unreachable"}</span></div>
                <h2>UX Direct backend</h2><p>Dashboard → Netlify production API</p>
                <dl><div><dt>Health endpoint</dt><dd>{backendHealthy ? "Responding" : "Not verified"}</dd></div><div><dt>Task planning</dt><dd>{health?.capabilities.taskPlanning ? "Available" : "Unknown"}</dd></div><div><dt>Last checked</dt><dd>{lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "—"}</dd></div></dl>
              </article>
                <section className="connection-card" aria-labelledby="action-catalogue-heading">
                  <div className="connection-card-top"><span className="service-icon">100+</span><span className={"status-chip " + (summarizeActionCatalogue().targetMet ? "status-success" : "status-warning")}>{summarizeActionCatalogue().targetMet ? "Catalogue target met" : "Catalogue target missing"}</span></div>
                  <h2 id="action-catalogue-heading">Figma action catalogue</h2>
                  <p>Capability inventory inspired by workflow automation tools. Catalogue entries are not counted as working actions until a native handler and functional test verify them.</p>
                  <div className="health-counts">
                    <span><strong>{summarizeActionCatalogue().total}</strong> CATALOGUED</span>
                    <span><strong>{summarizeActionCatalogue().counts.implemented}</strong> IMPLEMENTED</span>
                    <span><strong>{summarizeActionCatalogue().counts.partial}</strong> PARTIAL</span>
                    <span><strong>{summarizeActionCatalogue().counts.planned}</strong> PLANNED</span>
                  </div>
                  <p className="health-count-legend">Target: at least {summarizeActionCatalogue().target} named operations. Current inventory is {summarizeActionCatalogue().total}; this is a roadmap and readiness register, not a claim that every operation executes today.</p>
                  <details>
                    <summary>Browse catalogue ({FIGMA_ACTION_CATALOGUE.length} operations)</summary>
                    <div className="plugin-check-list">
                      {FIGMA_ACTION_CATALOGUE.map((item) => <div className="plugin-check-row" key={item.id}>
                        <span className={"plugin-check-badge " + (item.readiness === "implemented" ? "check-pass" : item.readiness === "partial" ? "check-available" : item.readiness === "unsupported" ? "check-fail" : "check-untested")}>{item.readiness.toUpperCase()}</span>
                        <div><strong>{item.description}</strong><span>{item.category} · <code>{item.id}</code></span><p>Required API: {item.requiredApi}{item.destructive ? " · Destructive operation" : ""}{item.needsHumanApproval ? " · Human approval required" : ""}</p></div>
                      </div>)}
                    </div>
                  </details>
                </section>
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
                    <span><strong>{latestPluginTest.checks.length}</strong> TOTAL</span>
                    <span><strong>{latestPluginTest.passed}</strong> PASS</span>
                    <span><strong>{latestPluginTest.failed}</strong> FAIL</span>
                    <span><strong>{latestPluginTest.available ?? 0}</strong> AVAILABLE</span>
                    <span><strong>{latestPluginTest.notTested}</strong> NOT TESTED</span>
                  </div>
                  <p className="health-count-legend">PASS = functional checks executed successfully. AVAILABLE = API presence only; the action was not invoked. TOTAL counts every report row.</p>
                  {latestPluginAudit && latestPluginAudit.failedChecks.length > 0 && <details className="failed-checks" open>
                    <summary>Failed checks ({latestPluginAudit.failedChecks.length})</summary>
                    <div className="plugin-check-list">
                      {latestPluginAudit.failedChecks.map((item, index) => <div className="plugin-check-row" key={item.category + item.name + index}>
                        <span className="plugin-check-badge check-fail">FAIL</span>
                        <div><strong>{item.name}</strong><span>{item.category} · {item.level}</span><p>{item.reason}</p></div>
                      </div>)}
                    </div>
                  </details>}
                  {latestPluginAudit && latestPluginAudit.issues.filter((issue) => !issue.startsWith(latestPluginAudit.failedChecks.length + " check(s) failed:")).length > 0 && <div className="health-report-warnings">
                    <strong>Report integrity / coverage warnings</strong>
                    {latestPluginAudit.issues.filter((issue) => !issue.startsWith(latestPluginAudit.failedChecks.length + " check(s) failed:")).map((issue) => <p key={issue}>{issue}</p>)}
                  </div>}
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
