import type { TaskProject } from "@/src/core/types";

const CORRECTION_SIGNAL = [
  /\b(shared brain|brain|memory|knowledge base)\b.{0,35}\b(train|learn|remember|save|capture)\b/i,
  /\b(chat|conversation|messages?)\b.{0,45}\b(brain|memory|knowledge base)\b.{0,30}\b(train|learn|remember|save)\b/i,
  /\bremember (this|that|it|this rule)\b/i,
  /\blearn from this\b/i,
  /\btrain (ux direct|the product|yourself|this|the system)\b/i,
  /\b(save|store) this (as a rule|for future|as learning)\b/i,
  /\b(don't|do not) repeat (this|that|this mistake)\b/i,
  /\byou (got|did|made|missed|ignored) .{0,80}\b(wrong|incorrect|mistake|missed)\b/i,
  /\b(you should have|should have done|not what i asked|that\'s not right|this is wrong|this was wrong|that was wrong|that should have been|no,? i meant|i asked .{0,100} but|i said .{0,100} but|instead you|you missed|not like this|that is not how|incorrect output|missed the point)\b/i,
  /\b(aisa|aesa|aise) (hona|karna) chahiye tha\b/i,
  /\b(galat|galti|ghalat) (tha|thi|hai|ki|kardi|kar diya|kar di)\b/i,
  /\b(yaad rakhna|yaad rakho|seekh lo|is se seekho|aage se|aglay? baar|agli baar|dobara mat|future mein|future me|hamesha aisa)\b/i,
];

const EXPLICIT_REUSE_INTENT = [
  /\b(shared brain|brain|memory|knowledge base)\b.{0,35}\b(train|learn|remember|save|capture)\b/i,
  /\b(chat|conversation|messages?)\b.{0,45}\b(brain|memory|knowledge base)\b.{0,30}\b(train|learn|remember|save)\b/i,
  /\bremember (this|that|it|this rule) (for|in) future\b/i,
  /\b(learn from this|train (ux direct|the product|yourself|this|the system)|save this as a rule|store this as learning)\b/i,
  /\b(for all products|across (all )?products|global rule|every audit|all future tasks|future bfs(i|fi)? audits|future banking audits)\b/i,
  /\b(don't|do not) repeat (this|that|this mistake)\b/i,
  /\b(yaad rakhna|yaad rakho|aage se|aglay? baar|agli baar|future mein|future me|hamesha aisa)\b/i,
];

const EXPLICIT_GLOBAL_SCOPE = [
  /\b(all products|across (all )?products|global rule|every product|all future tasks|every audit)\b/i,
  /\b(future (indian )?(bfsi|banking|finance|insurance) audits|all (indian )?(bfsi|banking|finance|insurance) products)\b/i,
  /\b(share this across products|make this a shared rule|global shared brain)\b/i,
];

const ALLOWED_SCOPE_KEYS = new Set([
  "UX_SHARED_BRAIN","indian-bfsi","project:ux-direct","project:ux-audit",
  "project:general-ux","project:dmi-finance","project:ujjivan-sfb","project:express-computers",
]);

type RelevanceSignal = { label: string; pattern: RegExp };

const GENERAL_RELEVANCE_SIGNALS: RelevanceSignal[] = [
  { label: "ux-design", pattern: /\b(ux|user experience|design(?:ed|ing)?|usability)\b/i },
  { label: "interface", pattern: /\b(ui|interface|screen|wireframe|prototype|canvas|frame)\b/i },
  { label: "interaction", pattern: /\b(interaction|action|behavior|behaviour|flow|journey|workflow)\b/i },
  { label: "visual-system", pattern: /\b(layout|spacing|alignment|typography|hierarchy|visual|component|design system)\b/i },
  { label: "accessibility", pattern: /\b(accessibility|accessible|wcag|a11y|keyboard|screen reader|contrast)\b/i },
  { label: "content-and-clarity", pattern: /\b(copy|microcopy|label|content|clarity|clear|disclosure|transparency|consent|customer control)\b/i },
  { label: "task-quality", pattern: /\b(task|requirement|feedback|error|retry|state|recommendation|finding|evidence|quality|correct|wrong|missed|mistake|rule|guidance|output)\b/i },
  { label: "learning-and-tools", pattern: /\b(figma|plugin|agent|mcp|memory|knowledge|retrieval|learning|token|model|iteration|execution|benchmark|audit)\b/i },
  { label: "product-and-users", pattern: /\b(product|service|customer|user|persona|form|navigation|cta|button|component)\b/i },
];

const SCOPE_RELEVANCE_SIGNALS: Record<string, RelevanceSignal[]> = {
  "indian-bfsi": [
    { label: "banking", pattern: /\b(bank|banking|sfb|financial services|finance|nbfc)\b/i },
    { label: "lending", pattern: /\b(loan|lending|emi|repayment|interest|credit bureau|eligibility)\b/i },
    { label: "identity-and-consent", pattern: /\b(kyc|vkyc|pan|otp|consent|credit|privacy)\b/i },
    { label: "accounts-and-products", pattern: /\b(account|deposit|savings|upi|card|insurance|wealth|fees|charges|rbi|irdai)\b/i },
  ],
  "project:ux-direct": [
    { label: "figma-execution", pattern: /\b(figma|plugin|canvas|node|selection|frame)\b/i },
    { label: "agent-workflow", pattern: /\b(agent|task|command|execution|iteration|workflow|orchestration)\b/i },
    { label: "brain-and-retrieval", pattern: /\b(memory|knowledge base|retrieval|learning|context|token|model)\b/i },
    { label: "product-design", pattern: /\b(design|screen|interface|component|prototype|quality|review)\b/i },
  ],
  "project:ux-audit": [
    { label: "audit-evidence", pattern: /\b(audit|finding|evidence|severity|recommendation)\b/i },
    { label: "ia-and-journey", pattern: /\b(ia|information architecture|navigation|journey|workflow)\b/i },
    { label: "benchmarking", pattern: /\b(benchmark|competitor|comparison|pattern|reference)\b/i },
    { label: "visual-validation", pattern: /\b(screenshot|viewport|accessibility|usability|responsive)\b/i },
  ],
  "project:general-ux": [
    { label: "user-centered-design", pattern: /\b(user|persona|task|usability|research|journey)\b/i },
    { label: "interface-design", pattern: /\b(interface|screen|layout|component|prototype|wireframe)\b/i },
    { label: "interaction-design", pattern: /\b(interaction|flow|state|feedback|error|recovery)\b/i },
    { label: "quality", pattern: /\b(accessibility|consistency|hierarchy|clarity|recommendation)\b/i },
  ],
  "project:dmi-finance": [
    { label: "dmi-context", pattern: /\b(dmi|hfc|housing finance|dmi wealth)\b/i },
    { label: "lending-journey", pattern: /\b(loan|lending|emi|repayment|eligibility|application)\b/i },
    { label: "identity-and-consent", pattern: /\b(kyc|vkyc|pan|otp|consent|credit bureau)\b/i },
    { label: "finance-products", pattern: /\b(finance|wealth|housing|credit|whitelisting|payment)\b/i },
  ],
  "project:ujjivan-sfb": [
    { label: "ujjivan-context", pattern: /\b(ujjivan|sfb|small finance bank)\b/i },
    { label: "banking-products", pattern: /\b(bank|banking|savings|deposit|loan|card|account|branch)\b/i },
    { label: "website-navigation", pattern: /\b(website|homepage|navigation|menu|cta|product catalog)\b/i },
    { label: "digital-journey", pattern: /\b(digital banking|mobile banking|customer|application|onboarding)\b/i },
  ],
  "project:express-computers": [
    { label: "business-context", pattern: /\b(express computers|computer|laptop|desktop|hardware|monitor)\b/i },
    { label: "catalog-and-product", pattern: /\b(product page|catalog|specification|inventory|batch|device)\b/i },
    { label: "purchase-journey", pattern: /\b(purchase|quote|cart|checkout|warranty|support)\b/i },
    { label: "interface-design", pattern: /\b(interface|screen|layout|component|navigation|filter)\b/i },
  ],
};

export type BrainRelevanceAssessment = {
  score: number;
  threshold: 0.5;
  eligible: boolean;
  method: "scope-keyword-v1";
  generalSignals: string[];
  scopeSignals: string[];
};

/**
 * Deterministic, zero-model-call eligibility score for auto-ingestion.
 * For shared/global material, at least two distinct UX/product signals are required.
 * For explicitly scoped material, the selected scope counts as one scope signal;
 * one UX/product signal plus that scope is 50% eligible, while topic matches increase confidence.
 */
export function assessBrainRelevance(title: string, content: string, scopeKey: string): BrainRelevanceAssessment {
  const text = (String(title || "") + "\n" + String(content || "")).normalize("NFKC");
  const scope = scopeKey === "UX_SHARED_BRAIN" ? scopeKey : String(scopeKey || "").toLowerCase();
  const generalSignals = GENERAL_RELEVANCE_SIGNALS.filter(signal => signal.pattern.test(text)).map(signal => signal.label);
  const scopeSignals = (SCOPE_RELEVANCE_SIGNALS[scope] || []).filter(signal => signal.pattern.test(text)).map(signal => signal.label);
  const scopedSignalCount = scope === "UX_SHARED_BRAIN" ? scopeSignals.length : Math.max(1, scopeSignals.length);
  const score = scope === "UX_SHARED_BRAIN"
    ? Math.min(1, generalSignals.length / 4)
    : Math.min(1, Math.min(2, generalSignals.length) * 0.25 + Math.min(2, scopedSignalCount) * 0.25);
  const roundedScore = Math.round(score * 100) / 100;
  return {
    score: roundedScore,
    threshold: 0.5,
    eligible: roundedScore >= 0.5,
    method: "scope-keyword-v1",
    generalSignals,
    scopeSignals,
  };
}

export function detectCoachingSignal(text: string): boolean {
  const value = text.trim();
  return value.length >= 5 && CORRECTION_SIGNAL.some(pattern => pattern.test(value));
}

export function detectExplicitTrainingIntent(text: string): boolean {
  return EXPLICIT_REUSE_INTENT.some(pattern => pattern.test(text));
}

export function resolveLearningScope(candidateScope: unknown, project: TaskProject, originalFeedback: string): string {
  const requested = typeof candidateScope === "string" ? candidateScope : "";
  const isExplicitGlobal = EXPLICIT_GLOBAL_SCOPE.some(pattern => pattern.test(originalFeedback));
  const containsIndianBfsi = /\b(indian|india|bfsi|banking|finance|financial|insurance|nbfc|rbi|loan|lending)\b/i.test(originalFeedback);
  if (isExplicitGlobal) {
    if (containsIndianBfsi && /\b(bfsi|banking|finance|insurance|rbi|loan|lending)\b/i.test(originalFeedback)) return "indian-bfsi";
    return "UX_SHARED_BRAIN";
  }
  if (project === "dmi-finance") return "project:dmi-finance";
  if (project === "express-computers") return "project:express-computers";
  return "project:general-ux";
}


/** Select a conservative scope for chat-originated coaching; client rules never become global by default. */
export function resolveChatLearningScope(text: string): string {
  const value = text.toLowerCase();
  if (/\b(ujjivan|ujjivan sfb|ujjivan small finance bank)\b/.test(value)) return "project:ujjivan-sfb";
  if (/\b(dmi|dmi hfc|dmi finance|dmi wealth|housing finance)\b/.test(value)) return "project:dmi-finance";
  if (/\b(ux audit|uxaudit|audit findings|audit workflow|benchmarking)\b/.test(value)) return "project:ux-audit";
  if (/\b(indian bfs(i|fi)|banking|financial services|insurance|rbi|nbfc|credit bureau)\b/.test(value)) return "indian-bfsi";
  if (/\b(shared brain|cross[- ]product|across products|global memory|chat.{0,20}brain|brain.{0,20}chat)\b/.test(value)) return "UX_SHARED_BRAIN";
  return "project:ux-direct";
}
