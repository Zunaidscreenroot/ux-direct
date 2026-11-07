/**
 * UX Direct's studio workflow (backend only; nothing here is shown in plugin replies).
 *
 * Work is split by TASK, not by piece of screen: one screen is designed by one designer so it
 * keeps one mindset (Zunaid, 2026-11-07: four people on four cards broke consistency).
 *
 *   UX Director ─ gets the request, decides the task type and owner (deterministic), gives the
 *   │             final approval (deterministic: every gate passes and quality does not drop).
 *   └ UX Lead   ─ breaks the work down, reviews every designer output with a senior mindset,
 *     │           sends concrete feedback; the designer revises once.
 *     ├ UX Designer ─ research, synthesis, audit, benchmarking, IA, flows, wireframes, and
 *     │               the structure/content/hierarchy of a screen.
 *     └ UI Designer ─ visual design (VD) on a wireframe or screen: theme, emphasis, components.
 *                    On "improve" both collaborate in one pass (UX owns structure, UI owns look).
 *
 * The model calls carry X-UXD-Agent-Role so the gateway gives each seat its own model chain.
 */
import { callFigmaJsonModel } from "@/src/figma-agent/json-model-call";
import { BLOCK_SPEC_CONTRACT } from "@/src/figma-agent/block-spec";
import type { TaskRole } from "@/src/figma-agent/agent-roles";

type Rec = Record<string, unknown>;

export type StudioSeat = "director" | "ux-lead" | "ux-designer" | "ui-designer";

export interface StudioMember { seat: StudioSeat; title: string; reportsTo: StudioSeat | null; does: string }

export const STUDIO: StudioMember[] = [
  { seat: "director", title: "UX Director", reportsTo: null,
    does: "Takes the project, decides what kind of work it is and who owns it, and gives the final approval. Thinks like a senior Apple design director, grounded in Norman, Nielsen Norman Group heuristics and the laws of UX." },
  { seat: "ux-lead", title: "UX Lead", reportsTo: "director",
    does: "Breaks the work down, hands UX work to the UX Designer and visual work to the UI Designer, and reviews every output with a senior lead's eye before it goes to the Director." },
  { seat: "ux-designer", title: "UX Designer", reportsTo: "ux-lead",
    does: "Research, synthesis, audits, benchmarking, information architecture, flows and wireframes; owns a screen's structure, content and hierarchy." },
  { seat: "ui-designer", title: "UI Designer", reportsTo: "ux-lead",
    does: "Visual design on a wireframe or screen: theme, emphasis, components and states, within the file's design system." },
];

export function studioReviewEnabled(): boolean {
  return (process.env.UXD_LEAD_REVIEW || "on").trim().toLowerCase() !== "off";
}

/** Director's routing: which designer owns a screen task. */
export function taskOwner(role: TaskRole): { owner: StudioSeat; collaborator: StudioSeat | null } {
  if (role.id === "restyle") return { owner: "ui-designer", collaborator: null };
  if (role.id === "improve" || role.id === "variation") return { owner: "ux-designer", collaborator: "ui-designer" };
  return { owner: "ux-designer", collaborator: null }; // wireframe, content
}

/** Persona line added to the designer's (planner's) system prompt. */
export function designerPersona(role: TaskRole): string {
  const { owner, collaborator } = taskOwner(role);
  const member = STUDIO.find((entry) => entry.seat === owner)!;
  return "YOUR SEAT: " + member.title + " at UX Direct. " + member.does +
    (collaborator ? " You work on this screen together with the UI Designer: you own structure, content order and hierarchy; the UI Designer owns emphasis, block choice for data, status tones and component reuse. Produce one consistent screen with one mindset." : "") +
    " The UX Lead reviews your output before the Director approves it, so do it right the first time: no generic filler, no invented content.";
}

export interface LeadNote { severity: "high" | "medium" | "low"; issue: string; fix: string }

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

/** What the Lead can see for sure without a model: competing primaries, duplicated content. */
export function deterministicLeadNotes(spec: Rec): LeadNote[] {
  const notes: LeadNote[] = [];
  const sections = Array.isArray(spec.sections) ? spec.sections as Rec[] : [];
  const blocks = sections.flatMap((section) => Array.isArray(section.blocks) ? section.blocks as Rec[] : []);
  const buttons = blocks.flatMap((block) => block.type === "button" ? [block] : block.type === "buttons" && Array.isArray(block.items) ? block.items as Rec[] : []);
  const primaryLabels = buttons.filter((button) => (button.variant ?? "primary") === "primary").map((button) => String(button.label ?? ""));
  // Repeated cards (one "Pay now" per loan card) are fine; different primaries compete.
  if (new Set(primaryLabels).size > 1) notes.push({ severity: "high", issue: "Different primary actions compete: " + [...new Set(primaryLabels)].slice(0, 3).join(", "), fix: "Keep one primary action type; make the others secondary or text." });
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
  if (repeated.length) notes.push({ severity: "medium", issue: "Same text twice inside one section: " + repeated.slice(0, 3).join(", "), fix: "Show each source text once, in the block that matches its meaning." });
  return notes;
}

const LEAD_SYSTEM = [
  "You are the UX Lead at UX Direct, a senior design lead reviewing your designer's screen before it goes to the UX Director. Think like a senior lead at Apple: one clear goal per screen, ruthless hierarchy, consistency, content first. Be specific; never praise.",
  "Review the designed screen (a block spec) against the source text list and the user's request. Check: 1) the screen does what the user asked, in the given task role; 2) hierarchy: one focal point per card/section, secondary info quieter; 3) consistency: repeated cards use the same structure and blocks; 4) grouping: label/value pairs together, lists instead of many rows; 5) action priority; 6) right block per content (amount → stat/row value, % → ring/bar with the real value, status → badge); 7) no generic AI filler (invented headings, taglines, decorative text, features not in the source); 8) accessibility: labels present, status not by colour only.",
  "Only raise issues the designer can fix with the block contract. Return {\"approve\": boolean, \"notes\": [{\"severity\": \"high\"|\"medium\"|\"low\", \"issue\": string, \"fix\": string}]} with at most 5 notes; approve=true when nothing high or medium remains.",
].join("\n");

export async function leadReview(spec: Rec, context: { prompt: string; role: TaskRole; sourceTexts: string[]; origin: string; brain: string; signal?: AbortSignal; timeoutMs: number }): Promise<{ notes: LeadNote[]; model?: string; ms: number }> {
  const started = Date.now();
  const notes = deterministicLeadNotes(spec);
  const result = await callFigmaJsonModel({
    system: LEAD_SYSTEM + (context.brain ? "\nTEAM KNOWLEDGE (the quality standard):\n" + context.brain.slice(0, 4000) : ""),
    user: JSON.stringify({ userRequest: context.prompt, taskRole: context.role.label, sourceTexts: context.sourceTexts.slice(0, 120), designedScreen: { sections: spec.sections } }),
    hasVisionInput: false,
    maxTokens: 1200,
    temperature: 0.1,
    title: "UX Direct lead review",
    role: "planner",
    origin: context.origin,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
    maxAttempts: 1,
    anyObject: true,
    accept: (data) => (Array.isArray(data.notes) || typeof data.approve === "boolean" ? null : "missing notes"),
  }).catch(() => null);
  if (result && result.ok && Array.isArray(result.data.notes)) {
    for (const entry of (result.data.notes as unknown[]).slice(0, 5)) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Rec;
      const severity = record.severity === "high" || record.severity === "medium" ? record.severity : "low";
      const issue = typeof record.issue === "string" ? record.issue.slice(0, 220) : "";
      if (issue) notes.push({ severity, issue, fix: typeof record.fix === "string" ? record.fix.slice(0, 220) : "" });
    }
  }
  return { notes, model: result && result.ok ? result.model : undefined, ms: Date.now() - started };
}

/** The designer revises the whole screen once from the Lead's notes (same designer, same mindset). */
export async function reviseFromNotes(spec: Rec, notes: LeadNote[], context: { prompt: string; role: TaskRole; sourceTexts: string[]; origin: string; designRules: string; signal?: AbortSignal; timeoutMs: number }): Promise<{ spec: Rec | null; model?: string; ms: number; error?: string }> {
  const started = Date.now();
  const result = await callFigmaJsonModel({
    system: [designerPersona(context.role), context.role.persona, ...context.role.rules.map((rule) => "- " + rule), context.designRules,
      "Your UX Lead reviewed your screen. Revise it: fix every high and medium note, keep everything that was fine, keep every source text exactly, never add content the source does not have.",
      BLOCK_SPEC_CONTRACT].filter(Boolean).join("\n"),
    user: JSON.stringify({ userRequest: context.prompt, sourceTexts: context.sourceTexts.slice(0, 120), yourScreen: { summary: spec.summary, sections: spec.sections },
      leadNotes: notes.filter((note) => note.severity !== "low").map((note) => note.severity + ": " + note.issue + " → " + note.fix) }),
    hasVisionInput: false,
    maxTokens: 6000,
    temperature: 0.15,
    title: "UX Direct designer revision",
    role: "section-designer",
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
