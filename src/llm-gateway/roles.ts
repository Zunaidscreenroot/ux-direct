/**
 * Which free model each agency seat uses, with a deep fallback chain.
 *
 * Agency shape (Zunaid, 2026-11-07): Director → UX Lead → one UX designer + one UI designer, split by
 * task type. The Lead reviews both designers' work and the Director reviews the Lead's final, so
 * Director and Lead get the strongest models on different providers from the designers.
 *
 * Every seat names a primary pool (rotated per call, so parallel designers start on different
 * providers) and an ordered fallback list across other providers. Anything configured but not
 * named still serves as a last resort through the tier ranking. Entries are "provider/regex" and
 * match live-detected model ids, so new names (gemini-3.8-flash, …) slot in without code changes.
 *
 * Provider strengths (free tiers, 2026-11, from live checks and the analytics log):
 *  - Groq gpt-oss-120b: best free reasoning + JSON, very fast; 30 RPM / 1k RPD per model, 7k TPM.
 *  - Gemini flash family: strong, vision, 1M context; each model has its own small daily quota,
 *    so spreading across 3.5/3.6/3.7/3.8/2.5-flash multiplies capacity. Pro: 100/day.
 *  - Workers AI (binding): gpt-oss-120b, nemotron-3-120b, qwq-32b, llama-3.3-70b; no key, neurons/day.
 *  - OpenRouter :free only (paid ids are refused in code): nemotron ultra (strong), nemotron super-vl
 *    (vision), gemma-4; 1000 calls/day for the whole account (it holds credit), 20 RPM per model.
 *  - Mistral free tier: codestral (mistral-code-latest) and ministral 3b/8b/14b; large/medium are paid.
 *  - Z.ai glm-4.5-flash: free but slow; a far fallback.
 */

import type { Tier } from "./catalog";

export type GatewayRole =
  // agency seats
  | "director" | "lead" | "ux-designer" | "ui-designer" | "researcher" | "content-writer"
  | "accessibility" | "design-system" | "qa"
  // utility
  | "classifier" | "chat" | "fast-retry" | "default"
  // older names, kept as aliases
  | "planner" | "section-designer" | "critic" | "reviewer" | "writer";

export type RoleRoute = {
  /** What the seat does (shown in the Models tab and the plan doc). */
  purpose: string;
  tiers: Tier[];
  lowLatency: boolean;
  attemptTimeoutMs: number;
  /** Hops before giving up (each hop prefers a different provider). */
  maxAttempts: number;
  /** Rotated per call so parallel calls of the same seat start on different providers. */
  primary: string[];
  fallback: string[];
};

// Shorthands for model patterns.
const GROQ_120 = "groq/gpt-oss-120b";
const GROQ_20 = "groq/gpt-oss-20b";
const GROQ_QWEN = "groq/qwen";
const GROQ_KIMI = "groq/kimi";
const WAI_120 = "workers-ai/gpt-oss-120b";
const WAI_NEMO = "workers-ai/nemotron";
const WAI_20 = "workers-ai/gpt-oss-20b";
const WAI_QWQ = "workers-ai/qwq|deepseek-r1";
const WAI_LLAMA70 = "workers-ai/llama-3.3-70b";
const WAI_SCOUT = "workers-ai/llama-4-scout";
const GEM_PRO = "gemini/gemini-[\\d.]+-pro";
const GEM_FLASH = "gemini/gemini-[\\d.]+-flash(-preview)?$";
const GEM_LITE = "gemini/flash-lite";
const OR_ULTRA = "openrouter/ultra";
const OR_VL = "openrouter/-vl";
const OR_GEMMA = "openrouter/gemma";
const MI_CODE = "mistral/codestral|mistral-code";
const MI_14 = "mistral/ministral-14b";
const MI_8 = "mistral/ministral-8b";
const MI_3 = "mistral/ministral-3b";
const ZAI = "zai/glm";
const CEREBRAS = "cerebras/gpt-oss-120b|qwen-3-235b";

export const ROLE_ROUTES: Record<Exclude<GatewayRole, "planner" | "section-designer" | "critic" | "reviewer" | "writer">, RoleRoute> = {
  director: {
    purpose: "UX Director: takes the project, sets strategy and the quality bar, gives the final review of the Lead's work.",
    tiers: ["strong", "medium", "fast"], lowLatency: false, attemptTimeoutMs: 90_000, maxAttempts: 7,
    // Strongest free judgement, on providers the designers do not start on.
    primary: [GEM_PRO, OR_ULTRA],
    fallback: [GEM_FLASH, OR_VL, GROQ_KIMI, GROQ_120, CEREBRAS, WAI_120, WAI_NEMO, MI_CODE, ZAI],
  },
  lead: {
    purpose: "UX Lead: breaks the brief into UX and UI tasks, reviews every UX and UI deliverable, sends fixes back, hands the final to the Director.",
    tiers: ["strong", "medium", "fast"], lowLatency: false, attemptTimeoutMs: 80_000, maxAttempts: 7,
    // Reviews designers' work, so it starts on other quotas (Gemini/OpenRouter) than they do (Groq/Workers AI).
    primary: [GEM_FLASH, OR_ULTRA],
    fallback: [GEM_PRO, OR_VL, GROQ_KIMI, GROQ_120, CEREBRAS, WAI_120, WAI_NEMO, MI_CODE, ZAI],
  },
  "ux-designer": {
    purpose: "UX designer: research, synthesis, audit, benchmarking, flows and wireframes.",
    tiers: ["strong", "medium", "fast"], lowLatency: false, attemptTimeoutMs: 60_000, maxAttempts: 7,
    primary: [GROQ_120, WAI_120],
    fallback: [WAI_NEMO, OR_ULTRA, CEREBRAS, MI_CODE, WAI_QWQ, GROQ_QWEN, GEM_FLASH, OR_GEMMA, MI_14, ZAI],
  },
  "ui-designer": {
    purpose: "UI designer: visual design on approved wireframes, components, type, colour, spacing.",
    tiers: ["strong", "medium", "fast"], lowLatency: true, attemptTimeoutMs: 50_000, maxAttempts: 7,
    primary: [WAI_120, GROQ_120, WAI_NEMO],
    fallback: [OR_VL, MI_CODE, CEREBRAS, GROQ_KIMI, GROQ_QWEN, GEM_FLASH, OR_GEMMA, WAI_LLAMA70, MI_14, ZAI],
  },
  researcher: {
    purpose: "Researcher: domain, user and pattern research from the knowledge base; long context.",
    tiers: ["strong", "medium", "fast"], lowLatency: false, attemptTimeoutMs: 70_000, maxAttempts: 6,
    primary: [GEM_FLASH, GEM_PRO],
    fallback: [GROQ_120, WAI_120, WAI_QWQ, CEREBRAS, OR_ULTRA, MI_CODE, ZAI],
  },
  "content-writer": {
    purpose: "UX writer: real, specific copy (labels, microcopy, empty/error states), no lorem or filler.",
    tiers: ["medium", "strong", "fast"], lowLatency: true, attemptTimeoutMs: 40_000, maxAttempts: 6,
    primary: [GROQ_120, WAI_LLAMA70, GROQ_KIMI],
    fallback: [GEM_FLASH, WAI_120, MI_14, GROQ_QWEN, OR_GEMMA, MI_8, ZAI],
  },
  accessibility: {
    purpose: "Accessibility specialist: contrast, target size, labels, focus order (WCAG 2.2 AA).",
    tiers: ["strong", "medium", "fast"], lowLatency: true, attemptTimeoutMs: 45_000, maxAttempts: 6,
    primary: [GROQ_120, WAI_120],
    fallback: [GEM_FLASH, WAI_NEMO, CEREBRAS, MI_CODE, WAI_QWQ, ZAI],
  },
  "design-system": {
    purpose: "Design-system keeper: tokens, component reuse and consistency across screens.",
    tiers: ["strong", "medium", "fast"], lowLatency: true, attemptTimeoutMs: 45_000, maxAttempts: 6,
    primary: [MI_CODE, WAI_120],
    fallback: [GROQ_120, GEM_FLASH, WAI_NEMO, CEREBRAS, GROQ_QWEN, MI_14, ZAI],
  },
  qa: {
    purpose: "QA: final pass for broken structure, missing states and overflow before handing back.",
    tiers: ["fast", "medium", "strong"], lowLatency: true, attemptTimeoutMs: 30_000, maxAttempts: 6,
    primary: [GROQ_20, WAI_20, MI_14],
    fallback: [GEM_LITE, GROQ_QWEN, MI_8, WAI_SCOUT, GROQ_120, ZAI],
  },
  classifier: {
    purpose: "Classifier: routes the request (what kind of task, which seats).",
    tiers: ["fast", "medium", "strong"], lowLatency: true, attemptTimeoutMs: 25_000, maxAttempts: 6,
    primary: [GROQ_20, WAI_20, MI_8],
    fallback: [GEM_LITE, MI_3, WAI_SCOUT, GROQ_QWEN, GROQ_120, ZAI],
  },
  chat: {
    purpose: "Chat replies in the plugin: short and fast.",
    tiers: ["fast", "medium", "strong"], lowLatency: true, attemptTimeoutMs: 25_000, maxAttempts: 6,
    primary: [GROQ_20, WAI_20, WAI_SCOUT],
    fallback: [MI_14, GEM_LITE, GROQ_QWEN, MI_8, GROQ_120, ZAI],
  },
  "fast-retry": {
    purpose: "Quick retry after a slow or failed strong call.",
    tiers: ["fast", "medium", "strong"], lowLatency: true, attemptTimeoutMs: 40_000, maxAttempts: 6,
    primary: [GROQ_20, WAI_20, MI_14],
    fallback: [GEM_LITE, WAI_SCOUT, GROQ_QWEN, MI_8, GROQ_120, ZAI],
  },
  default: {
    purpose: "Anything without a seat.",
    tiers: ["strong", "medium", "fast"], lowLatency: false, attemptTimeoutMs: 75_000, maxAttempts: 6,
    primary: [GROQ_120, WAI_120, GEM_FLASH],
    fallback: [WAI_NEMO, CEREBRAS, MI_CODE, OR_ULTRA, GROQ_QWEN, ZAI],
  },
};

/** Older header values map onto seats. */
export const ROLE_ALIASES: Record<string, keyof typeof ROLE_ROUTES> = {
  planner: "lead",
  "section-designer": "ux-designer",
  // There is no separate reviewer seat: the UX Lead reviews, the Director gives the final review.
  critic: "lead",
  reviewer: "lead",
  writer: "content-writer",
  "ux-director": "director",
  "ux-lead": "lead",
  "copywriter": "content-writer",
  "ux-writer": "content-writer",
  a11y: "accessibility",
};

export type SeatRole = keyof typeof ROLE_ROUTES;

export function seatFor(role: string): SeatRole | null {
  const key = role.trim().toLowerCase();
  if (key in ROLE_ROUTES) return key as SeatRole;
  return ROLE_ALIASES[key] ?? null;
}

function matches(entry: string, provider: string, model: string): boolean {
  const slash = entry.indexOf("/");
  if (entry.slice(0, slash) !== provider) return false;
  try { return new RegExp(entry.slice(slash + 1), "i").test(model); } catch { return false; }
}

const rotation = new Map<string, number>();

/**
 * Preference rank of provider/model for a seat: 0 = top. Primary entries are rotated per call
 * (pass the same `turn` for every candidate of one request). Unlisted models rank after all entries.
 */
export function chainRank(route: RoleRoute, provider: string, model: string, turn: number): number {
  const pool = route.primary.length ? route.primary.map((_, index) => route.primary[(index + turn) % route.primary.length]) : [];
  const chain = [...pool, ...route.fallback];
  const index = chain.findIndex((entry) => matches(entry, provider, model));
  return index >= 0 ? index : chain.length;
}

/** Next rotation index for a seat (per isolate; enough to spread parallel calls). */
export function nextTurn(role: string): number {
  const turn = rotation.get(role) ?? 0;
  rotation.set(role, turn + 1);
  return turn;
}

export function resetRotation() { rotation.clear(); }
