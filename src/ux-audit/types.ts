export const AUDIT_CATEGORIES = [
  "CTA-AMBIGUITY",
  "DEAD-END",
  "FAKE-AFFORDANCE",
  "CONTRAST-FAIL",
  "TOUCH-TARGET",
  "JARGON-LEAK",
  "PROGRESS-BLIND",
  "ERROR-VAGUE",
  "FORM-FRICTION",
  "OVERLOAD",
  "PATTERN-DRIFT",
  "TRUST-GAP",
  "DARK-PATTERN",
  "STATE-GAP",
  "HIERARCHY-FLAT",
  "RECALL-TAX",
  "OTHER",
  "POSITIVE"
] as const;

export type AuditCategory = typeof AUDIT_CATEGORIES[number];
export type AuditSeverity = 1 | 2 | 3 | 4;
export type NormalizedRegion = { x: number; y: number; width: number; height: number };

export type AuditScreenshot = {
  /** Public screenshot URL from the existing thum.io / Browserless pipeline or R2. */
  url: string;
  label: string;
  siteName: string;
  pageType?: string;
};

export type AuditFinding = {
  id: string;
  kind: "issue" | "positive";
  category: AuditCategory;
  severity: AuditSeverity | null;
  title: string;
  screenshotIndex: number;
  evidence: string;
  impact: string;
  recommendation: string;
  heuristic: string | null;
  confidence: number;
  region: NormalizedRegion | null;
};

export type BenchmarkComparison = {
  criterion: string;
  siteName: string;
  relativePosition: "stronger" | "at-par" | "weaker" | "not-comparable";
  evidence: string;
  improvementOpportunity: string | null;
};

export type UXAuditReport = {
  product: string;
  journey: string;
  goal: string;
  summary: string;
  findings: AuditFinding[];
  benchmark: BenchmarkComparison[];
  limitations: string[];
};

export const AUDIT_CATEGORY_DESCRIPTIONS: Record<AuditCategory, string> = {
  "CTA-AMBIGUITY": "Competing or unclear primary actions",
  "DEAD-END": "No clear next action or safe exit",
  "FAKE-AFFORDANCE": "Visual affordance conflicts with actual interaction",
  "CONTRAST-FAIL": "Potentially insufficient text or UI contrast",
  "TOUCH-TARGET": "Small or crowded touch targets",
  "JARGON-LEAK": "Unclear, internal, or unnecessarily technical language",
  "PROGRESS-BLIND": "Progress or current step is unclear",
  "ERROR-VAGUE": "Errors lack a clear cause or recovery path",
  "FORM-FRICTION": "Unnecessary, unclear, or error-prone form design",
  "OVERLOAD": "Excessive density or weak progressive disclosure",
  "PATTERN-DRIFT": "Inconsistent patterns across comparable screens",
  "TRUST-GAP": "Insufficient reassurance at money, identity, or data decisions",
  "DARK-PATTERN": "Potentially manipulative or coercive design",
  "STATE-GAP": "A required loading, empty, error, success, or recovery state is not evidenced",
  "HIERARCHY-FLAT": "No clear visual or content priority",
  "RECALL-TAX": "Users must remember information not kept available",
  OTHER: "A substantiated issue outside the named recurring checks",
  POSITIVE: "A specific strength worth preserving or repeating"
};

export const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  4: "Critical",
  3: "Major",
  2: "Minor",
  1: "Cosmetic"
};
