/**
 * UX Director agency: the design pipeline run like a design agency.
 *
 *   UX Director  ── reads the source frame, writes a work order (sections in order, each with
 *   │               its own source texts), and routes every section through ROUTING_TABLE.
 *   ├ UX Lead (structure & flow)  → information, form, interaction, navigation designers
 *   ├ UI Lead (visual & data)     → data-viz, status, header designers
 *   ├ Content Lead                → UX writer
 *   └ QA Lead                     = the route's existing deterministic gates
 *
 * Routing is deterministic (same screen → same assignment, whichever model `auto` picks). Each
 * designer makes ONE small call for ONE section (a few thousand tokens instead of the ~26k
 * monolithic planner prompt), and up to AGENCY_CONCURRENCY calls run at once. A Cloudflare
 * Worker keeps at most 6 outgoing connections open per request and the free providers behind
 * FreeLLMAPI have per-minute quotas, so "40 models at once" would only queue and fall back to
 * weaker models; many specialist roles with ~5 calls in flight is what actually runs fast.
 *
 * Every designer answer is grounded per section: a section that loses too much source content
 * is replaced by its own source version, so one weak model never drops content from the screen.
 */
import { callFigmaJsonModel } from "@/src/figma-agent/json-model-call";
import { BLOCK_SPEC_CONTRACT, sourceFallbackSpec } from "@/src/figma-agent/block-spec";
import type { TaskRole } from "@/src/figma-agent/agent-roles";

type Rec = Record<string, unknown>;

export type LeadId = "ux" | "ui" | "content";
export type DesignerId = "header" | "navigation" | "form" | "dataviz" | "information" | "interaction" | "status" | "writer" | "generalist";

export interface Specialist {
  id: DesignerId;
  lead: LeadId;
  title: string;
  /** How this designer thinks; sent as its persona. */
  focus: string;
  /** Kept from the source deterministically, without a model call. */
  keepAsIs?: boolean;
}

export const LEADS: Record<LeadId, string> = {
  ux: "UX Lead — structure & flow",
  ui: "UI Lead — visual & data",
  content: "Content Lead — UX writing",
};

export const SPECIALISTS: Record<DesignerId, Specialist> = {
  header: { id: "header", lead: "ui", title: "Header designer", keepAsIs: true,
    focus: "Keep the app bar exactly as the product has it: same title, back and action." },
  navigation: { id: "navigation", lead: "ux", title: "Navigation designer", keepAsIs: true,
    focus: "Keep tabs, chips and bottom navigation exactly: same items, same order, same active item." },
  form: { id: "form", lead: "ux", title: "Form designer",
    focus: "Design the form like a senior interaction designer: one input per field with its real label, helper and error text, logical field order, checkboxes as checkbox blocks, the submit action last." },
  dataviz: { id: "dataviz", lead: "ui", title: "Data-viz designer",
    focus: "Design the numbers like a fintech data designer: the single most important amount becomes a stat, related metrics a stat_row (2–4), paid/complete percentages a progress_ring or progress_bar with the real value, supporting values a compact list." },
  information: { id: "information", lead: "ux", title: "Information designer",
    focus: "Design the detail like an information designer: group related key-value lines into one list (not many single rows), label on the left and value on the right, statuses as row status, and put the rows in the order a user scans them." },
  interaction: { id: "interaction", lead: "ux", title: "Interaction designer",
    focus: "Design the actions like an interaction designer: exactly one primary button (the main task), others secondary or text, in a buttons block; never invent new actions." },
  status: { id: "status", lead: "ui", title: "Status designer",
    focus: "Design status and feedback like a UI designer: statuses as badges with the right tone, alerts and notices as banners (info/success/warning/danger) with their real title, body and action." },
  writer: { id: "writer", lead: "content", title: "UX writer",
    focus: "Design the copy like a UX writer: a clear heading, short body text with muted tone for secondary lines, and plain action verbs. Keep every number, date, name and amount exactly." },
  generalist: { id: "generalist", lead: "ux", title: "Product designer",
    focus: "Design this section like a senior product designer: clear hierarchy, grouped content, the right block for each piece of content." },
};

export interface WorkItem {
  /** Position of the section in the screen. */
  index: number;
  name: string;
  designer: Specialist;
  /** "part 1 of 2" when a Lead split a large section across designers. */
  part?: { index: number; of: number };
  source: Rec;
  sourceTexts: string[];
}

export interface WorkOrder {
  items: WorkItem[];
  /** Section positions, with how many parts each has. */
  sections: Array<{ name: string; parts: number }>;
}

export interface DesignerRun {
  section: string;
  designer: DesignerId;
  lead: LeadId;
  ok: boolean;
  ms: number;
  model?: string;
  /** "kept" = no call (header/nav), "fallback" = source section used, "designed" = model output used. */
  outcome: "kept" | "designed" | "fallback";
  error?: string;
  restoredTexts?: number;
  /** Design → review rounds for this section (1 = accepted at first review). */
  rounds?: number;
  /** Issues the reviewer raised over all rounds, and how many were still open at the end. */
  reviewIssues?: number;
  openIssues?: number;
}

export interface AgencyResult {
  spec: Rec | null;
  runs: DesignerRun[];
  ms: number;
  designedSections: number;
  concurrency: number;
}

export function agencyEnabled(): boolean {
  return (process.env.UXD_AGENCY || "on").trim().toLowerCase() !== "off";
}

export function agencyConcurrency(): number {
  const value = Number(process.env.UXD_AGENCY_CONCURRENCY);
  // 6 is the Worker's limit of simultaneous outgoing connections. Default 4: free providers are
  // often rate-limited (2026-11-07), and a 3-variation batch already multiplies it by three.
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 6) : 4;
}

/** Roles the agency handles; restyle keeps structure (one theme decision) and states have their own briefs. */
export function agencyHandlesRole(role: TaskRole): boolean {
  return ["improve", "variation", "wireframe", "content"].includes(role.id);
}

/**
 * Designers work from the layer tree only (no screenshot), so the agency runs only when that
 * tree really holds the screen's content. A node whose childCount is larger than the children
 * that were read (depth or node cap, collapsed instances) hides texts — tester finding: a loan
 * card read as an instance with no children lost every ₹ value and "Personal Loan". Small
 * icons are ignored. Returns the number of truncated content nodes (0 = complete).
 */
export function truncatedContentNodes(canvas: Rec): number {
  return truncatedContentNames(canvas).length;
}

/** Names of the truncated content nodes (shown in Timing so a skip can be checked). */
export function truncatedContentNames(canvas: Rec): string[] {
  const names: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const node = value as Rec;
    if (node.visible === false) return;
    const children = Array.isArray(node.children) ? node.children : [];
    const width = typeof node.width === "number" ? node.width : 999;
    const height = typeof node.height === "number" ? node.height : 999;
    // Logos, icons and small marks (≤64px) are drawn shapes, not content; their vectors are
    // often below the read depth (frame 15: the card logos were reported as unread).
    const mark = width <= 64 && height <= 64;
    if (!mark && typeof node.childCount === "number" && node.childCount > children.length && !["VECTOR", "BOOLEAN_OPERATION"].includes(String(node.type))) {
      names.push(String(node.name || node.type).slice(0, 40));
    }
    for (const child of children) visit(child);
  };
  for (const node of Array.isArray(canvas.nodes) ? canvas.nodes : []) visit(node);
  if (canvas.truncated === true) names.push("read node cap");
  return names;
}

const MAX_BLOCKS_PER_DESIGNER = 12;
const MAX_DESIGNERS = 10;

/** Every string in a block tree (labels, values, items...), for grounding checks. */
export function blockTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  } else if (Array.isArray(value)) {
    for (const item of value) blockTexts(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Rec)) {
      if (key === "type" || key === "tone" || key === "variant" || key === "statusTone" || key === "surface" || key === "componentId" || key === "layout" || key === "shape") continue;
      blockTexts(item, out);
    }
  }
  return out;
}

const AMOUNT = /[₹$€£]\s?\d|\d[\d,.]*\s?%|\b\d{1,3}(,\d{2,3})+\b/;

/**
 * The routing table. Scores the section by the blocks the source already has and by its name,
 * then picks the specialist; the task role can override it (content → writer for every section).
 */
export function routeSection(section: Rec, role: TaskRole): Specialist {
  const blocks = Array.isArray(section.blocks) ? section.blocks as Rec[] : [];
  const types = blocks.map((block) => String(block.type || ""));
  const name = String(section.name || "") + " " + String(section.title || "");
  const only = (...allowed: string[]) => types.length > 0 && types.every((type) => allowed.includes(type));
  if (only("app_bar")) return SPECIALISTS.header;
  if (only("tabs", "bottom_nav", "chips", "steps")) return SPECIALISTS.navigation;
  if (role.id === "content") return SPECIALISTS.writer;
  const count = (...wanted: string[]) => types.filter((type) => wanted.includes(type)).length;
  const texts = blockTexts(blocks);
  const amounts = texts.filter((text) => AMOUNT.test(text)).length;
  const scores: Array<[DesignerId, number]> = [
    ["form", count("input", "otp", "checkbox") * 3 + (/form|detail(s)? entry|sign ?in|log ?in|verify|kyc|address/i.test(name) ? 2 : 0)],
    ["dataviz", count("stat", "stat_row", "progress_ring", "progress_bar") * 3 + Math.min(amounts, 6) + (/summary|overview|balance|emi|amount|total|loan/i.test(name) ? 2 : 0)],
    ["information", count("list") * 3 + count("row") + (/detail|info|history|transaction|schedule|statement/i.test(name) ? 2 : 0)],
    ["interaction", only("button", "buttons") ? 10 : count("button", "buttons") + (/action|cta|footer|continue|submit/i.test(name) ? 2 : 0)],
    ["status", count("badge", "banner") * 2 + (/status|alert|notice|warning|error/i.test(name) ? 2 : 0)],
    ["writer", count("text", "heading") >= Math.max(2, types.length * 0.6) ? 6 : 0],
  ];
  const [best, score] = scores.reduce((top, entry) => (entry[1] > top[1] ? entry : top));
  return score >= 2 ? SPECIALISTS[best] : SPECIALISTS.generalist;
}

/**
 * The Director's work order: the source screen's own sections (grounded, from its layers), each
 * routed to a specialist; a large section is split across designers by its Lead.
 */
export function planWorkOrder(canvas: Rec, role: TaskRole): WorkOrder | null {
  const source = sourceFallbackSpec(canvas);
  const sections = source && Array.isArray(source.sections) ? source.sections as Rec[] : [];
  if (sections.length < 2) return null;
  const items: WorkItem[] = [];
  const order: WorkOrder["sections"] = [];
  // Unstyled wrappers often flatten into many one-row sections ("Loan ID", "Tenure"...). The
  // Director groups runs of tiny unstyled sections into one work item, so one designer groups
  // them properly and the screen does not cost one model call per row.
  const merged: Rec[] = [];
  const tiny = (section: Rec) => section.surface !== "card" && Array.isArray(section.blocks) && section.blocks.length <= 2 &&
    !routeSection(section, role).keepAsIs;
  for (const section of sections) {
    const last = merged[merged.length - 1];
    if (last && tiny(section) && last.__group && (last.blocks as unknown[]).length + (section.blocks as unknown[]).length <= MAX_BLOCKS_PER_DESIGNER) {
      last.blocks = [...(last.blocks as unknown[]), ...(section.blocks as unknown[])];
      last.__count = Number(last.__count) + 1;
      continue;
    }
    merged.push(tiny(section) ? { ...section, __group: true, __count: 1 } : section);
  }
  const grouped = merged.map((entry) => {
    const section = { ...entry };
    const count = Number(section.__count);
    delete section.__group;
    delete section.__count;
    return count > 1 ? { ...section, name: "Details" } : section;
  });
  if (grouped.length < 2) return null;
  grouped.forEach((section, index) => {
    const designer = routeSection(section, role);
    const blocks = Array.isArray(section.blocks) ? section.blocks as Rec[] : [];
    const parts = designer.keepAsIs ? 1 : Math.max(1, Math.ceil(blocks.length / MAX_BLOCKS_PER_DESIGNER));
    const size = Math.ceil(blocks.length / parts);
    for (let part = 0; part < parts; part += 1) {
      const slice = parts === 1 ? section : { ...section, blocks: blocks.slice(part * size, (part + 1) * size) };
      items.push({ index, name: String(section.name || "Section " + (index + 1)), designer, source: slice,
        sourceTexts: blockTexts(slice.blocks), ...(parts > 1 ? { part: { index: part + 1, of: parts } } : {}) });
    }
    order.push({ name: String(section.name || ""), parts });
  });
  // Too many designer calls for one screen: the smallest sections are kept from the source.
  const designed = items.filter((item) => !item.designer.keepAsIs);
  if (designed.length > MAX_DESIGNERS) {
    const keep = new Set(designed.sort((a, b) => b.sourceTexts.length - a.sourceTexts.length).slice(0, MAX_DESIGNERS));
    for (const item of items) if (!item.designer.keepAsIs && !keep.has(item)) item.designer = { ...item.designer, keepAsIs: true };
  }
  // Coverage: every visible source text must be in some work item. The source split caps
  // sections and blocks, so anything it missed goes into a kept "More details" item — inserted
  // deterministically, never left for a model to copy (brain monitor: 7–8 of 34 texts dropped).
  const covered = norm(items.map((item) => item.sourceTexts.join(" \u0001 ")).join(" \u0001 "));
  const missing = [...new Set(canvasTexts(canvas))].filter((text) => !covered.includes(norm(text)));
  if (missing.length) {
    const extra = { name: "More details", surface: "card", blocks: [{ type: "list", items: missing.map((text) => ({ label: text })) }] };
    const index = order.length;
    items.push({ index, name: "More details", designer: { ...SPECIALISTS.information, keepAsIs: true }, source: extra, sourceTexts: missing });
    order.push({ name: "More details", parts: 1 });
  }
  return { items, sections: order };
}

/** Visible TEXT strings of the selected frame, in reading order. */
export function canvasTexts(canvas: Rec): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 14) return;
    const node = value as Rec;
    if (node.visible === false || node.opacity === 0) return;
    if (node.type === "TEXT" && typeof node.text === "string" && node.text.trim()) out.push(node.text.replace(/\s+/g, " ").trim());
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, depth + 1);
  };
  const root = Array.isArray(canvas.nodes) ? canvas.nodes[0] : null;
  visit(root, 0);
  return out;
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}₹%.]+/gu, " ").trim();

/** Source texts of a section that the designer's blocks no longer contain. */
export function droppedTexts(sourceTexts: string[], blocks: unknown): string[] {
  const corpus = norm(blockTexts(blocks).join(" \u0001 "));
  return sourceTexts.filter((text) => {
    const key = norm(text);
    return key.length >= 1 && !corpus.includes(key);
  });
}

/**
 * Accepts a designer's section if it keeps the section's content: >30% dropped → rejected
 * (the source section is used); a few dropped texts are appended back as plain rows.
 */
const VALUE = /[\d₹$€£%]/;
const FORBIDDEN_BLOCKS = new Set(["app_bar", "custom", "bottom_nav"]);

/**
 * Accepts a designer's section only if it keeps the section's content and structure:
 * - every value (anything with a digit, ₹ or %) must survive — a dropped amount is a hard fail;
 * - at most 30% of the plain labels may be dropped, and those are appended back;
 * - no app bar / bottom nav / custom node trees (another designer's job, or layouts the
 *   renderer squeezes), and no card nested in a card section;
 * - the source's container (card or plain), title and badge are kept: the Director owns structure.
 */
export function groundDesignerSection(item: WorkItem, data: Rec): { section: Rec; restored: number } | { error: string } {
  const raw = data.section && typeof data.section === "object" && !Array.isArray(data.section) ? data.section as Rec : data;
  const blocks = Array.isArray(raw.blocks) ? (raw.blocks as unknown[]).filter((block) => block && typeof block === "object" && typeof (block as Rec).type === "string") as Rec[] : [];
  if (!blocks.length) return { error: "no blocks" };
  const forbidden = blocks.find((block) => FORBIDDEN_BLOCKS.has(String(block.type)));
  if (forbidden) return { error: String(forbidden.type) + " block not allowed in a section" };
  const sourceSurface = item.source.surface === "card" ? "card" : "plain";
  if (sourceSurface === "card" && blocks.some((block) => block.type === "card")) return { error: "card nested in a card section" };
  // An added ring or bar must show a real source percentage (finding: an empty "Paid" ring).
  const sourceCorpus = norm(item.sourceTexts.join(" \u0001 "));
  const fakeProgress = blocks.find((block) => (block.type === "progress_ring" || block.type === "progress_bar") &&
    !(typeof block.percent === "number" && sourceCorpus.includes(String(Math.round(block.percent)))));
  if (fakeProgress) return { error: String(fakeProgress.type) + " without a source percentage" };
  const dropped = droppedTexts(item.sourceTexts, blocks);
  const droppedValues = dropped.filter((text) => VALUE.test(text));
  if (droppedValues.length) return { error: "dropped values: " + droppedValues.slice(0, 4).join(", ") };
  if (item.sourceTexts.length && dropped.length / item.sourceTexts.length > 0.3) {
    return { error: "dropped " + dropped.length + "/" + item.sourceTexts.length + " source texts" };
  }
  const restored = dropped.length ? [{ type: "list", items: dropped.map((text) => ({ label: text })) }] : [];
  const sourceTitle = typeof item.source.title === "string" ? item.source.title : "";
  const title = sourceTitle || (typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "");
  // A badge the blocks already show would render twice (finding: "Delinquent" duplicated).
  const badge = (item.source.badge ?? raw.badge) as Rec | undefined;
  const blockCorpus = norm(blockTexts(blocks).join(" \u0001 "));
  const keepBadge = badge && typeof badge === "object" && typeof badge.text === "string" && !blockCorpus.includes(norm(badge.text));
  const section: Rec = {
    name: item.name,
    surface: sourceSurface,
    ...(title ? { title } : {}),
    ...(keepBadge ? { badge } : {}),
    blocks: [...blocks, ...restored],
  };
  return { section, restored: dropped.length };
}

/** Merges the designers' sections back in screen order (parts of a split section concatenate). */
export function assembleSpec(order: WorkOrder, results: Array<{ item: WorkItem; section: Rec }>, summary: string): Rec {
  const sections: Rec[] = [];
  order.sections.forEach((_, index) => {
    const parts = results.filter((result) => result.item.index === index)
      .sort((a, b) => (a.item.part?.index ?? 1) - (b.item.part?.index ?? 1));
    if (!parts.length) return;
    const [first, ...rest] = parts;
    sections.push(rest.length
      ? { ...first.section, blocks: parts.flatMap((part) => Array.isArray(part.section.blocks) ? part.section.blocks as unknown[] : []) }
      : first.section);
  });
  return { summary, frame: {}, sections, learningCandidate: null };
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

function designerSystem(item: WorkItem, context: AgencyContext): string {
  const lead = LEADS[item.designer.lead];
  return [
    "You are the " + item.designer.title + " in UX Direct's design agency, on the team of the " + lead + ". The UX Director split one screen into sections; other designers are designing the other sections at the same time, and the Director merges them.",
    "YOUR SPECIALTY: " + item.designer.focus,
    "TASK ROLE: " + context.role.label + ". " + context.role.persona,
    ...context.role.rules.map((rule) => "- " + rule),
    context.directorBrief ? "DIRECTOR BRIEF (whole screen):\n" + context.directorBrief : "",
    context.designRules ? context.designRules : "",
    context.brain ? "TEAM KNOWLEDGE (the quality standard to follow):\n" + context.brain : "",
    "Design ONLY your section. Do not add an app bar, navigation, or content from other sections. Copy every source text of your section exactly into block fields; never invent data, features or actions.",
    "HARD CHECKS (an answer that fails any is thrown away): every amount, number, percentage and date in sourceTexts appears exactly; keep the section's container (sourceSection.surface) — do not add a card block inside a card section; no custom, app_bar or bottom_nav blocks; a label and its value stay in the same row/stat; a progress_ring keeps its real percent and its label text.",
    BLOCK_SPEC_CONTRACT,
    "RETURN only: {\"section\": {\"name\": string, \"surface\": \"plain\"|\"card\", \"title\"?: string, \"badge\"?: {text, tone}, \"blocks\": [ ... ]}}. No theme, no other sections, no markdown.",
  ].filter(Boolean).join("\n");
}

const QUOTA_ERROR = /rate.?limit|quota|429|too many requests/i;
/** Design → review → redesign rounds per section; each round is two calls, so quota caps it. */
export const REVIEW_ROUNDS = 2;
export const AGENCY_DEADLINE_MS = 60000;

export interface ReviewIssue { severity: "high" | "medium" | "low"; issue: string; fix: string }

type Designed = { ok: true; section: Rec; restored: number; model: string } | { ok: false; error: string };

async function designSection(item: WorkItem, label: string, context: AgencyContext, signal: AbortSignal,
  feedback: { previous: Rec; issues: ReviewIssue[] } | null): Promise<Designed> {
  let restored = 0;
  let accepted: Rec | null = null;
  const result = await callFigmaJsonModel({
    system: designerSystem(item, context),
    user: JSON.stringify({
      userRequest: context.prompt,
      section: label,
      sourceSection: item.source,
      sourceTexts: item.sourceTexts,
      ...(feedback ? {
        yourPreviousVersion: feedback.previous,
        reviewerFeedback: feedback.issues.map((issue) => issue.severity + ": " + issue.issue + " → " + issue.fix),
        task: "Revise your previous version: fix every reviewer point, keep everything that was fine, keep every source text.",
      } : {}),
    }),
    hasVisionInput: false,
    maxTokens: 2500,
    temperature: 0.2,
    title: "UX Direct " + item.designer.title,
    role: "section-designer",
    origin: context.origin,
    timeoutMs: AGENCY_DEADLINE_MS,
    signal,
    // A rejected answer gets one more try (the gateway may route it to another model).
    maxAttempts: 2,
    anyObject: true,
    accept: (data) => {
      const grounded = groundDesignerSection(item, data);
      if ("error" in grounded) return grounded.error;
      accepted = grounded.section;
      restored = grounded.restored;
      return null;
    },
  });
  if (result.ok && accepted) return { ok: true, section: accepted, restored, model: result.model };
  return { ok: false, error: result.ok ? "rejected" : (result.errors.slice(-2).join(" | ") || result.error).slice(0, 200) };
}

/** Deterministic review points: things code can see for sure, so no model is needed for them. */
export function deterministicReview(section: Rec): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const blocks = Array.isArray(section.blocks) ? section.blocks as Rec[] : [];
  const buttons = blocks.flatMap((block) => block.type === "button" ? [block] : block.type === "buttons" && Array.isArray(block.items) ? block.items as Rec[] : []);
  const primaries = buttons.filter((button) => (button.variant ?? "primary") === "primary").length;
  if (primaries > 1) issues.push({ severity: "high", issue: primaries + " primary buttons compete", fix: "Keep one primary (the main task); make the others secondary or text." });
  const seen = new Map<string, number>();
  for (const text of blockTexts(blocks)) if (text.length > 2) seen.set(norm(text), (seen.get(norm(text)) ?? 0) + 1);
  const repeated = [...seen.entries()].filter(([, count]) => count > 1).map(([text]) => text);
  if (repeated.length) issues.push({ severity: "medium", issue: "Repeated content: " + repeated.slice(0, 3).join(", "), fix: "Show each source text once, in the block that matches its meaning." });
  const singleRows = blocks.filter((block) => block.type === "row").length;
  if (singleRows >= 3) issues.push({ severity: "medium", issue: singleRows + " separate row blocks", fix: "Group related rows into one list block." });
  return issues;
}

const REVIEWER_SYSTEM = [
  "You are the Design reviewer in UX Direct's design agency (Quality Lead's team), with an accessibility reviewer's eye. Review ONE section a specialist designer just made, against its source. Be specific; never praise.",
  "Check, in this order: 1) hierarchy: one clear focal point (the key amount or status), secondary info quieter; 2) grouping: related label/value pairs together, one list instead of many rows; 3) action priority: at most one primary button; 4) content order matches how a user scans this section; 5) right block for the content (amount → stat or row value, % → ring/bar with the real value, status → badge); 6) no generic AI filler: no invented headings, taglines, decorative text or features the source does not have; 7) accessibility: labels present, status not by colour only, nothing that hurts reading order.",
  "Only raise issues a designer can fix within this section with the block contract. Return {\"pass\": boolean, \"issues\": [{\"severity\": \"high\"|\"medium\"|\"low\", \"issue\": string, \"fix\": string}]} with at most 4 issues; pass=true when nothing high or medium remains.",
].join("\n");

async function reviewSection(item: WorkItem, label: string, section: Rec, context: AgencyContext, signal: AbortSignal): Promise<{ issues: ReviewIssue[] }> {
  const issues = deterministicReview(section);
  const result = await callFigmaJsonModel({
    system: REVIEWER_SYSTEM + (context.brain ? "\nTEAM KNOWLEDGE (the quality standard):\n" + context.brain.slice(0, 3000) : ""),
    user: JSON.stringify({ userRequest: context.prompt, section: label, designerSpecialty: item.designer.title, sourceSection: item.source, designedSection: section }),
    hasVisionInput: false,
    maxTokens: 900,
    temperature: 0.1,
    title: "UX Direct design reviewer",
    role: "critic",
    origin: context.origin,
    timeoutMs: 25000,
    signal,
    maxAttempts: 1,
    anyObject: true,
    accept: (data) => (Array.isArray(data.issues) || typeof data.pass === "boolean" ? null : "missing issues"),
  }).catch(() => null);
  if (result && result.ok && Array.isArray(result.data.issues)) {
    for (const entry of (result.data.issues as unknown[]).slice(0, 4)) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Rec;
      const severity = record.severity === "high" || record.severity === "medium" ? record.severity : "low";
      const issue = typeof record.issue === "string" ? record.issue.slice(0, 200) : "";
      const fix = typeof record.fix === "string" ? record.fix.slice(0, 200) : "";
      if (issue) issues.push({ severity, issue, fix });
    }
  }
  return { issues };
}

export interface AgencyContext {
  prompt: string;
  role: TaskRole;
  /** Product, goal, primary action etc. from the detector/analyst brief. */
  directorBrief: string;
  designRules: string;
  brain: string;
  origin: string;
}

/**
 * Runs the work order: kept sections pass through, every other section goes to its designer,
 * AGENCY_CONCURRENCY at a time, under one shared deadline so the monolithic planner still has
 * time to run if the agency's result fails the gates.
 */
export async function runAgency(canvas: Rec, context: AgencyContext, options: { deadlineMs?: number } = {}): Promise<AgencyResult> {
  const started = Date.now();
  const concurrency = agencyConcurrency();
  const order = planWorkOrder(canvas, context.role);
  if (!order) return { spec: null, runs: [], ms: 0, designedSections: 0, concurrency };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? AGENCY_DEADLINE_MS);
  const runs: DesignerRun[] = [];
  // Quota circuit breaker: once two designers hit rate limits or exhausted quotas, the rest are
  // kept from the source instead of spending more of the free quota the fallback planner needs.
  let quotaHits = 0;
  try {
    const results = await pool(order.items, concurrency, async (item): Promise<{ item: WorkItem; section: Rec }> => {
      const label = item.name + (item.part ? " (" + item.part.index + "/" + item.part.of + ")" : "");
      const base = { section: label, designer: item.designer.id, lead: item.designer.lead };
      if (item.designer.keepAsIs || quotaHits >= 2 || deadline.signal.aborted) {
        if (!item.designer.keepAsIs) {
          runs.push({ ...base, ok: false, ms: 0, outcome: "fallback", error: quotaHits >= 2 ? "skipped: provider quota/rate limit" : "skipped: agency deadline" });
          return { item, section: item.source };
        }
        runs.push({ ...base, ok: true, ms: 0, outcome: "kept" });
        return { item, section: item.source };
      }
      const callStarted = Date.now();
      const designed = await designSection(item, label, context, deadline.signal, null);
      if (!designed.ok) {
        if (QUOTA_ERROR.test(designed.error)) quotaHits += 1;
        runs.push({ ...base, ok: false, ms: Date.now() - callStarted, outcome: "fallback", error: designed.error });
        return { item, section: item.source };
      }
      // Reviewer: starts on this section as soon as it is designed, while designers are still
      // working on the sections below it (top to bottom). Concrete issues go back to the same
      // designer for another iteration, then the reviewer checks again (at most REVIEW_ROUNDS).
      let current = designed;
      let rounds = 1;
      let raised = 0;
      let open: ReviewIssue[] = [];
      while (true) {
        const remaining = (options.deadlineMs ?? AGENCY_DEADLINE_MS) - (Date.now() - started);
        if (remaining < 12000 || quotaHits >= 2) break;
        const review = await reviewSection(item, label, current.section, context, deadline.signal);
        open = review.issues.filter((issue) => issue.severity !== "low");
        raised += review.issues.length;
        if (!open.length || rounds >= REVIEW_ROUNDS || Date.now() - started > (options.deadlineMs ?? AGENCY_DEADLINE_MS) - 15000) break;
        const iteration = await designSection(item, label, context, deadline.signal, { previous: current.section, issues: open });
        rounds += 1;
        if (!iteration.ok) break; // keep the last accepted version
        current = iteration;
      }
      runs.push({ ...base, ok: true, ms: Date.now() - callStarted, model: current.model, outcome: "designed",
        ...(current.restored ? { restoredTexts: current.restored } : {}), rounds, reviewIssues: raised, openIssues: open.length });
      return { item, section: current.section };
    });
    const designedSections = runs.filter((run) => run.outcome === "designed").length;
    const spec = designedSections
      ? assembleSpec(order, results, "Improved the screen section by section, keeping every source value.")
      : null;
    return { spec, runs, ms: Date.now() - started, designedSections, concurrency };
  } finally {
    clearTimeout(timer);
  }
}
