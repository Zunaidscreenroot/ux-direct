import type { TaskProject } from "@/src/core/types";

const CORRECTION_SIGNAL = [
  /\bremember (this|that|it|this rule)\b/i,
  /\blearn from this\b/i,
  /\btrain (ux direct|the product|yourself|this|the system)\b/i,
  /\b(save|store) this (as a rule|for future|as learning)\b/i,
  /\b(don't|do not) repeat (this|that|this mistake)\b/i,
  /\byou (got|did|made|missed|ignored) .{0,80}\b(wrong|incorrect|mistake|missed)\b/i,
  /\b(you should have|should have done|not what i asked|that's not right|this is wrong|that was wrong|incorrect output|missed the point)\b/i,
  /\b(aisa|aesa|aise) (hona|karna) chahiye tha\b/i,
  /\b(galat|galti|ghalat) (tha|thi|hai|ki|kardi|kar diya|kar di)\b/i,
  /\b(yaad rakhna|yaad rakho|seekh lo|is se seekho|aage se|aglay? baar|agli baar|dobara mat|future mein|future me|hamesha aisa)\b/i,
];

const EXPLICIT_REUSE_INTENT = [
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
    if (requested === "indian-bfsi" || (containsIndianBfsi && /\b(bfsi|banking|finance|insurance|rbi|loan|lending)\b/i.test(originalFeedback))) return "indian-bfsi";
    return ALLOWED_SCOPE_KEYS.has(requested) ? requested : "UX_SHARED_BRAIN";
  }
  if (project === "dmi-finance") return "project:dmi-finance";
  if (project === "express-computers") return "project:express-computers";
  return "project:general-ux";
}
