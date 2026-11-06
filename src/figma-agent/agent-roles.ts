/**
 * Role switcher + domain detector for UX Direct's Figma pipeline.
 *
 * Both are deterministic: the same prompt and source layers always give the same role and
 * domain, whichever model FreeLLMAPI `auto` picks. The sub-agents (src/figma-agent/sub-agents.ts)
 * may refine the domain, but these functions are the fallback and the first hint.
 */

export type TaskRoleId = "wireframe" | "variation" | "restyle" | "content" | "improve";

export interface TaskRole {
  id: TaskRoleId;
  label: string;
  /** How the planner should think for this task. */
  persona: string;
  rules: string[];
}

const ROLES: Record<TaskRoleId, TaskRole> = {
  wireframe: {
    id: "wireframe",
    label: "Wireframe designer",
    persona: "Think like a UX architect drawing a mid-fidelity wireframe: structure, hierarchy and flow first, visual polish last.",
    rules: [
      "Keep every real label, value and action from the source; a wireframe changes styling, never content.",
      "Use a neutral greyscale theme with one accent for the primary action; no gradients, shadows, illustrations or decorative colour.",
      "Show image or chart areas as plain labelled placeholders; do not invent imagery.",
    ],
  },
  variation: {
    id: "variation",
    label: "Variation explorer",
    persona: "Think like a senior product designer exploring a genuinely different layout for the same content and goal.",
    rules: [
      "Change the arrangement, grouping or emphasis in a way a designer can name (for example summary-first, list-first, card-split); a recolour alone is not a variation.",
      "Keep the same content, product identity, brand colours and primary action.",
    ],
  },
  restyle: {
    id: "restyle",
    label: "Visual stylist",
    persona: "Think like a visual designer applying the requested look while keeping structure and content intact.",
    rules: [
      "Apply only the visual change the user asked for (theme, colour, mode, brand); keep the layout, content and hierarchy.",
      "Keep text contrast at WCAG AA or better on every surface.",
    ],
  },
  content: {
    id: "content",
    label: "UX writer",
    persona: "Think like a UX writer: clear, specific, short product language in the user's domain.",
    rules: [
      "Change only the copy the user asked about; keep numbers, amounts, dates and names exactly.",
      "Use plain action verbs on buttons; no marketing filler.",
    ],
  },
  improve: {
    id: "improve",
    label: "Senior product designer",
    persona: "Think like a senior product designer improving a real production screen: fix hierarchy, grouping, spacing and action priority without changing what the screen is for.",
    rules: [
      "Name the concrete problems you fix (hierarchy, grouping, alignment, contrast, action priority) and fix only those.",
      "Keep the screen recognisable to its users: same content, same flow, same brand.",
    ],
  },
};

const ROLE_PATTERNS: Array<[TaskRoleId, RegExp]> = [
  ["wireframe", /\b(wire\s*-?\s*frames?|lo-?fi|low[\s-]?fi(delity)?|mid[\s-]?fi(delity)?|grey\s*box|gray\s*box|skeleton|blueprint)\b|वायरफ्रेम/iu],
  ["variation", /\b(variations?|variants?|alternatives?|alternate|another (version|layout|option)|explore|options?|versions?|different layout)\b|वेरिएशन/iu],
  ["restyle", /\b(colou?rs?|theme|palette|dark\s*mode|light\s*mode|brand(ing)?|restyle|re-?skin|gradient)\b|रंग|कलर|थीम|डार्क/iu],
  ["content", /\b(copy|microcopy|rewrite|reword|wording|translate|headline|tone)\b/iu],
];

export function detectTaskRole(prompt: string): TaskRole {
  for (const [id, pattern] of ROLE_PATTERNS) if (pattern.test(prompt)) return ROLES[id];
  return ROLES.improve;
}

export function taskRoleById(id: string): TaskRole | null {
  return (ROLES as Record<string, TaskRole>)[id] ?? null;
}

export type DomainId = "fintech" | "insurance" | "healthcare" | "ecommerce" | "edtech" | "travel" | "food" | "saas" | "social" | "general";

export interface DomainProfile {
  id: DomainId;
  label: string;
  rules: string[];
}

const DOMAINS: Record<DomainId, DomainProfile> = {
  fintech: {
    id: "fintech",
    label: "Fintech / banking / lending",
    rules: [
      "Amounts, due dates and status are the hierarchy: the most important amount is the largest text, with its date and status next to it.",
      "Show fees, charges and outcomes transparently before the user commits; destructive or money-moving actions need clear labels.",
      "Never invent interest rates, limits, charges, account numbers or regulatory claims; keep source values or mark illustrative ones as sample.",
    ],
  },
  insurance: {
    id: "insurance",
    label: "Insurance",
    rules: [
      "Policy status, sum insured, premium and renewal date lead the hierarchy.",
      "Never invent coverage terms, claim amounts or exclusions; keep source values.",
    ],
  },
  healthcare: {
    id: "healthcare",
    label: "Healthcare",
    rules: [
      "Prioritise clarity and calm: appointment, doctor, time and next step first.",
      "Never invent diagnoses, dosages, test values or medical advice.",
    ],
  },
  ecommerce: {
    id: "ecommerce",
    label: "E-commerce / retail",
    rules: [
      "Price, product identity, availability and the buy action lead; keep source prices and discounts exactly.",
      "Do not invent ratings, review counts, stock levels or delivery promises.",
    ],
  },
  edtech: {
    id: "edtech",
    label: "Education",
    rules: ["Progress, next lesson and deadlines lead; keep course names, scores and dates exactly."],
  },
  travel: {
    id: "travel",
    label: "Travel / mobility",
    rules: ["Route, date/time, price and booking status lead; do not invent fares, timings or seat counts."],
  },
  food: {
    id: "food",
    label: "Food / delivery",
    rules: ["Item, price, delivery time and order status lead; do not invent prices, offers or ETAs."],
  },
  saas: {
    id: "saas",
    label: "SaaS / dashboard / productivity",
    rules: [
      "Lead with the one metric or task the screen exists for; group related metrics and keep their units and periods.",
      "Do not add stat cards, charts or KPIs the source does not have.",
    ],
  },
  social: {
    id: "social",
    label: "Social / communication",
    rules: ["People, messages and timestamps lead; keep names and content exactly."],
  },
  general: {
    id: "general",
    label: "General product",
    rules: [],
  },
};

const DOMAIN_KEYWORDS: Record<Exclude<DomainId, "general">, RegExp> = {
  fintech: /\b(loans?|emi|upi|kyc|balance|bank(ing)?|account|credit|debit|card|payments?|pay|wallet|transactions?|transfer|interest|invest(ment)?s?|mutual funds?|sip|stocks?|portfolio|repay(ment)?|outstanding|due|principal|tenure|ifsc|nbfc|fintech|bfsi|cibil|limit)\b|₹|rs\.?\s?\d/giu,
  insurance: /\b(insurance|policy|premium|claims?|sum insured|cover(age)?|nominee|renewal|insurer)\b/giu,
  healthcare: /\b(doctor|patient|appointment|clinic|hospital|health|medic(al|ine)|prescription|lab test|symptoms?|pharmacy|consult(ation)?)\b/giu,
  ecommerce: /\b(cart|checkout|add to bag|product|price|order|shop|store|sale|discount|wishlist|sku|delivery|shipping|buy now)\b/giu,
  edtech: /\b(course|lesson|class|student|teacher|quiz|exam|learn(ing)?|module|grade|assignment|syllabus)\b/giu,
  travel: /\b(flight|hotel|booking|trip|travel|itinerary|boarding|check-?in|train|bus|cab|ride|destination|passenger)\b/giu,
  food: /\b(restaurant|menu|dish|food|meal|recipe|delivery partner|order food|cuisine|dine)\b/giu,
  saas: /\b(dashboard|analytics|workspace|team|project|tasks?|reports?|metrics?|kpis?|admin|settings|users|subscription|plan|billing)\b/giu,
  social: /\b(chat|messages?|followers?|friends?|post|feed|likes?|comments?|profile|stories|inbox)\b/giu,
};

export interface DomainDetection {
  domain: DomainProfile;
  /** Keyword hits for the winning domain; 0 means "general". */
  score: number;
  scores: Partial<Record<DomainId, number>>;
}

/** Keyword-scored domain from the prompt plus the source's own text. Deterministic. */
export function detectDomain(prompt: string, sourceTexts: string[]): DomainDetection {
  const corpus = (prompt + "\n" + sourceTexts.join("\n")).slice(0, 20000);
  const scores: Partial<Record<DomainId, number>> = {};
  let best: DomainId = "general";
  let bestScore = 0;
  for (const [id, pattern] of Object.entries(DOMAIN_KEYWORDS) as Array<[Exclude<DomainId, "general">, RegExp]>) {
    const hits = corpus.match(pattern)?.length ?? 0;
    if (hits) scores[id] = hits;
    if (hits > bestScore) { best = id; bestScore = hits; }
  }
  // A single stray keyword ("settings", "card") is not a domain.
  if (bestScore < 2) return { domain: DOMAINS.general, score: 0, scores };
  return { domain: DOMAINS[best], score: bestScore, scores };
}

export function domainById(id: string): DomainProfile | null {
  const key = id.trim().toLowerCase();
  if ((DOMAINS as Record<string, DomainProfile>)[key]) return (DOMAINS as Record<string, DomainProfile>)[key];
  if (/bank|financ|lend|loan|pay|bfsi|wealth|invest/.test(key)) return DOMAINS.fintech;
  if (/insur/.test(key)) return DOMAINS.insurance;
  if (/health|medic|pharma|clinic/.test(key)) return DOMAINS.healthcare;
  if (/commerce|retail|shop/.test(key)) return DOMAINS.ecommerce;
  if (/edu|learn/.test(key)) return DOMAINS.edtech;
  if (/travel|mobility|hotel|flight/.test(key)) return DOMAINS.travel;
  if (/food|restaurant|deliver/.test(key)) return DOMAINS.food;
  if (/saas|dashboard|productiv|b2b|analytic/.test(key)) return DOMAINS.saas;
  if (/social|chat|messag|communit/.test(key)) return DOMAINS.social;
  return null;
}

/** Role + domain instructions for the planner's system prompt. */
export function roleInstructions(role: TaskRole, domain: DomainProfile): string {
  const lines = [
    "ROLE FOR THIS TASK: " + role.label + ". " + role.persona,
    ...role.rules.map((rule) => "- " + rule),
  ];
  if (domain.id !== "general") {
    lines.push("PRODUCT DOMAIN: " + domain.label + ".", ...domain.rules.map((rule) => "- " + rule));
  }
  return lines.join("\n");
}
