/**
 * Content locale for generated sample data (currency, number grouping, date style).
 *
 * Signals, strongest first: the user's prompt, the file's design rules, then the texts already
 * on the canvas (selection or page). Only when none of them names a currency does the team
 * default (India: ₹ with lakh grouping) apply, so a "food delivery" screen for a US file no
 * longer gets rupees and an Indian address (tester, create mode).
 */

export type ContentLocale = { code: string; symbol: string; region: string; grouping: string; date: string; source: "prompt" | "design rules" | "canvas" | "default" };

const LOCALES: Record<string, Omit<ContentLocale, "source">> = {
  INR: { code: "INR", symbol: "₹", region: "India", grouping: "lakh grouping like ₹1,25,000", date: "12 Mar 2026" },
  USD: { code: "USD", symbol: "$", region: "United States", grouping: "thousands grouping like $1,250.00", date: "Mar 12, 2026" },
  EUR: { code: "EUR", symbol: "€", region: "Europe", grouping: "European formatting like €1.250,00 or €1,250.00 matching the file", date: "12 Mar 2026" },
  GBP: { code: "GBP", symbol: "£", region: "United Kingdom", grouping: "thousands grouping like £1,250.00", date: "12 Mar 2026" },
  JPY: { code: "JPY", symbol: "¥", region: "Japan", grouping: "no decimals like ¥12,500", date: "2026/03/12" },
  AED: { code: "AED", symbol: "AED", region: "United Arab Emirates", grouping: "thousands grouping like AED 1,250.00", date: "12 Mar 2026" },
  SGD: { code: "SGD", symbol: "S$", region: "Singapore", grouping: "thousands grouping like S$1,250.00", date: "12 Mar 2026" },
};

const PATTERNS: Array<[string, RegExp]> = [
  ["INR", /₹|\bRs\.?\s?\d|\bINR\b|\brupees?\b|\blakhs?\b|\bcrores?\b|\bindia(n)?\b/gi],
  ["SGD", /\bS\$\s?\d|\bSGD\b|\bsingapore\b/gi],
  ["USD", /(?<![A-Z])\$\s?\d|\bUSD\b|\b[Dd]ollars?\b|\bUSA\b|\bU\.S\.|\b(?:the|a|an|in|for|across)\s+US\b|\b[Uu]nited [Ss]tates\b/g],
  ["EUR", /€|\bEUR\b|\beuros?\b|\beurope(an)?\b|\bgermany\b|\bfrance\b|\bspain\b|\bitaly\b|\bnetherlands\b/gi],
  ["GBP", /£|\bGBP\b|\b[Pp]ounds? sterling\b|\bUK\b|\bU\.K\.|\b[Uu]nited [Kk]ingdom\b|\bLondon\b/g],
  ["JPY", /¥|\bJPY\b|\byen\b|\bjapan(ese)?\b/gi],
  ["AED", /\bAED\b|\bdirhams?\b|\bdubai\b|\bU\.?A\.?E\.?\b/gi],
];

function score(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [code, pattern] of PATTERNS) {
    const hits = text.match(pattern)?.length ?? 0;
    if (hits) counts.set(code, hits);
  }
  return counts;
}

function strongest(text: string): string | null {
  const counts = [...score(text)].sort((a, b) => b[1] - a[1]);
  return counts[0]?.[0] ?? null;
}

/** Every visible text string in a canvas-like JSON tree (selection, page or component catalogue). */
export function canvasTexts(value: unknown, limit = 400): string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (out.length >= limit || depth > 16 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const rec = node as Record<string, unknown>;
    if (rec.visible === false) return;
    if (typeof rec.text === "string" && rec.text.trim()) out.push(rec.text.trim().slice(0, 200));
    for (const key of ["nodes", "children", "pageTexts", "texts"]) if (key in rec) walk(rec[key], depth + 1);
  };
  walk(value, 0);
  return out;
}

export function inferContentLocale(input: { prompt?: string; designRules?: string; texts?: string[] }): ContentLocale {
  const fromPrompt = strongest(input.prompt || "");
  if (fromPrompt) return { ...LOCALES[fromPrompt], source: "prompt" };
  const fromRules = strongest(input.designRules || "");
  if (fromRules) return { ...LOCALES[fromRules], source: "design rules" };
  const fromCanvas = strongest((input.texts || []).join("\n"));
  if (fromCanvas) return { ...LOCALES[fromCanvas], source: "canvas" };
  return { ...LOCALES.INR, source: "default" };
}

/** One prompt line telling the model which currency, number and date style to use for sample data. */
export function contentLocaleInstruction(locale: ContentLocale): string {
  const why = locale.source === "default"
    ? "No currency or region is named in the request, the file's design rules or the canvas, so use the team default"
    : "Taken from the " + locale.source;
  return "CONTENT LOCALE: " + why + ": amounts in " + locale.code + " (" + locale.symbol + ", " + locale.grouping + "), dates like " + locale.date +
    ", and names, addresses and phone formats that fit " + locale.region + ". Only show money where the product needs it; never mix currencies.";
}
