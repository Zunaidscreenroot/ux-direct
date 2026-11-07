import { CORE_KNOWLEDGE } from "./corpus";
import { CATEGORY_LABELS, KNOWLEDGE_DOMAINS, type KnowledgeDomain, type KnowledgeEntry, type KnowledgeRole } from "./types";

/**
 * Deterministic retrieval over the knowledge base (core corpus + owner-added entries).
 * BM25 over title/tags/body, plus tag-phrase matches, role fit and domain fit.
 * Same input → same output, whichever model runs the task.
 */

const STOPWORDS = new Set(("a an and are as at be but by can do does for from has have how i if in into is it its " +
  "me my of on or our so that the their them then there these this to us was we what when where which who why will with " +
  "you your make please karo kar do ko ka ki ke hai ye yeh is ek aur mein me se").split(" "));

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && token.endsWith("es") && /(ss|x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}₹]+/gu) || [])
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/** Map any agency seat or task-role name onto a knowledge role. */
export function normalizeRole(name: string | undefined | null): KnowledgeRole | null {
  const key = String(name || "").toLowerCase();
  if (!key) return null;
  const table: Array<[RegExp, KnowledgeRole]> = [
    [/director|head of design|creative/, "director"],
    [/review|critic|crit\b/, "reviewer"],
    [/\bqa\b|quality|lint|hygiene/, "qa"],
    [/\blead\b|lead|principal|manager|improve/, "lead"],
    [/research|insight/, "researcher"],
    [/access|a11y/, "accessibility"],
    [/writ|copy|content|microcopy|translat/, "writer"],
    [/design.?system|token|component|consisten|style.?lock/, "design-system"],
    [/data|chart|viz|dashboard/, "dataviz"],
    [/motion|anim/, "motion"],
    [/interaction|prototype|flow/, "interaction"],
    [/strateg|product|business/, "strategist"],
    [/\bui\b|visual|styl|theme|colou?r|restyle|variation/, "ui-designer"],
    [/\bux\b|wireframe|architect|layout|designer|section/, "ux-designer"],
  ];
  for (const [pattern, role] of table) if (pattern.test(key)) return role;
  return null;
}

export function normalizeDomain(name: string | undefined | null): KnowledgeDomain | null {
  const key = String(name || "").toLowerCase().trim();
  if (!key) return null;
  if ((KNOWLEDGE_DOMAINS as string[]).includes(key)) return key as KnowledgeDomain;
  if (/bank|financ|lend|loan|pay|bfsi|wealth|invest|fintech|credit/.test(key)) return "fintech";
  if (/insur/.test(key)) return "insurance";
  if (/health|medic|pharma|clinic/.test(key)) return "healthcare";
  if (/commerce|retail|shop/.test(key)) return "ecommerce";
  if (/edu|learn/.test(key)) return "edtech";
  if (/travel|mobility|hotel|flight/.test(key)) return "travel";
  if (/food|restaurant|deliver|grocery/.test(key)) return "food";
  if (/saas|dashboard|productiv|b2b|analytic|admin|enterprise/.test(key)) return "saas";
  if (/social|chat|messag|communit/.test(key)) return "social";
  if (/gov|public|citizen/.test(key)) return "government";
  return null;
}

type Indexed = { entry: KnowledgeEntry; tf: Map<string, number>; length: number; phrases: string[] };

const indexCache = new WeakMap<KnowledgeEntry[], { docs: Indexed[]; df: Map<string, number>; avgLength: number }>();

function buildIndex(entries: KnowledgeEntry[]) {
  const cached = indexCache.get(entries);
  if (cached) return cached;
  const df = new Map<string, number>();
  const docs: Indexed[] = entries.map((entry) => {
    const tf = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const token of tokenize(text)) tf.set(token, (tf.get(token) || 0) + weight);
    };
    add(entry.title, 3);
    add(entry.tags.join(" "), 2);
    add(CATEGORY_LABELS[entry.category] || entry.category, 1);
    add(entry.body, 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    const length = [...tf.values()].reduce((sum, value) => sum + value, 0);
    const phrases = entry.tags.map((tag) => tag.toLowerCase()).filter((tag) => tag.length >= 3);
    return { entry, tf, length, phrases };
  });
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const index = { docs, df, avgLength };
  indexCache.set(entries, index);
  return index;
}

export type ScoredEntry = { entry: KnowledgeEntry; score: number };

export type KnowledgeQuery = {
  query: string;
  role?: string | null;
  domain?: string | null;
  limit?: number;
  /** Include pinned entries (identity, grounding, anti-slop) first. Default true. */
  includePinned?: boolean;
  /** Pinned ids to skip, e.g. identity entries on design-only calls. */
  skipIds?: string[];
};

/** Rank entries for a task. Returns best first; pinned entries come first when requested. */
export function rankKnowledge(entries: KnowledgeEntry[], input: KnowledgeQuery): ScoredEntry[] {
  const { docs, df, avgLength } = buildIndex(entries);
  const role = normalizeRole(input.role);
  const domain = normalizeDomain(input.domain);
  const queryText = String(input.query || "").toLowerCase().slice(0, 6000);
  const queryTokens = [...new Set(tokenize(queryText))];
  const skip = new Set(input.skipIds || []);
  const total = docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored: ScoredEntry[] = [];
  for (const doc of docs) {
    const { entry } = doc;
    if (skip.has(entry.id)) continue;
    let score = 0;
    for (const token of queryTokens) {
      const freq = doc.tf.get(token);
      if (!freq) continue;
      const n = df.get(token) || 0;
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc.length) / avgLength)));
    }
    for (const phrase of doc.phrases) {
      if (phrase.includes(" ") ? queryText.includes(phrase) : new RegExp("(^|[^\\p{L}\\p{N}])" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\p{L}\\p{N}])", "u").test(queryText)) score += 2.5;
    }
    // Role fit.
    const forAll = entry.roles.includes("all");
    if (role) {
      if (entry.roles.includes(role)) score = score * 1.35 + 1.2;
      else if (!forAll) score *= 0.55;
    }
    // Domain fit: domain entries are strong when the domain matches, weak otherwise.
    if (entry.domains?.length) {
      if (domain && entry.domains.includes(domain)) score = score * 1.5 + 3;
      else score *= domain ? 0.25 : 0.5;
    }
    if (score > 0.01) scored.push({ entry, score });
  }
  scored.sort((a, b2) => b2.score - a.score || a.entry.id.localeCompare(b2.entry.id));
  // Drop the weak tail: a stray shared word is not relevance.
  const floor = Math.max(1, (scored[0]?.score || 0) * 0.2);
  scored.splice(0, scored.length, ...scored.filter((item) => item.score >= floor));
  const limit = Math.max(1, Math.min(40, Math.floor(input.limit ?? 8)));
  if (input.includePinned === false) return scored.filter((item) => !item.entry.pinned).slice(0, limit);
  const top = scored.slice(0, limit);
  const pinned = entries.filter((entry) => entry.pinned && !skip.has(entry.id) && (!role || entry.roles.includes("all") || entry.roles.includes(role)));
  const pinnedIds = new Set(pinned.map((entry) => entry.id));
  return [...pinned.map((entry) => ({ entry, score: Infinity })), ...top.filter((item) => !pinnedIds.has(item.entry.id))];
}

export function formatKnowledgeEntry(entry: KnowledgeEntry, maxBody = 1200): string {
  const label = CATEGORY_LABELS[entry.category] || entry.category;
  return `[UX knowledge · ${label}] ${entry.title}\n${entry.body.replace(/\s+/g, " ").slice(0, maxBody)}`;
}

export type KnowledgePack = { text: string; ids: string[]; chars: number };

/** Ranked entries packed into a character budget. */
export function packKnowledge(ranked: ScoredEntry[], maxChars: number): KnowledgePack {
  let text = "";
  const ids: string[] = [];
  for (const { entry } of ranked) {
    const section = formatKnowledgeEntry(entry);
    const next = text ? text + "\n\n" + section : section;
    if (next.length > maxChars) continue; // try smaller entries further down
    text = next;
    ids.push(entry.id);
  }
  return { text, ids, chars: text.length };
}

/** Core-only retrieval (no database). Callers that can reach Neon use `retrieveKnowledge` in store.ts. */
export function retrieveCoreKnowledge(input: KnowledgeQuery & { maxChars?: number }): KnowledgePack {
  return packKnowledge(rankKnowledge(CORE_KNOWLEDGE, input), Math.max(400, Math.floor(input.maxChars ?? 4000)));
}
