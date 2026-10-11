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
type ModulePolicy = { enabled:boolean; mode:GatewayMode; selectedModelKey:string; monthlyBudgetInr:number; maxRequestCostInr:number; allowFallback:boolean; plannedCallsPerDay:number; plannedInputTokens:number; plannedOutputTokens:number };
type ModelPolicy = { monthlyBudgetInr:number; maxRequestCostInr:number; inputPriceInrPerMillion:number; outputPriceInrPerMillion:number };
type GatewaySettings = { version:1; globalMonthlyBudgetInr:number; usdToInrRate:number; paidRoutingEnabled:boolean; modules:Record<string,ModulePolicy>; models:Record<string,ModelPolicy>; updatedAt?:string };
type GatewayModule = { id:string; label:string; description:string; alias:string; tasks:string[]; suggestedBudgetShare:number };
type GatewayModel = {
 id:string; provider:string; label:string; tier:string; tasks:string[]; configured:boolean; notes:string; selectionKey:string;
 usdInputPerMillion?:number; usdOutputPerMillion?:number; pricingSource?:string; pricingReviewedAt?:string;
 contextLength?:number; inputModalities?:string[]; outputModalities?:string[]; supportedParameters?:string[]; availability?:string;
};
type GatewayRecommendations = {
 modelUsed:string|null; source:"free-ai-planner"|"deterministic-fallback"; generatedAt:string; note:string;
 recommendations:Record<string,{free:string[];paid:string[];freeReason?:string;paidReason?:string}>;
};
type ModelCheckResult = {
 status:string; message?:string; error?:string; response?:string; latencyMs?:number; estimatedCostInr?:number;
 checkedAt?:string; inputUsdPerMillion?:number; outputUsdPerMillion?:number; contextLength?:number;
 inputModalities?:string[]; tokenUsage?:{promptTokens:number;completionTokens:number;totalTokens:number;reported:boolean};
};
type GatewayDashboardPayload = {
 gateway:{name:string;status:string;paidModelsEnabled:boolean;monthlyBudgetInr:number;pricingConfigured:boolean;gatewayFeeInr:number};
 providers:Array<{id:string;label:string;envName:string;configured:boolean;keyDetected:boolean;tier:string;secretRequired:boolean}>;
 models:GatewayModel[]; modules:GatewayModule[]; settings:GatewaySettings;
 openRouterCatalog:{status:string;modelCount:number;checkedAt:string|null;error?:string};
 openRouterUsage?:{available:boolean;checkedAt:string;usageUsd?:number;usageDailyUsd?:number;usageWeeklyUsd?:number;usageMonthlyUsd?:number;limitUsd?:number|null;remainingUsd?:number|null;limitReset?:string|null;freeTier?:boolean;managementAnalyticsAvailable:boolean;activity30Days?:{requests:number;promptTokens:number;completionTokens:number;usageUsd:number};error?:string}|null;
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
 const [plannerBusy,setPlannerBusy]=useState(false),[checkingModel,setCheckingModel]=useState("");
 const [smokeMessage,setSmokeMessage]=useState(""),[message,setMessage]=useState(""),[loadError,setLoadError]=useState(""),[plannerMessage,setPlannerMessage]=useState("");
 const [adminKey,setAdminKey]=useState(""),[accessKey,setAccessKey]=useState("");
 const plannerAutoStarted=useRef(false);
 const [filter,setFilter]=useState("all"),[catalogQuery,setCatalogQuery]=useState(""),[catalogLimit,setCatalogLimit]=useState(40);
 const [plannerData,setPlannerData]=useState<GatewayRecommendations|null>(null);
 const [modelChecks,setModelChecks]=useState<Record<string,ModelCheckResult>>({});
 const dirty=useRef(false);
 const load=useCallback(async()=>{
  setBusy(true);
  try{
   const r=await fetch("/api/model-gateway/dashboard",{cache:"no-store"});
   const p=await r.json();
   if(!r.ok)throw new Error(p.error||"Could not load gateway dashboard.");
   setData(p as GatewayDashboardPayload);
   if(!dirty.current)setDraft((p as GatewayDashboardPayload).settings);
   setLoadError("");
  }catch(e){setLoadError(e instanceof Error?e.message:"Gateway dashboard unavailable.");}
  finally{setBusy(false);}
 },[]);
 useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),60000);return()=>window.clearInterval(timer);},[load]);
 function mutate(fn:(s:GatewaySettings)=>GatewaySettings){dirty.current=true;setMessage("Unsaved changes");setDraft(s=>s?fn(s):s);}
 function updateModule(id:string,patch:Partial<ModulePolicy>){mutate(s=>({...s,modules:{...s.modules,[id]:{...s.modules[id],...patch}}}));}
 function updateModel(key:string,patch:Partial<ModelPolicy>){mutate(s=>({...s,models:{...s.models,[key]:{...s.models[key],...patch}}}));}
 async function save(){
  if(!draft||saving)return;
  setSaving(true);setMessage("");
  try{
   const r=await fetch("/api/model-gateway/settings",{method:"PUT",headers:{"Content-Type":"application/json","x-model-gateway-admin-key":adminKey},cache:"no-store",body:JSON.stringify(draft)});
   const p=await r.json();
   if(!r.ok)throw new Error(p.error||"Could not save settings.");
   dirty.current=false;setDraft(p.settings);setMessage("Saved · current preview/environment only");await load();
  }catch(e){setMessage(e instanceof Error?e.message:"Save failed.");}
  finally{setSaving(false);}
 }
 async function smoke(){
  if(smokeBusy)return;
  setSmokeBusy(true);setSmokeMessage("");
  try{
   const r=await fetch("/api/model-gateway/smoke",{method:"POST",cache:"no-store"});
   const p=await r.json();
   if(!r.ok||!p.ok)throw new Error(p.error||"Smoke test failed.");
   setSmokeMessage("Passed · 0 tokens · ₹0 · no provider call · request "+String(p.requestId).slice(0,8));await load();
  }catch(e){setSmokeMessage(e instanceof Error?e.message:"Smoke test failed.");}
  finally{setSmokeBusy(false);}
 }
 const runPlanner=useCallback(async(force=false)=>{
  setPlannerBusy(true);setPlannerMessage("");
  try{
   const r=await fetch("/api/model-gateway/recommendations"+(force?"?refresh=true":""),{cache:"no-store"});
   const p=await r.json();
   if(!r.ok)throw new Error(p.error||"Could not get AI model recommendations.");
   setPlannerData(p as GatewayRecommendations);
   setPlannerMessage((p.source==="free-ai-planner"?"Free AI planner: ":"Metadata fallback: ")+(p.modelUsed||"deterministic ranking")+" · "+new Date(p.generatedAt).toLocaleTimeString());
  }catch(e){setPlannerMessage(e instanceof Error?e.message:"Model planner unavailable.");}
  finally{setPlannerBusy(false);}
 },[]);
 const models=data?.models??[], openRouterModels=models.filter(m=>m.provider==="openrouter"), modules=data?.modules??[], settings=draft, records=data?.budget.records??[];
 const spent=data?.budget.spentThisMonthInr??0, globalCap=settings?.globalMonthlyBudgetInr??3000, remaining=Math.max(0,globalCap-spent), fx=settings?.usdToInrRate??97;
 const keyReady=(data?.providers??[]).filter(p=>p.keyDetected).length;
 function policyFor(m:GatewayModel):ModelPolicy{return settings?.models[m.selectionKey]??{monthlyBudgetInr:500,maxRequestCostInr:50,inputPriceInrPerMillion:(m.usdInputPerMillion??0)*fx,outputPriceInrPerMillion:(m.usdOutputPerMillion??0)*fx};}
 function modeCompatible(mode:"free"|"paid",m:GatewayModel){if(m.provider!=="openrouter")return false;if(mode==="free")return m.tier==="free-tier"&&m.id.endsWith(":free");return m.tier==="paid"&&(m.usdInputPerMillion??0)>0&&(m.usdOutputPerMillion??0)>0;}
 function exampleModelCost(policy:ModelPolicy){return (100000*policy.inputPriceInrPerMillion+20000*policy.outputPriceInrPerMillion)/1_000_000;}
 function modelOptions(module:GatewayModule,mode:"free"|"paid"){
  const ids=plannerData?.recommendations?.[module.id]?.[mode]??[];
  const fromPlanner=ids.map(id=>openRouterModels.find(m=>m.id===id)).filter((m):m is GatewayModel=>Boolean(m&&modeCompatible(mode,m)));
  if(fromPlanner.length)return fromPlanner;
  const fit=(m:GatewayModel)=>m.tasks.some(t=>module.tasks.some(w=>t.toLowerCase().includes(w.toLowerCase())||w.toLowerCase().includes(t.toLowerCase())))?1:0;
  return openRouterModels.filter(m=>modeCompatible(mode,m)).sort((a,b)=>fit(b)-fit(a)||(mode==="paid"?exampleModelCost(policyFor(a))-exampleModelCost(policyFor(b)):0)||a.label.localeCompare(b.label)).slice(0,8);
 }
 function currentModel(module:GatewayModule,p:ModulePolicy){
  const mode=p.mode==="paid"?"paid":"free";
  const picked=openRouterModels.find(m=>m.selectionKey===p.selectedModelKey&&modeCompatible(mode,m));
  return picked??modelOptions(module,mode)[0]??null;
 }
 function dailyCost(module:GatewayModule,p:ModulePolicy|undefined){
  if(!p||!p.enabled||p.mode!=="paid")return 0;
  const m=currentModel(module,p);
  if(!m)return 0;
  const policy=policyFor(m);
  return p.plannedCallsPerDay*(p.plannedInputTokens*policy.inputPriceInrPerMillion+p.plannedOutputTokens*policy.outputPriceInrPerMillion)/1_000_000;
 }
 const projectedDaily=modules.reduce((sum,module)=>sum+dailyCost(module,settings?.modules[module.id]),0);
 const plannedCalls=modules.reduce((sum,module)=>sum+(settings?.modules[module.id]?.enabled?settings.modules[module.id].plannedCallsPerDay:0),0);
 async function checkModel(module:GatewayModule,model:GatewayModel,mode:"free"|"paid"){
  if(!accessKey.trim()){setPlannerMessage("Enter MODEL_GATEWAY_ACCESS_KEY before testing models.");return;}
  if(mode==="paid"&&typeof window!=="undefined"&&!window.confirm("This is a real OpenRouter inference request. It can incur a small charge. Continue with an 8-token test?"))return;
  setCheckingModel(model.selectionKey);setPlannerMessage("");
  try{
   const r=await fetch("/api/model-gateway/check",{method:"POST",headers:{"Content-Type":"application/json","x-model-gateway-key":accessKey.trim()},cache:"no-store",body:JSON.stringify({modelId:model.id,moduleId:module.id,mode,confirmPaid:mode==="paid"})});
   const p=await r.json() as ModelCheckResult;
   setModelChecks(current=>({...current,[model.selectionKey]:p}));
   setPlannerMessage((p.status==="available"?"Available · ":"Check: ")+(p.message||p.error||p.status)+(typeof p.latencyMs==="number"?" · "+p.latencyMs+" ms":"")+(typeof p.estimatedCostInr==="number"?" · "+inr(p.estimatedCostInr):""));
   if(p.status==="available")await load();
  }catch(e){
   const failed:ModelCheckResult={status:"unavailable",error:e instanceof Error?e.message:"Model check failed."};
   setModelChecks(current=>({...current,[model.selectionKey]:failed}));setPlannerMessage(failed.error||"Model check failed.");
  }finally{setCheckingModel("");}
 }
 const catalogRows=openRouterModels.filter(m=>
  (filter==="all"||(filter==="connected"&&m.configured)||(filter==="free"&&m.tier==="free-tier")||(filter==="paid"&&m.tier==="paid"))&&
  (!catalogQuery.trim()||(m.id+" "+m.label+" "+m.tasks.join(" ")).toLowerCase().includes(catalogQuery.trim().toLowerCase()))
 );
 const usage=data?.openRouterUsage;
 useEffect(()=>{
  if(openRouterModels.length>0&&!plannerAutoStarted.current){
   plannerAutoStarted.current=true;
   void runPlanner(false);
  }
 },[openRouterModels.length,runPlanner]);
 return <div className="content gateway-content accountant-content">
  <div className="eyebrow"><span className="pulse"/> MODEL OPERATIONS · OPENROUTER MANAGER</div>
  <div className="gateway-title-row"><div><h1>Model gateway.<br/><em>Your capability manager.</em></h1><p className="intro">One OpenRouter catalog, capability-aware free/paid suggestions, live model tests and a consolidated daily cost plan for Express Computers Batch 3 and DMI Finance.</p></div>
   <div className="gateway-header-actions"><button className="secondary-button" type="button" onClick={()=>void smoke()} disabled={smokeBusy}>{smokeBusy?"Testing…":"Run zero-cost smoke test ↗"}</button><button className="submit-button" type="button" onClick={()=>void load()} disabled={busy}>{busy?"Refreshing…":"Refresh catalog ↻"}</button></div></div>
  {loadError&&<p className="inline-note" role="alert">{loadError}</p>}
  {smokeMessage&&<p className="gateway-smoke-message" role="status">{smokeMessage}</p>}
  <div className="gateway-mode-banner"><span className={"gateway-status-dot "+(data?.openRouterCatalog.status==="live"?"gateway-dot-live":"gateway-dot-idle")}/><div><strong>{data?.openRouterCatalog.status==="live"?"Live OpenRouter catalog loaded":"OpenRouter catalog needs attention"}</strong><p>{data?.openRouterCatalog.status==="live"?((data?.openRouterCatalog.modelCount??0).toLocaleString("en-IN")+" models · prices refreshed "+(data?.openRouterCatalog.checkedAt?new Date(data.openRouterCatalog.checkedAt).toLocaleTimeString():"recently")):(data?.openRouterCatalog.error||"Add OPENROUTER_API_KEY in the server environment and refresh.")} Catalog status means listed, not guaranteed inference availability.</p></div><span className="gateway-fee">OpenRouter only</span></div>

  <section className="gateway-panel gateway-planner-panel">
   <div className="gateway-panel-heading"><div><span className="section-kicker">FREE BACKEND MODEL PLANNER</span><h2>Ask the gateway to recommend per capability</h2><p className="gateway-panel-subtitle">The planner uses one live, zero-price OpenRouter model and chooses only IDs from the catalog. Its results are cached for 10 minutes; if it is unavailable, metadata ranking keeps the controls usable.</p></div><span className="gateway-tier">FREE PLANNER</span></div>
   <div className="gateway-planner-controls"><label className="gateway-control-field"><span>Gateway access key · model tests</span><input type="password" autoComplete="off" value={accessKey} onChange={e=>setAccessKey(e.target.value)} placeholder="Enter MODEL_GATEWAY_ACCESS_KEY" aria-label="Gateway API access key"/><small>Planner suggestions run automatically with a free model. This key is needed only for on-demand inference tests; it stays in memory only.</small></label><button className="submit-button" type="button" onClick={()=>void runPlanner(false)} disabled={plannerBusy||!openRouterModels.length}>{plannerBusy?"Analyzing catalog…":"Recommend models ↗"}</button><button className="secondary-button" type="button" onClick={()=>void runPlanner(true)} disabled={plannerBusy||!openRouterModels.length}>Re-run planner</button></div>
   {plannerMessage&&<p className="gateway-smoke-message" role="status">{plannerMessage}</p>}
   {plannerData&&<p className="gateway-footnote">Planner source: {plannerData.source==="free-ai-planner"?"live OpenRouter free model "+(plannerData.modelUsed||""):"deterministic fallback"}. {plannerData.note}</p>}
   <p className="gateway-footnote">Project context sent to the free planner is limited to capability descriptions and model metadata. Do not send confidential client screens or personal/financial data to free models unless approved for your work.</p>
  </section>

  <section className="gateway-panel accountant-global-panel">
   <div className="gateway-panel-heading"><div><span className="section-kicker">GLOBAL FINANCIAL GUARDRAILS</span><h2>Daily plan · monthly controls</h2></div><span className={"status-chip "+(remaining<=0?"status-error":globalCap>0&&spent/globalCap>=.8?"status-warning":"status-success")}>{globalCap>0?Math.round(spent/globalCap*100):100}% of cap used</span></div>
   <div className="accountant-summary-grid">
    <article className="gateway-stat-card"><span>PROJECTED API COST / DAY</span><strong>{inr(projectedDaily)}</strong><small>Selected paid recommendations · planning estimate</small></article>
    <article className="gateway-stat-card"><span>PROJECTED / 22 WORKDAYS</span><strong>{inr(projectedDaily*22)}</strong><small>Does not include tax or payment fees</small></article>
    <article className="gateway-stat-card"><span>MONTH-TO-DATE GATEWAY SPEND</span><strong>{inr(spent)}</strong><small>{data?.budget.month??"Current month"} · usage ledger estimate</small></article>
    <article className="gateway-stat-card"><span>PLANNED CALLS / DAY</span><strong>{plannedCalls.toLocaleString("en-IN")}</strong><small>Across enabled capabilities · free calls estimate ₹0</small></article>
   </div>
   <div className="budget-track"><div className={"budget-fill "+(globalCap>0&&spent/globalCap>=.8?"budget-fill-warning":"")} style={{width:Math.min(100,globalCap>0?spent/globalCap*100:100)+"%"}}/></div>
   <div className="accountant-global-controls">
    <label className="gateway-control-field"><span>Global monthly budget (₹)</span><input type="number" min="0" step="100" value={globalCap} onChange={e=>mutate(s=>({...s,globalMonthlyBudgetInr:Math.max(0,Number(e.target.value)||0)}))}/></label>
    <label className="gateway-control-field"><span>USD → INR rate</span><input type="number" min="1" max="250" step=".5" value={fx} onChange={e=>mutate(s=>({...s,usdToInrRate:Math.max(1,Math.min(250,Number(e.target.value)||97))}))}/><small>Converts live OpenRouter USD token prices into INR.</small></label>
    <label className="gateway-master-toggle"><input type="checkbox" checked={settings?.paidRoutingEnabled??false} onChange={e=>mutate(s=>({...s,paidRoutingEnabled:e.target.checked}))}/><span><strong>Allow paid routing</strong><small>Master switch · also requires server-side ALLOW_PAID_MODELS=true</small></span></label>
   </div>
   <p className="gateway-footnote">Estimates use calls/day × input/output tokens per call × current listed rates. Free variants are estimated at ₹0 only for explicit :free routes. OpenRouter is the source of account usage; the local ledger is useful for capability attribution but is not a transactional hard spend cap.</p>
  </section>

  <section className="gateway-panel gateway-provider-usage-panel">
   <div className="gateway-panel-heading"><div><span className="section-kicker">OPENROUTER ACCOUNT TRACKING</span><h2>Provider-reported spend and limits</h2></div><span className={"status-chip "+(usage?.available?"status-success":"status-neutral")}>{usage?.available?"Connected":"Not available"}</span></div>
   {usage?.available?<><div className="accountant-summary-grid">
    <article className="gateway-stat-card"><span>USAGE TODAY</span><strong>{"$"+(usage.usageDailyUsd??0).toFixed(4)}</strong><small>Provider-reported USD usage</small></article>
    <article className="gateway-stat-card"><span>USAGE THIS MONTH</span><strong>{"$"+(usage.usageMonthlyUsd??0).toFixed(4)}</strong><small>Provider-reported USD usage</small></article>
    <article className="gateway-stat-card"><span>KEY LIMIT REMAINING</span><strong>{usage.remainingUsd===null||usage.remainingUsd===undefined?"Not set":"$"+usage.remainingUsd.toFixed(2)}</strong><small>{usage.limitReset?"Reset: "+usage.limitReset:"No key reset reported"}</small></article>
    <article className="gateway-stat-card"><span>LAST 30 DAYS ACTIVITY</span><strong>{usage.activity30Days?usage.activity30Days.requests.toLocaleString("en-IN"):"—"}</strong><small>{usage.managementAnalyticsAvailable?"Management API activity connected":"Add a separate Management API key for detailed endpoint analytics"}</small></article>
   </div>{usage.activity30Days&&<p className="gateway-footnote">30-day activity: {"$"+usage.activity30Days.usageUsd.toFixed(4)} · {usage.activity30Days.promptTokens.toLocaleString("en-IN")} input tokens · {usage.activity30Days.completionTokens.toLocaleString("en-IN")} output tokens.</p>}</>:<p className="gateway-footnote">{usage?.error||"Usage data will appear after the OpenRouter key is configured. Detailed 30-day model activity needs an optional OPENROUTER_MANAGEMENT_API_KEY."}</p>}
  </section>

  <div className="gateway-section-heading"><div><span className="section-kicker">01 · CAPABILITY ROUTING</span><h2>Choose one model per capability</h2><p>Free is the default. Toggle to Paid to see only paid, price-known, task-relevant candidates. Selecting a model runs a short real availability check; paid tests require confirmation and enabled paid routing.</p></div><span className="count">{modules.filter(m=>settings?.modules[m.id]?.enabled).length} / {modules.length} ON</span></div>
  <div className="gateway-module-grid">{modules.map(module=>{
   const p=settings?.modules[module.id];if(!p)return null;
   const mode=p.mode==="paid"?"paid":"free";
   const options=modelOptions(module,mode);
   const chosen=openRouterModels.find(m=>m.selectionKey===p.selectedModelKey&&modeCompatible(mode,m))??null;
   const suggested=options[0]??null;
   const activeModel=chosen??suggested;
   const used=data?.budget.spentByModuleInr?.[module.id]??0;
   const check=activeModel?modelChecks[activeModel.selectionKey]:undefined;
   const cost=dailyCost(module,p);
   const recText=mode==="free"?plannerData?.recommendations?.[module.id]?.freeReason:plannerData?.recommendations?.[module.id]?.paidReason;
   return <article className={"gateway-module-card "+(!p.enabled?"module-disabled":"")} key={module.id}>
    <div className="gateway-module-head"><div><span className="section-kicker">{module.id.toUpperCase()}</span><h3>{module.label}</h3></div><label className="gateway-switch"><input type="checkbox" checked={p.enabled} onChange={e=>updateModule(module.id,{enabled:e.target.checked})}/><span>{p.enabled?"ON":"OFF"}</span></label></div>
    <p className="gateway-module-description">{module.description}</p>
    <div className="gateway-module-usage"><span>Spent {inr(used)}</span><strong>Plan {inr(cost)} / day</strong></div><div className="budget-track"><div className={"budget-fill "+(p.monthlyBudgetInr>0&&used/p.monthlyBudgetInr>=.8?"budget-fill-warning":"")} style={{width:Math.min(100,p.monthlyBudgetInr?used/p.monthlyBudgetInr*100:100)+"%"}}/></div>
    <div className="gateway-tier-toggle" role="group" aria-label={module.label+" billing mode"}>
     <button type="button" className={mode==="free"?"mode-active":""} aria-pressed={mode==="free"} onClick={()=>updateModule(module.id,{mode:"free",selectedModelKey:"auto"})}>Free</button>
     <button type="button" className={mode==="paid"?"mode-active":""} aria-pressed={mode==="paid"} onClick={()=>updateModule(module.id,{mode:"paid",selectedModelKey:"auto"})}>Paid</button>
    </div>
    <label className="gateway-control-field"><span>Relevant {mode==="free"?"free":"paid"} models <i>{plannerData?"AI-curated":"Metadata-ranked fallback"}</i></span><select disabled={!p.enabled||!options.length} value={chosen?.selectionKey??"auto"} onChange={e=>{
      const picked=options.find(m=>m.selectionKey===e.target.value);
      updateModule(module.id,{selectedModelKey:picked?picked.selectionKey:"auto"});
      if(picked)void checkModel(module,picked,mode);
    }}>
     <option value="auto">Auto recommendation: {suggested?.label??"No compatible listed models"}</option>
     {chosen&&!options.some(m=>m.selectionKey===chosen.selectionKey)&&<option value={chosen.selectionKey}>{chosen.label+" · saved selection"}</option>}
     {options.map(m=>{
       const status=modelChecks[m.selectionKey]?.status;
       const badge=status==="available"?" · AVAILABLE":status==="rate-limited"?" · RATE LIMITED":status&&status!=="unavailable"&&status!=="blocked"?" · "+status.toUpperCase():status==="unavailable"||status==="provider-error"||status==="quota-or-billing"?" · FAILED":" · LISTED / UNTESTED";
       return <option key={m.selectionKey} value={m.selectionKey}>{m.label+(m.tier==="free-tier"?" · FREE":" · PAID")+badge}</option>;
     })}
    </select></label>
    {activeModel&&<div className="gateway-model-detail">
      <div><strong>{activeModel.label}</strong><p>{(activeModel.tier==="free-tier"?"Explicit free route":"Listed paid route")+" · $"+(activeModel.usdInputPerMillion??0).toFixed(4)+" input / $"+(activeModel.usdOutputPerMillion??0).toFixed(4)+" output per 1M tokens · "+(activeModel.contextLength??0).toLocaleString("en-IN")+" context"}</p></div>
      <span className={"status-chip "+(check?.status==="available"?"status-success":check?.status==="rate-limited"||check?.status==="quota-or-billing"?"status-warning":check?.status?"status-error":"status-neutral")}>{check?.status==="available"?"Available":check?.status==="rate-limited"?"Rate limited":check?.status||"Not tested"}</span>
     </div>}
    {activeModel&&check?.error&&<p className="gateway-inline-warning">{check.error}</p>}
    {activeModel&&check?.status==="available"&&<p className="gateway-selected-note">Last check {check.checkedAt?new Date(check.checkedAt).toLocaleTimeString():""} · {check.latencyMs??0} ms · test estimate {inr(check.estimatedCostInr??0)}</p>}
    <div className="gateway-model-actions">{activeModel&&<button className="secondary-button" type="button" disabled={Boolean(checkingModel)} onClick={()=>void checkModel(module,activeModel,mode)}>{checkingModel===activeModel.selectionKey?"Testing model…":"Test selected model ↗"}</button>}<span>Only explicit :free IDs are treated as zero-price candidates.</span></div>
    {recText&&<div className="gateway-recommendation"><div><strong>AI planner reasoning</strong><p>{recText}</p></div></div>}
    <div className="gateway-planning-inputs">
     <label className="gateway-control-field"><span>Calls / day</span><input type="number" min="0" max="100000" step="1" value={p.plannedCallsPerDay} onChange={e=>updateModule(module.id,{plannedCallsPerDay:Math.max(0,Math.min(100000,Number(e.target.value)||0))})}/></label>
     <label className="gateway-control-field"><span>Input tokens / call</span><input type="number" min="0" max="5000000" step="1000" value={p.plannedInputTokens} onChange={e=>updateModule(module.id,{plannedInputTokens:Math.max(0,Math.min(5000000,Number(e.target.value)||0))})}/></label>
     <label className="gateway-control-field"><span>Output tokens / call</span><input type="number" min="0" max="1000000" step="100" value={p.plannedOutputTokens} onChange={e=>updateModule(module.id,{plannedOutputTokens:Math.max(0,Math.min(1000000,Number(e.target.value)||0))})}/></label>
    </div>
    <div className="gateway-policy-budget-row"><label className="gateway-control-field"><span>Module budget / month (₹)</span><input type="number" min="0" step="50" value={p.monthlyBudgetInr} onChange={e=>updateModule(module.id,{monthlyBudgetInr:Math.max(0,Number(e.target.value)||0)})}/></label><label className="gateway-control-field"><span>Max cost / request (₹)</span><input type="number" min="0" step="1" value={p.maxRequestCostInr} onChange={e=>updateModule(module.id,{maxRequestCostInr:Math.max(0,Number(e.target.value)||0)})}/></label></div>
    <p className="gateway-selected-note">Projected: {inr(cost)} / day · {inr(cost*22)} / 22 workdays. {mode==="paid"&&!settings?.paidRoutingEnabled?"Paid inference is currently locked by the master switch.":""}</p>
   </article>;
  })}</div>

  <div className="gateway-section-heading"><div><span className="section-kicker">02 · LIVE MODEL CATALOG</span><h2>Every OpenRouter model · current listed rates</h2><p>Prices and metadata come from OpenRouter. “Listed” is not the same as available right now; test a capability's candidate to check actual inference and detect rate-limit/quota errors.</p></div><span className="count">{openRouterModels.length.toLocaleString("en-IN")} LIVE MODELS</span></div>
  <section className="gateway-panel model-accountant-panel"><div className="model-catalog-toolbar"><label className="gateway-control-field"><span>Search models</span><input value={catalogQuery} onChange={e=>{setCatalogQuery(e.target.value);setCatalogLimit(40);}} placeholder="Name, model ID or capability"/></label><label className="gateway-control-field"><span>Filter models</span><select value={filter} onChange={e=>{setFilter(e.target.value);setCatalogLimit(40);}}><option value="all">All listed models</option><option value="connected">Key configured</option><option value="free">Free variants</option><option value="paid">Priced models</option></select></label><span className="gateway-footnote">Showing {Math.min(catalogRows.length,catalogLimit).toLocaleString("en-IN")} of {catalogRows.length.toLocaleString("en-IN")} matching models.</span></div>
   <div className="model-accountant-table-wrap"><table className="gateway-table model-pricing-table"><thead><tr><th>MODEL / CAPABILITIES</th><th>TIER / LIVE STATUS</th><th>INPUT ₹ / 1M</th><th>OUTPUT ₹ / 1M</th><th>MONTHLY CAP</th><th>MAX / REQUEST</th><th>EXAMPLE COST</th><th>PRICE SOURCE</th></tr></thead><tbody>
    {catalogRows.slice(0,catalogLimit).map(m=>{const p=policyFor(m);const check=modelChecks[m.selectionKey];return <tr key={m.selectionKey}><td><strong>{m.label}</strong><small>{m.id}</small><small>{m.tasks.join(" · ")}</small><small>{m.contextLength?(m.contextLength.toLocaleString("en-IN")+" context tokens · "):""}{(m.inputModalities??[]).join(", ")} input</small></td><td><span className={"gateway-tier tier-"+m.tier}>{m.tier==="free-tier"?"FREE":"PAID"}</span><small>{check?.status==="available"?"Test passed":check?.status?check.status:"Listed · not tested"}</small></td>
     <td><input className="model-price-input" aria-label={m.label+" input price"} type="number" min="0" step=".01" value={p.inputPriceInrPerMillion} onChange={e=>updateModel(m.selectionKey,{inputPriceInrPerMillion:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><input className="model-price-input" aria-label={m.label+" output price"} type="number" min="0" step=".01" value={p.outputPriceInrPerMillion} onChange={e=>updateModel(m.selectionKey,{outputPriceInrPerMillion:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><input className="model-price-input" aria-label={m.label+" monthly cap"} type="number" min="0" step="50" value={p.monthlyBudgetInr} onChange={e=>updateModel(m.selectionKey,{monthlyBudgetInr:Math.max(0,Number(e.target.value)||0)})}/><small>Spent {inr(data?.budget.spentByModelInr?.[m.selectionKey]??0)}</small></td>
     <td><input className="model-price-input" aria-label={m.label+" per-request cap"} type="number" min="0" step="1" value={p.maxRequestCostInr} onChange={e=>updateModel(m.selectionKey,{maxRequestCostInr:Math.max(0,Number(e.target.value)||0)})}/></td>
     <td><strong>{inr(exampleModelCost(p))}</strong><small>{"$"+(m.usdInputPerMillion??0).toFixed(5)+" input / $"+(m.usdOutputPerMillion??0).toFixed(5)+" output USD per 1M"}</small></td>
     <td>{m.pricingSource?<a href={m.pricingSource} target="_blank" rel="noreferrer">Live OpenRouter model ↗</a>:<small>Live rate not supplied</small>}<small>Catalog check {data?.openRouterCatalog.checkedAt?new Date(data.openRouterCatalog.checkedAt).toLocaleTimeString():"unavailable"}</small></td>
    </tr>;})}
   </tbody></table></div>
   {catalogRows.length>catalogLimit&&<div className="catalog-more"><button className="secondary-button" type="button" onClick={()=>setCatalogLimit(limit=>limit+40)}>Show 40 more models</button></div>}
   <p className="gateway-footnote">Example cost assumes 100k input + 20k output tokens. Published model prices are estimates, not a quote for every provider endpoint; taxes, caching, image charges and endpoint-specific differences can apply.</p>
  </section>

  <div className="gateway-section-heading"><div><span className="section-kicker">03 · PROVIDER STATUS</span><h2>Single provider: OpenRouter</h2></div><span className="count">{keyReady} KEY DETECTED</span></div>
  <div className="gateway-provider-grid">{(data?.providers??[]).map(p=><article className="gateway-provider-card" key={p.id}><div className="gateway-provider-top"><span className="gateway-provider-mark">OR</span><span className={"status-chip "+(p.keyDetected?"status-success":"status-neutral")}>{p.keyDetected?"Key detected · catalog checked":"Key not added"}</span></div><h3>{p.label}</h3><p>Unified free and paid model discovery, routing and usage reporting. Provider test status is tracked per selected model.</p><label className="gateway-key-label" htmlFor={"key-slot-"+p.id}>{p.envName}</label><div className="gateway-key-placeholder"><input id={"key-slot-"+p.id} type="password" placeholder="Configured server-side" disabled readOnly aria-label={p.envName+" placeholder; edit disabled"}/><span>{p.keyDetected?"KEY DETECTED":"NOT CONFIGURED"}</span></div><small className="gateway-provider-note">Secret is never returned to this page. Change it only in Netlify's server-side environment settings.</small></article>)}</div>

  <div className="gateway-section-heading"><div><span className="section-kicker">04 · REQUEST LEDGER</span><h2>Actual calls attributed to a capability</h2><p>Token counts, model, latency, status and estimated cost; prompt and response content are never shown.</p></div><span className="count">{Math.min(records.length,200)} / 200 RECORDS</span></div>
  <section className="gateway-panel token-ledger-panel"><div className="token-ledger-intro"><div><strong>Request-by-request accounting</strong><p>Current month; gateway costs are estimates, OpenRouter usage remains the provider source of truth.</p></div><span className="ledger-retention">{data?.budget.retention==="netlify-blobs"?"Persistent · scoped ledger":"Runtime fallback"}</span></div>
   {records.length===0?<div className="gateway-empty-state"><div className="gateway-empty-icon">◷</div><strong>No model calls recorded this month</strong><p>The mock smoke test verifies wiring at ₹0 but isn't AI inference.</p></div>:<div className="token-ledger-table-wrap"><table className="gateway-table token-table"><thead><tr><th>TIME / REQUEST</th><th>CAPABILITY</th><th>MODEL</th><th>INPUT</th><th>OUTPUT</th><th>TOTAL</th><th>EST. COST</th><th>LATENCY</th></tr></thead><tbody>{records.map(r=><tr key={r.id}><td><strong>{new Date(r.at).toLocaleString()}</strong><small>#{r.requestId.slice(0,8)} · {r.status}</small></td><td>{modules.find(m=>m.id===r.moduleId)?.label??r.moduleId??"Unattributed"}</td><td><strong>{r.model}</strong><small>{r.provider} · {r.tier}</small></td><td>{r.usageReported===false?"—":r.promptTokens.toLocaleString("en-IN")}</td><td>{r.usageReported===false?"—":r.completionTokens.toLocaleString("en-IN")}</td><td>{r.usageReported===false?"Unavailable":r.totalTokens.toLocaleString("en-IN")}</td><td>{inr(r.estimatedCostInr)}</td><td>{r.latencyMs.toLocaleString("en-IN")} ms</td></tr>)}</tbody></table></div>}
  </section>
  <div className="gateway-savebar"><div><strong>{dirty.current?"Unsaved configuration":message||"Settings saved"}</strong><p>Save capability selections, budget assumptions, current model rates and the global monthly budget. Paid inference additionally requires the server-side master flag.</p></div><label className="gateway-admin-key"><span>Gateway settings admin key</span><input type="password" autoComplete="off" value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="Enter admin key to save" aria-label="Gateway settings admin key"/><small>Kept in memory only; never saved in browser storage.</small></label><button className="submit-button" type="button" onClick={()=>void save()} disabled={!draft||saving||!dirty.current}>{saving?"Saving…":"Save gateway settings ↗"}</button></div>
  {message&&<p className="gateway-smoke-message" role="status">{message}</p>}
  <p className="gateway-footer-note">Last refreshed {data?.checkedAt?new Date(data.checkedAt).toLocaleTimeString():"not checked"}. Catalog refresh is cached server-side; planner suggestions are cached for 10 minutes. Model tests run only when you select/test a candidate.</p>
  <footer>UX DIRECT <span>·</span> OPENROUTER MODEL MANAGER</footer>
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
