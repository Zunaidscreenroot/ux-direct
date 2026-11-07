/**
 * Journey planning: "create a journey to pay an overdue EMI" becomes an ordered list of screens
 * (entry → steps → success, plus one failure state with a way back), each with its one primary
 * action. The plugin then builds every screen from one shared kit and wires the prototype.
 * Any domain: the model names the steps; this module only shapes and checks them.
 */

export type JourneyStep = { name: string; purpose: string; primaryAction: string; kind: "step" | "success" | "error" };
export type JourneyPlan = { title: string; steps: JourneyStep[] };

const MAX_STEPS = 7;

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const SUCCESS = /\b(success|successful|succeeded|done|complete|completed|thank|receipt|confirmed|confirmation)\b/i;
const ERROR = /\b(fail|failed|failure|error|declined|unsuccessful|rejected|timeout)\b/i;

/** The goal in the person's words: "create a journey to pay overdue EMI" → "Pay overdue EMI". */
export function journeyGoal(prompt: string): string {
  const goal = String(prompt || "")
    .replace(/\b(please|pls|can you|could you|kindly)\b/gi, " ")
    .replace(/\b(create|design|make|build|generate|draft|banao|bana do|bana)\b/gi, " ")
    .replace(/\b(an?|the|new|complete|full|end[- ]to[- ]end|user|multi[- ]?screen)\b/gi, " ")
    .replace(/\b(journey|flow|wizard|screens?)\b/gi, " ")
    .replace(/^\s*(for|to|of|on)\b/i, " ")
    .replace(/\s+(for|to|of)\s+/i, " ")
    .replace(/\s+/g, " ").trim().replace(/^(for|to|of)\s+/i, "");
  const text = goal || "Complete the task";
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 60);
}

/** Shapes a model answer into 3–7 screens with exactly one success end and one failure state. */
export function normalizeJourney(data: unknown, prompt: string): JourneyPlan | null {
  const rec = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const raw = Array.isArray(rec.steps) ? rec.steps : Array.isArray(rec.screens) ? rec.screens : [];
  const seen = new Set<string>();
  const steps: JourneyStep[] = [];
  for (const item of raw) {
    const r: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : { name: item };
    const name = clean(r.name ?? r.title ?? r.screen, 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const kindRaw = clean(r.kind ?? r.type ?? r.state, 20).toLowerCase();
    const kind: JourneyStep["kind"] = /error|fail/.test(kindRaw) || ERROR.test(name) ? "error"
      : /success|end|final|confirm/.test(kindRaw) || SUCCESS.test(name) ? "success" : "step";
    steps.push({ name, purpose: clean(r.purpose ?? r.description ?? r.goal, 200), primaryAction: clean(r.primaryAction ?? r.primary_action ?? r.cta ?? r.action, 24), kind });
  }
  const flow = steps.filter((s) => s.kind === "step");
  if (flow.length < 2) return null;
  const goal = journeyGoal(prompt);
  const success = steps.find((s) => s.kind === "success") ?? { name: goal + " successful", purpose: "Confirms the result and what happens next.", primaryAction: "Done", kind: "success" as const };
  const error = steps.find((s) => s.kind === "error") ?? { name: goal + " failed", purpose: "Says what went wrong and how to fix it, with a way to try again.", primaryAction: "Retry", kind: "error" as const };
  if (!/^(retry|try again)\b/i.test(error.primaryAction)) error.primaryAction = "Retry";
  if (!success.primaryAction) success.primaryAction = "Done";
  for (const step of flow) if (!step.primaryAction) step.primaryAction = "Continue";
  return { title: clean(rec.title, 60) || goal, steps: [...flow.slice(0, MAX_STEPS - 2), success, error] };
}

/** Model-free fallback: a generic task journey that any domain can fill with its own content. */
export function fallbackJourney(prompt: string): JourneyPlan {
  const goal = journeyGoal(prompt);
  return {
    title: goal,
    steps: [
      { name: "Start", purpose: "Where the person begins: the item or account the task is about, with the entry action.", primaryAction: "Continue", kind: "step" },
      { name: "Details", purpose: "The details the person needs to decide.", primaryAction: "Continue", kind: "step" },
      { name: "Enter details", purpose: "The one form or choice the task needs.", primaryAction: "Continue", kind: "step" },
      { name: "Review and confirm", purpose: "A summary of what will happen, with the confirming action.", primaryAction: "Confirm", kind: "step" },
      { name: goal + " successful", purpose: "Confirms the result and what happens next.", primaryAction: "Done", kind: "success" },
      { name: goal + " failed", purpose: "Says what went wrong and how to fix it, with a way to try again.", primaryAction: "Retry", kind: "error" },
    ],
  };
}

export const JOURNEY_SYSTEM = [
  "You are a senior product designer planning a multi-screen user journey for a mobile app.",
  "Break the person's goal into the screens a real product needs, in order: the entry screen, each step (one decision or one form per screen), a success screen, and one failure state.",
  "Use 3 to 5 steps before the success screen. Name each screen after its content in the person's domain and language (e.g. \"Loan details\", \"Choose amount\"), Title case, at most 4 words.",
  "Give each screen its one primary action label (verb first, at most 3 words). The failure screen's primary action is Retry.",
  'Return JSON only: {"title": string, "steps": [{"name": string, "purpose": string, "primaryAction": string, "kind": "step" | "success" | "error"}]}.',
].join("\n");
