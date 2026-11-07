/**
 * UX Direct's studio workflow (backend only; nothing here is shown in plugin replies).
 *
 * ONE designer builds any one screen, top to bottom, so it keeps one mindset (Zunaid, 2026-11-07:
 * splitting a screen across people, by card or by UX-then-UI step, broke consistency).
 *
 *   UX Director ─ routes the task to exactly one designer (deterministic) and makes the final
 *   │             call: a new version is kept only if every gate passes and it is not worse.
 *   └ UX Lead   ─ reviews the whole finished screen top to bottom (UX and UI), scores it, sends
 *     │           concrete notes; the same designer iterates; the Lead re-reviews, until the score
 *     │           reaches the bar (default 70) or the round/time cap.
 *     ├ Product Designer ─ master of UX and UI, strongest model: improve, fix, variation on an
 *     │                    existing UI, and any task that touches both. Gets most of the work.
 *     ├ UX Designer      ─ wireframes, research, synthesis, audit, IA, flows, content structure.
 *     └ UI Designer      ─ pure visual/component changes: theme, buttons, components, styles.
 *
 * The model calls carry X-UXD-Agent-Role so the gateway gives each seat its own model chain.
 */
import { callFigmaJsonModel } from "@/src/figma-agent/json-model-call";
import { BLOCK_SPEC_CONTRACT } from "@/src/figma-agent/block-spec";
import type { TaskRole } from "@/src/figma-agent/agent-roles";
import { retrieveKnowledge } from "@/src/knowledge/store";
import type { AgentRole } from "@/src/providers/active-chat-provider";

type Rec = Record<string, unknown>;

export type StudioSeat = "director" | "ux-lead" | "product-designer" | "ux-designer" | "ui-designer";
export type DesignerSeat = "product-designer" | "ux-designer" | "ui-designer";

export interface StudioMember { seat: StudioSeat; title: string; reportsTo: StudioSeat | null; does: string }

export const STUDIO: StudioMember[] = [
  { seat: "director", title: "UX Director", reportsTo: null,
    does: "Takes the project, decides what kind of work it is and which one designer owns it, and makes the final call. Thinks like a senior Apple design director, grounded in Norman, Nielsen Norman Group heuristics and the laws of UX." },
  { seat: "ux-lead", title: "UX Lead", reportsTo: "director",
    does: "Reviews every finished screen top to bottom, UX and UI alike, scores it, and sends concrete fixes back to the same designer until it meets the bar." },
  { seat: "product-designer", title: "Product Designer", reportsTo: "ux-lead",
    does: "Master of both UX and UI: structure, hierarchy, content and visual design together, in one consistent pass. Improves, fixes and makes variations of existing screens." },
  { seat: "ux-designer", title: "UX Designer", reportsTo: "ux-lead",
    does: "Research, synthesis, audits, benchmarking, information architecture, flows and wireframes; owns structure, content and hierarchy." },
  { seat: "ui-designer", title: "UI Designer", reportsTo: "ux-lead",
    does: "Visual and component changes on an existing screen: theme, buttons, components, states and styles, within the file's design system." },
];

const member = (seat: StudioSeat) => STUDIO.find((entry) => entry.seat === seat)!;

export function studioReviewEnabled(): boolean {
  return (process.env.UXD_LEAD_REVIEW || "on").trim().toLowerCase() !== "off";
}

const envInt = (name: string, fallback: number, min: number, max: number) => {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
/** The Lead's pass bar (0-100) and the most review→iteration rounds per screen. */
export const leadPassScore = () => envInt("UXD_LEAD_PASS", 70, 40, 95);
export const leadMaxRounds = () => envInt("UXD_LEAD_ROUNDS", 3, 1, 5);

/** Gateway seat (X-UXD-Agent-Role) for each studio seat. */
export function gatewaySeat(seat: StudioSeat): AgentRole {
  return seat === "ux-lead" ? "lead" : seat;
}

/** Role-specific knowledge for one seat; empty on any failure. */
export async function seatKnowledge(seat: StudioSeat, query: string, domain: string | null, maxChars = 2500): Promise<string> {
  try {
    const pack = await retrieveKnowledge({ query, role: member(seat).title, domain, maxChars, skipIds: ["identity-ux-direct", "identity-voice"] });
    return pack.text;
  } catch {
    return "";
  }
}

const UI_ONLY = /\b(button|buttons|cta|component|components|icon|icons|colou?r|theme|dark mode|light mode|font|typography|radius|corner|shadow|style|styles|spacing|padding)\b/i;
const STRUCTURE = /\b(flow|layout|structure|hierarchy|content|section|sections|information|ia|reorder|group|journey|wireframe|research|audit)\b/i;

/** Director's routing: exactly one designer owns the screen. */
export function taskOwner(role: TaskRole, prompt = ""): DesignerSeat {
  if (role.id === "wireframe" || role.id === "content") return "ux-designer";
  if (role.id === "restyle") return "ui-designer";
  // A pure visual/component ask on an existing screen goes to the UI Designer; anything that also
  // touches structure (improve, fix, variation) goes to the Product Designer.
  if (UI_ONLY.test(prompt) && !STRUCTURE.test(prompt) && role.id !== "variation") return "ui-designer";
  return "product-designer";
}

/** Persona line for the owning designer (added to the planner's system prompt and every iteration). */
export function designerPersona(role: TaskRole, prompt = ""): string {
  const seat = taskOwner(role, prompt);
  return "YOUR SEAT: " + member(seat).title + " at UX Direct. " + member(seat).does +
    " You alone design this whole screen, top to bottom, with one mindset: repeated cards use the same structure, blocks and emphasis." +
    " Logo names and chevron glyphs (>, ›) in the layers are decoration, never text blocks." +
    " The UX Lead reviews your finished screen and you iterate on the notes, so do it right the first time: keep every source text and value, no generic filler, no invented content.";
}

export interface LeadNote { severity: "high" | "medium" | "low"; issue: string; fix: string; /** Set on deterministic notes: missing, primary, glyph, invented, repeat. */ code?: string }

const blockTexts = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") { const text = value.trim(); if (text) out.push(text); }
  else if (Array.isArray(value)) for (const item of value) blockTexts(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Rec)) {
      if (["type", "tone", "variant", "statusTone", "surface", "componentId", "layout", "shape", "name"].includes(key)) continue;
      blockTexts(item, out);
    }
  }
  return out;
};

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Every text a block spec shows (labels, values, captions, titles), as written. */
export function specRawTexts(spec: Rec): string[] {
  const sections = Array.isArray(spec.sections) ? spec.sections as Rec[] : [];
  return sections.flatMap((section) => blockTexts([section.title, section.badge, section.blocks]));
}

/** The same texts, normalised for matching. */
export function specTexts(spec: Rec): string[] {
  return specRawTexts(spec).map(norm);
}

/**
 * Source texts the screen no longer shows, counted: a text the source shows three times (one per
 * loan card) must still show three times, so merging repeated cards counts as losing content.
 * Matching ignores case and spacing; a text inside a longer one ("₹10,000" in "Pay ₹10,000") counts.
 */
export function missingFromSpec(spec: Rec, sourceTexts: string[]): string[] {
  const shown = specTexts(spec);
  const need = new Map<string, { raw: string; count: number }>();
  for (const raw of sourceTexts) {
    const text = norm(raw);
    if (!text) continue;
    const entry = need.get(text);
    if (entry) entry.count += 1; else need.set(text, { raw, count: 1 });
  }
  const out: string[] = [];
  for (const [text, { raw, count }] of need) {
    const exact = shown.filter((item) => item === text).length;
    const inside = exact >= count ? 0 : shown.filter((item) => item !== text && item.includes(text)).length;
    for (let missing = count - exact - inside; missing > 0; missing--) out.push(raw);
  }
  return out;
}

/** Texts the previous version showed that the new one dropped, counted (as the previous version wrote them). */
export function lostTexts(previous: Rec, next: Rec): string[] {
  return missingFromSpec(next, specRawTexts(previous));
}

/** Texts the screen shows that are in neither the source nor the user's request (invented content). */
export function inventedTexts(spec: Rec, sourceTexts: string[], prompt = ""): string[] {
  const source = sourceTexts.map(norm);
  const joined = source.join("\n");
  const ask = norm(prompt);
  const out: string[] = [];
  for (const raw of new Set(specRawTexts(spec))) {
    const text = norm(raw);
    if (text.length < 4 || source.includes(text) || joined.includes(text) || ask.includes(text)) continue;
    // A combination of source texts ("Pay ₹10,000" from "Pay" + "₹10,000") is not invented.
    const words = text.split(" ").filter((word) => word.length > 2);
    if (words.length && words.every((word) => joined.includes(word))) continue;
    out.push(raw);
  }
  return out;
}

/** A text with no letters or digits (">", "›", "•", "|"): a glyph, not content. */
export const isGlyphText = (text: string) => !/[\p{L}\p{N}]/u.test(text);

/**
 * The source's content texts, counted, from the full layer read: skips glyph-only texts and texts
 * inside small marks (logo or icon groups ≤ 64 px), which are decoration, not content to keep.
 * Returns { content, decorative } so the Lead can also flag decoration shown as content.
 */
export function sourceContentTexts(nodes: unknown[]): { content: string[]; decorative: string[] } {
  const content: string[] = [];
  const decorative: string[] = [];
  const visit = (items: unknown[], inMark: boolean, depth: number) => {
    if (depth > 14 || content.length + decorative.length >= 160) return;
    for (const value of items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Rec;
      if (node.visible === false || node.opacity === 0) continue;
      const width = typeof node.width === "number" ? node.width : Infinity;
      const height = typeof node.height === "number" ? node.height : Infinity;
      const mark = inMark || (node.type !== "TEXT" && depth > 0 && width <= 64 && height <= 64);
      if (node.type === "TEXT" && typeof node.text === "string" && node.text.trim()) {
        const text = node.text.trim().slice(0, 240);
        (mark || isGlyphText(text) ? decorative : content).push(text);
      }
      if (Array.isArray(node.children)) visit(node.children, mark, depth + 1);
    }
  };
  visit(nodes, false, 0);
  return { content, decorative };
}

/** Amounts, counts, dates and percentages: never allowed to disappear in an iteration. */
export const isValueText = (text: string) => /[\d₹$€£%]/.test(text);

/** What the Lead can see for sure without a model: missing source content, competing primaries, duplicated content. */
export function deterministicLeadNotes(spec: Rec, sourceTexts: string[] = [], decorative: string[] = []): LeadNote[] {
  const notes: LeadNote[] = [];
  const missing = sourceTexts.length ? [...new Set(missingFromSpec(spec, sourceTexts))] : [];
  if (missing.length) notes.push({ code: "missing", severity: "high", issue: "Source content missing from the screen (" + missing.length + "): " + missing.slice(0, 8).join(", "),
    fix: "Put every one of these exact texts back, in the block that matches its meaning (amounts as values, never dropped)." });
  const shownDecoration = [...new Set(decorative.map((text) => text.trim()))].filter((text) => {
    const key = norm(text);
    return specTexts(spec).some((item) => item === key) && !sourceTexts.some((source) => norm(source) === key);
  });
  if (shownDecoration.length) notes.push({ code: "glyph", severity: "medium", issue: "Logo or icon glyph text shown as content: " + shownDecoration.slice(0, 4).join(", "),
    fix: "Remove these texts from the blocks; logos and chevrons are not content (rows get their chevron from the block)." });
  const invented = sourceTexts.length ? inventedTexts(spec, [...sourceTexts, ...decorative]) : [];
  if (invented.length) notes.push({ code: "invented", severity: "medium", issue: "Text not in the source (invented): " + invented.slice(0, 6).join(", "),
    fix: "Remove invented headings, banners, buttons and captions; use only the source's own texts." });
  const sections = Array.isArray(spec.sections) ? spec.sections as Rec[] : [];
  const blocks = sections.flatMap((section) => Array.isArray(section.blocks) ? section.blocks as Rec[] : []);
  const buttons = blocks.flatMap((block) => block.type === "button" ? [block] : block.type === "buttons" && Array.isArray(block.items) ? block.items as Rec[] : []);
  // The action type is the label's verb without amounts: "Pay ₹12,570" and "Pay now" are one action.
  const actionType = (label: string) => norm(label.replace(/[₹$€£]?\s?[\d][\d,.]*\s?%?/g, " ")).split(" ")[0] || norm(label);
  const primaryLabels = buttons.filter((button) => (button.variant ?? "primary") === "primary").map((button) => String(button.label ?? ""));
  const primaryTypes = new Set(primaryLabels.map(actionType));
  // Repeated cards (one "Pay now" per loan card) are fine; different primaries compete.
  if (primaryTypes.size > 1) notes.push({ code: "primary", severity: "high", issue: "Different primary actions compete: " + [...new Set(primaryLabels)].slice(0, 3).join(", "), fix: "Keep one primary action type; make the others secondary or text." });
  const counts = new Map<string, number>();
  for (const section of sections) {
    const seenHere = new Set<string>();
    for (const text of blockTexts(section.blocks)) {
      const key = text.toLowerCase();
      if (key.length > 3 && seenHere.has(key)) counts.set(key, (counts.get(key) ?? 1) + 1);
      seenHere.add(key);
    }
  }
  const repeated = [...counts.keys()];
  if (repeated.length) notes.push({ code: "repeat", severity: "medium", issue: "Same text twice inside one section: " + repeated.slice(0, 3).join(", "), fix: "Show each source text once, in the block that matches its meaning." });
  return notes;
}

const LEAD_SYSTEM = [
  "You are the UX Lead at UX Direct, a senior design lead reviewing your designer's finished screen, top to bottom, before it goes to the UX Director. Review UX and UI alike. Think like a senior lead at Apple: one clear goal per screen, ruthless hierarchy, consistency, content first. Be specific; never praise.",
  "Review the designed screen (a block spec) against the source text list and the user's request. Check: 1) the screen does what the user asked; 2) every source text and value is still shown; 3) hierarchy: one focal point per card/section, secondary info quieter; 4) consistency: repeated cards use the same structure, blocks and emphasis; 5) grouping: label/value pairs together, lists instead of many rows; 6) action priority: one primary action type; 7) right block per content (amount → stat/row value, % → ring/bar with the real value, status → badge); 8) visual: tones, emphasis and components used consistently; 9) no generic AI filler (invented headings, taglines, decorative text, features not in the source); 10) accessibility: labels present, status not by colour only.",
  "Score the screen 0-100 against a top design agency's bar (70 = ready for the Director). Only raise issues the designer can fix with the block contract. Return {\"score\": number, \"notes\": [{\"severity\": \"high\"|\"medium\"|\"low\", \"issue\": string, \"fix\": string}]} with at most 6 notes, most important first.",
].join("\n");

export interface LeadReview { notes: LeadNote[]; score: number | null; model?: string; ms: number }

/** The Lead's top-to-bottom review. A high deterministic note caps the score below the bar. */
export async function leadReview(spec: Rec, context: { prompt: string; role: TaskRole; sourceTexts: string[]; decorativeTexts?: string[]; origin: string; brain: string; knowledge?: string; round?: number; signal?: AbortSignal; timeoutMs: number }): Promise<LeadReview> {
  const started = Date.now();
  const notes = deterministicLeadNotes(spec, context.sourceTexts, context.decorativeTexts ?? []);
  const result = await callFigmaJsonModel({
    system: LEAD_SYSTEM +
      (context.knowledge ? "\nUX LEAD KNOWLEDGE (review checklist and critique format):\n" + context.knowledge.slice(0, 3000) : "") +
      (context.brain ? "\nTEAM KNOWLEDGE (the quality standard):\n" + context.brain.slice(0, context.knowledge ? 2500 : 4000) : ""),
    user: JSON.stringify({ userRequest: context.prompt, taskRole: context.role.label, reviewRound: context.round ?? 1, sourceTexts: context.sourceTexts.slice(0, 120), designedScreen: { sections: spec.sections } }),
    hasVisionInput: false,
    maxTokens: 1400,
    temperature: 0.1,
    title: "UX Direct lead review",
    role: "lead",
    origin: context.origin,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
    maxAttempts: 1,
    anyObject: true,
    accept: (data) => (Array.isArray(data.notes) || typeof data.score === "number" ? null : "missing notes"),
  }).catch(() => null);
  let score: number | null = null;
  if (result && result.ok) {
    if (typeof result.data.score === "number" && Number.isFinite(result.data.score)) score = Math.max(0, Math.min(100, Math.round(result.data.score <= 1 ? result.data.score * 100 : result.data.score)));
    for (const entry of (Array.isArray(result.data.notes) ? result.data.notes as unknown[] : []).slice(0, 6)) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Rec;
      const severity = record.severity === "high" || record.severity === "medium" ? record.severity : "low";
      const issue = typeof record.issue === "string" ? record.issue.slice(0, 220) : "";
      if (issue) notes.push({ severity, issue, fix: typeof record.fix === "string" ? record.fix.slice(0, 220) : "" });
    }
  }
  // Missing content or competing primaries are never "ready", whatever the model scored.
  if (notes.some((note) => note.severity === "high")) score = Math.min(score ?? 100, leadPassScore() - 15);
  return { notes, score, model: result && result.ok ? result.model : undefined, ms: Date.now() - started };
}

/** Lead's verdict on a review: ready when the score meets the bar and no high note is open. */
export function leadApproves(review: LeadReview): boolean {
  if (review.notes.some((note) => note.severity === "high")) return false;
  if (review.score === null) return !review.notes.some((note) => note.severity === "medium");
  return review.score >= leadPassScore();
}

/** The same designer iterates on the whole screen from the Lead's notes. */
export async function reviseFromNotes(spec: Rec, notes: LeadNote[], context: { prompt: string; role: TaskRole; sourceTexts: string[]; origin: string; designRules: string; knowledge?: string; signal?: AbortSignal; timeoutMs: number }): Promise<{ spec: Rec | null; model?: string; ms: number; error?: string }> {
  const started = Date.now();
  const result = await callFigmaJsonModel({
    system: [designerPersona(context.role, context.prompt),
      context.role.persona, ...context.role.rules.map((rule) => "- " + rule), context.designRules,
      context.knowledge ? "YOUR ROLE KNOWLEDGE:\n" + context.knowledge.slice(0, 2500) : "",
      "Your UX Lead reviewed your whole screen top to bottom. Iterate on it: fix every high and medium note, keep everything that was fine, keep every source text and value exactly, keep repeated cards consistent, never add content the source does not have. Return the whole screen.",
      BLOCK_SPEC_CONTRACT].filter(Boolean).join("\n"),
    user: JSON.stringify({ userRequest: context.prompt, sourceTexts: context.sourceTexts.slice(0, 120), yourScreen: { summary: spec.summary, sections: spec.sections },
      leadNotes: notes.filter((note) => note.severity !== "low").map((note) => note.severity + ": " + note.issue + " → " + note.fix) }),
    hasVisionInput: false,
    maxTokens: 6000,
    temperature: 0.15,
    title: "UX Direct designer iteration",
    role: gatewaySeat(taskOwner(context.role, context.prompt)),
    origin: context.origin,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
    maxAttempts: 1,
    anyObject: true,
    accept: (data) => (Array.isArray(data.sections) && data.sections.length ? null : "no sections"),
  }).catch((error: unknown) => ({ ok: false as const, status: 0, error: String(error), errors: [] as string[] }));
  if (result.ok) return { spec: { ...spec, ...result.data, frame: spec.frame, theme: spec.theme }, model: result.model, ms: Date.now() - started };
  return { spec: null, ms: Date.now() - started, error: (result.errors?.[0] || result.error || "").slice(0, 160) };
}
