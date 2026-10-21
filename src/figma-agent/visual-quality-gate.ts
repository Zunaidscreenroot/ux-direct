export type VisualQualityFinding = {
  severity: "high" | "medium" | "low";
};

export type VisualQualityGateResult = {
  passed: boolean;
  minimumScore: 90;
  visualInspection: boolean;
  unresolvedHighSeverity: boolean;
  issueCount: number;
  message: string;
};

/**
 * Keep the server-side acceptance rule deterministic. A model score alone is
 * insufficient: both rendered images must be inspected and no issues may remain.
 */
export function evaluateVisualQualityGate(input: {
  score: number;
  issues: VisualQualityFinding[];
  hasSourceImage: boolean;
  hasOutputImage: boolean;
}): VisualQualityGateResult {
  const visualInspection = input.hasSourceImage && input.hasOutputImage;
  const unresolvedHighSeverity = input.issues.some(issue => issue.severity === "high");
  const passed = Number.isFinite(input.score) &&
    input.score >= 90 &&
    visualInspection &&
    !unresolvedHighSeverity &&
    input.issues.length === 0;

  return {
    passed,
    minimumScore: 90,
    visualInspection,
    unresolvedHighSeverity,
    issueCount: input.issues.length,
    message: passed
      ? "Visual QA passed."
      : !visualInspection
        ? "Visual QA cannot pass without both source and output screenshots."
        : "Visual QA found issues. The bounded plugin repair loop may attempt a correction; completion remains blocked until final verification.",
  };
}
