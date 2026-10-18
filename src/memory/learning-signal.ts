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
