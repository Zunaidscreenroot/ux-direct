"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { buildHealthSmokeChecks, inspectHealthReport, type SmokeCheckResult } from "@/src/quality/health-report";

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
  diagnostics?: { durationMs: number; responseStatus: string; figmaChangesMade: boolean; provider: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number };
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
 gateway:{name:string;status:string;paidModelsEnabled:boolean;pricingConfigured:boolean;gatewayFeeInr:number;accountBalanceSource?:string};
 providers:Array<{id:string;label:string;envName:string;configured:boolean;keyDetected:boolean;tier:string;secretRequired:boolean}>;
 models:GatewayModel[]; modules:GatewayModule[]; settings:GatewaySettings;
 budget:{currency:string;monthlyBudgetInr:number;spentThisMonthInr:number;remainingInr:number;percentUsed:number;inputPriceInrPerMillion:number;outputPriceInrPerMillion:number;pricingConfigured:boolean;month:string;
 records:Array<{id:string;at:string;requestId:string;provider:string;model:string;moduleId?:string;tier:string;promptTokens:number;completionTokens:number;totalTokens:number;usageReported?:boolean;estimatedCostInr:number;latencyMs:number;status:string;note?:string}>;
 retention:string;spentByModuleInr:Record<string,number>;spentByModelInr:Record<string,number>;paidCallsThisMonth:number};
 checkedAt:string;
};
type OpenRouterAccountPayload = {
 ok:boolean; checkedAt:string;
 credentials:{apiKeyConfigured:boolean;managementKeyConfigured:boolean};
 credits:null|{totalPurchasedUsd:number;totalUsedUsd:number;availableUsd:number};
 key:null|{limitUsd:number|null;limitRemainingUsd:number|null;usageUsd:number;usageDailyUsd:number;usageWeeklyUsd:number;usageMonthlyUsd:number;isFreeTier:boolean|null;isManagementKey:boolean|null;freeModelDailyRequests:null|{used:number;limit:number;remaining:number}};
 activity:null|{daysReturned:number;activeDays:number;totalUsageUsd:number;totalRequests:number;promptTokens:number;completionTokens:number;reasoningTokens:number;averageDailySpendUsd:number;daily:Array<{date:string;usageUsd:number;requests:number}>;models:Array<{model:string;provider:string|null;usageUsd:number;requests:number;promptTokens:number;completionTokens:number}>};
 errors:Record<string,string>;
};
function inr(value:number){return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:value<10?4:2}).format(value);}
function usd(value:number|null|undefined){return value===null||value===undefined?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2}).format(value);}
function modeCompatible(mode:GatewayMode,m:GatewayModel){if(mode==="free")return m.tier==="free-tier"||m.id.endsWith(":free");if(mode==="local")return m.tier==="local";if(mode==="mock")return m.tier==="mock";return m.tier!=="local"&&m.tier!=="mock"&&!m.id.endsWith(":free");}
const APPROVED_OPENROUTER_MODEL_IDS = new Set([
 "nvidia/nemotron-3.5-lightning:free",
 "nvidia/nemotron-3-ultra-550b-a55b:free",
 "openai/gpt-6-luna",
 "deepseek/deepseek-v4.1-flash",
 "deepseek/deepseek-v4-flash-0731"
]);
function selectionCompatible(mode:GatewayMode,m:GatewayModel){
 if(mode==="free"&&m.provider==="openrouter")return APPROVED_OPENROUTER_MODEL_IDS.has(m.id);
 return modeCompatible(mode,m);
}
function exampleModelCost(policy:ModelPolicy){return (100000*policy.inputPriceInrPerMillion+20000*policy.outputPriceInrPerMillion)/1_000_000;}
function ModelGatewayPanel(){
 const [data,setData]=useState<GatewayDashboardPayload|null>(null);
 const [draft,setDraft]=useState<GatewaySettings|null>(null);
 const [accountData,setAccountData]=useState<OpenRouterAccountPayload|null>(null);
 const [plannedDailySpend,setPlannedDailySpend]=useState("0.25");
 const [accountBusy,setAccountBusy]=useState(false),[accountError,setAccountError]=useState("");
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
 const loadAccount=useCallback(async()=>{
  if(!adminKey){setAccountError("Enter the gateway admin key below to read private OpenRouter account data.");return;}
  setAccountBusy(true);setAccountError("");
  try{const r=await fetch("/api/model-gateway/openrouter-account",{headers:{"x-model-gateway-admin-key":adminKey},cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error||"Could not load OpenRouter account data.");setAccountData(p as OpenRouterAccountPayload);}
  catch(e){setAccountError(e instanceof Error?e.message:"OpenRouter account data unavailable.");}
  finally{setAccountBusy(false);}
 },[adminKey]);
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
 const fx=settings?.usdToInrRate??97;
 const keyReady=(data?.providers??[]).filter(p=>p.keyDetected).length;
 const availableUsd=accountData?.credits?.availableUsd;
 const plannedDailyUsd=Math.max(0,Number(plannedDailySpend)||0);
 const plannedRunwayDays=availableUsd===undefined?null:plannedDailyUsd>0?Math.max(0,availableUsd)/plannedDailyUsd:null;
 const observedRunwayDays=availableUsd===undefined?null:(accountData?.activity?.averageDailySpendUsd??0)>0?Math.max(0,availableUsd)/(accountData?.activity?.averageDailySpendUsd??1):null;
 function policyFor(m:GatewayModel):ModelPolicy{return settings?.models[m.selectionKey]??{monthlyBudgetInr:500,maxRequestCostInr:50,inputPriceInrPerMillion:(m.usdInputPerMillion??0)*fx,outputPriceInrPerMillion:(m.usdOutputPerMillion??0)*fx};}
 function recommendation(module:GatewayModule,mode:GatewayMode){const choices=models.filter(m=>modeCompatible(mode,m)&&(mode!=="paid"||(policyFor(m).inputPriceInrPerMillion>0&&policyFor(m).outputPriceInrPerMillion>0)));const fit=(m:GatewayModel)=>m.tasks.some(t=>module.tasks.some(w=>t.toLowerCase().includes(w.toLowerCase())||w.toLowerCase().includes(t.toLowerCase())))?1:0;choices.sort((a,b)=>fit(b)-fit(a)||Number(b.configured)-Number(a.configured)||(mode==="paid"?exampleModelCost(policyFor(a))-exampleModelCost(policyFor(b)):0)||a.label.localeCompare(b.label));return choices[0]??null;}
 const modeOptions=(mode:GatewayMode)=>models.filter(m=>selectionCompatible(mode,m)).sort((a,b)=>Number(b.configured)-Number(a.configured)||a.label.localeCompare(b.label));
 function applySuggestion(module:GatewayModule,mode:GatewayMode){const m=recommendation(module,mode);if(!m)return;updateModule(module.id,{mode,selectedModelKey:m.selectionKey});setMessage("Selected "+m.label+" for "+module.label+". Save to apply.");}
  return <div className="content gateway-content accountant-content">
  <div className="eyebrow"><span className="pulse"/> MODEL OPERATIONS · OPENROUTER</div>
  <div className="gateway-title-row"><div><h1>Model gateway.<br/><em>Spend from available credits.</em></h1><p className="intro">UX Direct tries the two approved free Nemotron models first, then routes to one approved paid model when needed. OpenRouter is the provider gateway; its account balance and key limits determine available paid usage. UX Direct shows usage and estimates without imposing monthly spending caps.</p></div>
   <div className="gateway-header-actions"><button className="secondary-button" type="button" onClick={()=>void smoke()} disabled={smokeBusy}>{smokeBusy?"Testing…":"Run free smoke test ↗"}</button><button className="submit-button" type="button" onClick={()=>void load()} disabled={busy}>{busy?"Refreshing…":"Refresh ↻"}</button></div></div>
  {loadError&&<p className="inline-note" role="alert">{loadError}</p>}{smokeMessage&&<p className="gateway-smoke-message" role="status">{smokeMessage}</p>}
  <div className="gateway-mode-banner"><span className="gateway-status-dot gateway-dot-live"/><div><strong>OpenRouter provider gateway · free-first with one paid fallback</strong><p>Try Nemotron 3.5 Lightning and Nemotron 3 Ultra first. If neither returns a usable response, route once to GPT-6 Luna for general UX, DeepSeek V4.1 Flash for strategy/critique, or DeepSeek V4 Flash for coding and implementation. OpenRouter enforces account credits, key limits and provider rate limits; UX Direct retains model allowlists, request rate limits and usage telemetry.</p></div><span className="gateway-fee">₹0 gateway fee</span></div>
  <section className="gateway-panel openrouter-account-panel">
  <div className="gateway-panel-heading"><div><span className="section-kicker">LIVE OPENROUTER ACCOUNT</span><h2>Credits, usage & runway</h2><p>Provider-reported USD balance and account activity. This data is fetched from OpenRouter; it does not trigger model inference.</p></div><button className="secondary-button" type="button" onClick={()=>void loadAccount()} disabled={accountBusy||!adminKey}>{accountBusy?"Refreshing…":"Refresh account ↻"}</button></div>
  <label className="gateway-control-field gateway-account-admin"><span>Gateway admin key · required for private account data</span><input type="password" autoComplete="off" value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="Enter MODEL_GATEWAY_ADMIN_KEY" aria-label="Gateway admin key for private OpenRouter account data"/><small>Kept in memory only; never saved in browser storage or sent to OpenRouter.</small></label>
  {accountError&&<p className="inline-note" role="alert">{accountError}</p>}
  {accountData?.errors?.credits&&<p className="inline-note" role="status">{accountData.errors.credits}</p>}
  {accountData?.errors?.activity&&<p className="inline-note" role="status">{accountData.errors.activity}</p>}
  {accountData?.errors?.key&&<p className="inline-note" role="status">{accountData.errors.key}</p>}
  <div className="accountant-summary-grid">
   <article className="gateway-stat-card"><span>AVAILABLE ACCOUNT CREDITS</span><strong>{usd(accountData?.credits?.availableUsd)}</strong><small>{accountData?.credits?("Purchased "+usd(accountData.credits.totalPurchasedUsd)+" · lifetime usage "+usd(accountData.credits.totalUsedUsd)):"Needs OPENROUTER_MANAGEMENT_KEY"}</small></article>
   <article className="gateway-stat-card"><span>USAGE · LAST 30 DAYS</span><strong>{usd(accountData?.activity?.totalUsageUsd)}</strong><small>{(accountData?.activity?.totalRequests??0).toLocaleString("en-US")} requests · {(accountData?.activity?.daysReturned??0)} UTC dates reported</small></article>
   <article className="gateway-stat-card"><span>AVERAGE DAILY SPEND</span><strong>{usd(accountData?.activity?.averageDailySpendUsd)}</strong><small>Last 30 completed UTC days · includes zero-spend days</small></article>
   <article className="gateway-stat-card"><span>API KEY · THIS MONTH</span><strong>{usd(accountData?.key?.usageMonthlyUsd)}</strong><small>{accountData?.key?.limitRemainingUsd===null?"No separate per-key cap reported":accountData?.key?.limitRemainingUsd!==undefined?"Key limit remaining "+usd(accountData.key.limitRemainingUsd):"Key info unavailable"} · daily {usd(accountData?.key?.usageDailyUsd)}</small></article>
  </div>
  <div className="gateway-account-planner">
   <div><span className="section-kicker">CREDIT RUNWAY PLANNER</span><h3>Plan your daily spend</h3><p>Change the target below to estimate how many days the current provider balance could last. These are projections, not spending locks.</p></div>
   <label className="gateway-control-field"><span>Planned spend per day (USD)</span><input type="number" min="0" step="0.05" value={plannedDailySpend} onChange={e=>setPlannedDailySpend(e.target.value)} /></label>
   <article className="gateway-stat-card"><span>ESTIMATED RUNWAY AT PLAN</span><strong>{plannedRunwayDays===null?"—":plannedRunwayDays.toFixed(1)+" days"}</strong><small>{usd(plannedDailyUsd*30)} projected for 30 days</small></article>
   <article className="gateway-stat-card"><span>RUNWAY AT RECENT PACE</span><strong>{observedRunwayDays===null?"—":observedRunwayDays.toFixed(1)+" days"}</strong><small>{usd(accountData?.activity?.averageDailySpendUsd)} average per day from activity</small></article>
  </div>
  <div className="gateway-section-heading"><div><span className="section-kicker">RECENT SPEND BREAKDOWN</span><h3>Daily activity · last 30 completed UTC days</h3><p>OpenRouter activity is grouped by date and model. Model names below come from provider reports, not local estimates.</p></div></div>
  {!accountData?.activity?<div className="gateway-empty-state"><strong>Activity not available yet</strong><p>Add OPENROUTER_MANAGEMENT_KEY to the server environment for credits and 30-day analytics. OPENROUTER_API_KEY alone can report key-level usage.</p></div>:<>
   <div className="token-ledger-table-wrap"><table className="gateway-table token-table"><thead><tr><th>UTC DATE</th><th>REQUESTS</th><th>REPORTED USAGE</th></tr></thead><tbody>{accountData.activity.daily.slice(0,10).map(day=><tr key={day.date}><td><strong>{day.date}</strong></td><td>{day.requests.toLocaleString("en-US")}</td><td>{usd(day.usageUsd)}</td></tr>)}</tbody></table></div>
   <div className="token-ledger-table-wrap"><table className="gateway-table token-table"><thead><tr><th>MODEL</th><th>PROVIDER</th><th>REQUESTS</th><th>INPUT TOKENS</th><th>OUTPUT TOKENS</th><th>USAGE</th></tr></thead><tbody>{accountData.activity.models.slice(0,8).map(model=><tr key={model.model+"-"+model.provider}><td><strong>{model.model}</strong></td><td>{model.provider??"—"}</td><td>{model.requests.toLocaleString("en-US")}</td><td>{model.promptTokens.toLocaleString("en-US")}</td><td>{model.completionTokens.toLocaleString("en-US")}</td><td>{usd(model.usageUsd)}</td></tr>)}</tbody></table></div>
  </>}
  <p className="gateway-footnote">Key-level totals can differ from account-level analytics when multiple keys are in use or when Bring Your Own Key (BYOK) applies. OpenRouter account-credit data may be cached by the provider. Last checked: {accountData?.checkedAt?new Date(accountData.checkedAt).toLocaleString():"not checked"}.</p>
 </section>
 <div className="gateway-section-heading"><div><span className="section-kicker">01 · MODULE CONTROL</span><h2>One model policy per agent</h2><p>Switch modules on/off and choose an exact model. Actual paid usage is billed to OpenRouter; these switches control feature availability, not spend caps.</p></div><span className="count">{modules.filter(m=>settings?.modules[m.id]?.enabled).length} / {modules.length} ON</span></div>
  <div className="gateway-module-grid">{modules.map(module=>{const p=settings?.modules[module.id];if(!p)return null;const chosen=models.find(m=>m.selectionKey===p.selectedModelKey);const rec=recommendation(module,p.mode==="mock"?"mock":"free");const used=data?.budget.spentByModuleInr?.[module.id]??0;return <article className={"gateway-module-card "+(!p.enabled?"module-disabled":"")} key={module.id}>
   <div className="gateway-module-head"><div><span className="section-kicker">{module.id.toUpperCase()}</span><h3>{module.label}</h3></div><label className="gateway-switch"><input type="checkbox" checked={p.enabled} onChange={e=>updateModule(module.id,{enabled:e.target.checked})}/><span>{p.enabled?"ON":"OFF"}</span></label></div>
   <p className="gateway-module-description">{module.description}</p>
   <div className="gateway-module-usage"><span>Estimated spend this month</span><strong>{inr(used)}</strong></div>
   <label className="gateway-control-field"><span>Mode</span><select value={p.mode==="mock"?"mock":"free"} onChange={e=>{const mode=e.target.value as GatewayMode;const keep=p.selectedModelKey==="auto"||models.some(m=>m.selectionKey===p.selectedModelKey&&selectionCompatible(mode,m));updateModule(module.id,{mode,...(!keep?{selectedModelKey:"auto"}:{})});}}><option value="free">Free-first · automatic paid fallback</option><option value="mock">Mock only · no AI</option></select></label>
   <label className="gateway-control-field"><span>Exact model <i>{p.selectedModelKey==="auto"?"Auto within mode":"Strict allowlist"}</i></span><select disabled={!p.enabled} value={p.selectedModelKey} onChange={e=>updateModule(module.id,{selectedModelKey:e.target.value})}><option value="auto">Auto recommendation · selected mode only</option>{modeOptions(p.mode).map(m=><option key={m.selectionKey} value={m.selectionKey}>{m.label}{m.configured?" · connected":" · not connected"}</option>)}</select></label>
   {chosen&&<p className="gateway-selected-note"><span className={"status-dot-inline "+(chosen.configured?"green":"amber")}/>{chosen.configured?"Configured":"Not connected; request will be blocked"} · {chosen.notes}</p>}
   <div className="gateway-recommendation"><div><strong>Current-mode suggestion</strong><p>{rec?rec.label+" — task fit and connection status guide this choice." : "No catalog option for this mode yet."}</p></div>{rec&&<button className="text-button" type="button" onClick={()=>applySuggestion(module,p.mode)}>Use suggestion ↗</button>}</div>
   <div className="gateway-recommendation paid-recommendation"><div><strong>Paid fallback · automatic expertise match</strong><p>General UX and writing → GPT-6 Luna · strategy and critique → DeepSeek V4.1 Flash · coding and implementation → DeepSeek V4 Flash. The chosen paid model is attempted only after both approved free models fail.</p></div></div>
  </article>;})}</div>
  <div className="gateway-section-heading"><div><span className="section-kicker">02 · MODEL PRICING</span><h2>Estimate token costs</h2><p>Rates are INR per 1 million tokens. Example assumes 100k input + 20k output tokens. Rates are for planning and usage estimates only; OpenRouter enforces provider-side credit limits.</p></div><span className="count">{models.length} MODEL OPTIONS</span></div>
  <section className="gateway-panel model-accountant-panel"><div className="model-catalog-toolbar"><label className="gateway-control-field"><span>Filter models</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All</option><option value="connected">Connected only</option><option value="free">Free-tier candidates</option><option value="paid">Billable models</option><option value="local">Local models</option></select></label><span className="gateway-footnote">Published rates are editable suggestions, not a live quote.</span></div>
   <div className="model-accountant-table-wrap"><table className="gateway-table model-pricing-table"><thead><tr><th>MODEL / TASKS</th><th>TIER / STATUS</th><th>INPUT ₹ / 1M</th><th>OUTPUT ₹ / 1M</th><th>EXAMPLE COST</th><th>PRICE SOURCE</th></tr></thead><tbody>
    {models.filter(m=>filter==="all"||(filter==="connected"&&m.configured)||(filter==="free"&&(m.tier==="free-tier"||m.id.endsWith(":free")))||(filter==="paid"&&modeCompatible("paid",m))||(filter==="local"&&m.tier==="local")).map(m=>{const p=policyFor(m);return <tr key={m.selectionKey}><td><strong>{m.label}</strong><small>{m.tasks.join(" · ")}</small><small>{m.notes}</small></td><td><span className={"gateway-tier tier-"+m.tier}>{m.tier}</span><small>{m.configured?"Configured":"Not connected"}</small></td>
     <td><input className="model-price-input" aria-label={m.label+" input price"} type="number" min="0" step=".01" value={p.inputPriceInrPerMillion} onChange={e=>updateModel(m.selectionKey,{inputPriceInrPerMillion:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><input className="model-price-input" aria-label={m.label+" output price"} type="number" min="0" step=".01" value={p.outputPriceInrPerMillion} onChange={e=>updateModel(m.selectionKey,{outputPriceInrPerMillion:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><strong>{inr(exampleModelCost(p))}</strong>{m.usdInputPerMillion!==undefined&&<small>${m.usdInputPerMillion.toFixed(3)} / ${(m.usdOutputPerMillion??0).toFixed(3)} USD per 1M</small>}</td>
     <td>{m.pricingSource?<><a href={m.pricingSource} target="_blank" rel="noreferrer">Official pricing ↗</a><small>Checked {m.pricingReviewedAt??"date unavailable"}</small><button className="text-button apply-price" type="button" onClick={()=>updateModel(m.selectionKey,{inputPriceInrPerMillion:Number(((m.usdInputPerMillion??0)*fx).toFixed(4)),outputPriceInrPerMillion:Number(((m.usdOutputPerMillion??0)*fx).toFixed(4))})}>Apply USD→INR suggestion</button></>:<small>Enter published provider prices before paid mode.</small>}</td>
    </tr>;})}
   </tbody></table></div>
   <p className="gateway-footnote">Free model variants can still be rate-limited by OpenRouter. Paid requests use account credits and any configured per-key limit. Local estimates exclude taxes, caching and search/tool charges unless included in reported provider usage.</p>
  </section>
  <div className="gateway-section-heading"><div><span className="section-kicker">03 · PROVIDER REGISTRY</span><h2>API key placeholders</h2></div><span className="count">{keyReady} KEYS DETECTED</span></div>
  <div className="gateway-provider-grid">{(data?.providers??[]).map(p=><article className="gateway-provider-card" key={p.id}><div className="gateway-provider-top"><span className="gateway-provider-mark">{p.label.split(" ").map(w=>w[0]).join("").slice(0,2)}</span><span className={"status-chip "+(p.configured?"status-success":"status-neutral")}>{p.configured?"Configured · unverified":p.keyDetected?"Key detected · setup incomplete":p.tier==="local"?"Endpoint not configured":"Key not added"}</span></div><h3>{p.label}</h3><p>{p.tier==="paid"?"Paid provider · opt-in required":p.tier==="local"?"Local inference · no API token charge":"Free-tier candidate · verify account and quotas"}</p><label className="gateway-key-label" htmlFor={"key-slot-"+p.id}>{p.envName}</label><div className="gateway-key-placeholder"><input id={"key-slot-"+p.id} type="password" placeholder={p.secretRequired?"API key placeholder · final step":"Local endpoint placeholder"} disabled readOnly aria-label={p.envName+" placeholder; edit disabled"}/><span>{p.keyDetected?"KEY DETECTED":p.configured?"CONNECTED":"PLACEHOLDER"}</span></div><small className="gateway-provider-note">No keys are collected or stored in the dashboard. Add credentials later through server-side environment variables.</small></article>)}</div>
  <div className="gateway-section-heading"><div><span className="section-kicker">04 · TOKEN LEDGER</span><h2>Every request attributed to a purpose</h2><p>Usage, model, latency, status and estimated cost; prompt/response content is never shown.</p></div><span className="count">{Math.min(records.length,200)} / 200 RECORDS</span></div>
  <section className="gateway-panel token-ledger-panel"><div className="token-ledger-intro"><div><strong>Request-by-request accounting</strong><p>Current month only; cost is estimated from configured rates.</p></div><span className="ledger-retention">{data?.budget.retention==="netlify-blobs"?"Persistent · scoped ledger":"Runtime fallback"}</span></div>
   {records.length===0?<div className="gateway-empty-state"><div className="gateway-empty-icon">◷</div><strong>No model calls recorded this month</strong><p>Mock smoke test verifies wiring at ₹0 but isn&apos;t AI inference.</p></div>:<div className="token-ledger-table-wrap"><table className="gateway-table token-table"><thead><tr><th>TIME / REQUEST</th><th>MODULE</th><th>MODEL</th><th>INPUT</th><th>OUTPUT</th><th>TOTAL</th><th>EST. COST</th><th>LATENCY</th></tr></thead><tbody>{records.map(r=><tr key={r.id}><td><strong>{new Date(r.at).toLocaleString()}</strong><small>#{r.requestId.slice(0,8)} · {r.status}</small></td><td>{modules.find(m=>m.id===r.moduleId)?.label??r.moduleId??"Unattributed"}</td><td><strong>{r.model}</strong><small>{r.provider} · {r.tier}</small></td><td>{r.usageReported===false?"—":r.promptTokens.toLocaleString("en-IN")}</td><td>{r.usageReported===false?"—":r.completionTokens.toLocaleString("en-IN")}</td><td>{r.usageReported===false?"Unavailable":r.totalTokens.toLocaleString("en-IN")}</td><td>{inr(r.estimatedCostInr)}</td><td>{r.latencyMs.toLocaleString("en-IN")} ms</td></tr>)}</tbody></table></div>}
  </section>
  <div className="gateway-savebar"><div><strong>{dirty.current?"Unsaved configuration":message||"Settings saved"}</strong><p>Applies to this Netlify environment/branch only. Provider API keys stay server-side. Saving requires the server-side MODEL_GATEWAY_ADMIN_KEY.</p></div><p className="gateway-savebar-note">The gateway admin key is entered in the OpenRouter account panel above and is used for private account reads and settings saves. Provider API keys stay server-side.</p><button className="submit-button" type="button" onClick={()=>void save()} disabled={!draft||saving||!dirty.current}>{saving?"Saving…":"Save gateway settings ↗"}</button></div>
  {message&&<p className="gateway-smoke-message" role="status">{message}</p>}
  <p className="gateway-footer-note">Dashboard refresh is one read-only GET per minute; the OpenRouter account snapshot refreshes on demand and does not call model inference or Figma.</p>
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
            <p className="intro">Give UX Direct a real product problem. It creates a reviewable plan using the configured OpenRouter model gateway when available, with deterministic mock mode only when no provider key is configured. Planning does not modify your Figma file.</p>
            <form className="task-composer" onSubmit={submitTask}>
              <label htmlFor="task">What should we work on?</label>
              <textarea id="task" value={task} onChange={(event) => { setTask(event.target.value); setSubmitted(false); setPlanResult(null); setError(""); }} placeholder="e.g. Analyse the existing DMI screens and plan the VKYC entry journey. Preserve product patterns and cover failure states." rows={4} maxLength={8000} required />
              <div className="composer-footer"><label className="select-label" htmlFor="project">Project context</label><select id="project" value={activeProject} onChange={(event) => { setActiveProject(event.target.value); setPlanResult(null); }}><option>General UX</option><option>Express Computers</option><option>DMI Finance</option></select><button className="submit-button" type="submit" disabled={loading}>{loading ? "Generating…" : "Generate plan"} <span aria-hidden="true">↗</span></button></div>
              {error && <p className="inline-note" role="alert">{error}</p>}
              {submitted && planResult && <p className="inline-note" role="status">Plan created in {planResult.mode === "gateway" ? "OpenRouter gateway" : "mock"} mode. Model: {planResult.diagnostics?.model ?? "not reported"}. Estimated API cost: {inr(planResult.cost?.amount ?? 0)}. Request ID: {planResult.requestId ?? "not returned"}. No Figma file was modified.</p>}
            </form>
            {planResult && <section className="plan-results" aria-labelledby="plan-heading"><div className="section-heading"><div><span className="section-kicker">TASK PLAN · {planResult.mode === "gateway" ? "OPENROUTER" : "MOCK"}</span><h2 id="plan-heading">Work breakdown</h2></div><span className="count">{inr(planResult.cost?.amount ?? 0)} EST. COST</span></div><p className="plan-summary">{planResult.plan.summary}</p><ol className="plan-steps">{planResult.plan.steps.map((step, index) => <li key={step.id}><span className="step-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{step.label}</strong><span>{step.capabilityId}</span></div><span className="step-state">Planned</span></li>)}</ol><div className="plan-columns"><div><h3>Quality gates</h3><ul>{planResult.plan.qualityChecks.map((check) => <li key={check}>{check}</li>)}</ul></div><div><h3>Assumptions to validate</h3><ul>{planResult.plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div></div><p className="review-note">Human review required · This plan does not edit Figma. Use the UX Direct Figma cockpit for selected-frame analysis and confirmed design operations.</p></section>}
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
