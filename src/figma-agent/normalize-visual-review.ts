type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(source: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  }
  return null;
}

function severity(value: unknown): "high" | "medium" | "low" {
  const level = String(value ?? "medium").trim().toLowerCase();
  if (/critical|blocker|urgent|high|major|p0|p1/.test(level)) return "high";
  if (/low|minor|suggestion|nit|p3|p4/.test(level)) return "low";
  return "medium";
}

function issueRecord(value: unknown): JsonRecord | null {
  if (typeof value === "string" && value.trim()) {
    const text = value.trim().slice(0, 240);
    return {
      severity: "medium",
      issue: text,
      evidence: "The reviewer listed this issue without separate evidence.",
      fix: "Inspect the affected component and apply the smallest correction that resolves the issue.",
    };
  }
  if (!isRecord(value)) return null;

  const issueText = firstString(value, ["issue", "title", "problem", "defect", "finding", "description", "name"]);
  if (!issueText) return null;
  const evidence = firstString(value, ["evidence", "observation", "sourceEvidence", "rationale", "context", "why"])
    || "The reviewer identified this issue but did not provide separate evidence.";
  const fix = firstString(value, ["fix", "recommendation", "recommendedAction", "suggestedFix", "solution", "action", "remediation"])
    || "Inspect the affected component and apply the smallest correction that resolves the issue.";
  return {
    severity: severity(value.severity ?? value.priority ?? value.level),
    issue: issueText.slice(0, 240),
    evidence: evidence.slice(0, 300),
    fix: fix.slice(0, 300),
  };
}

/**
 * Normalize common model response variations into the stable Visual QA contract.
 * Unknown model fields are intentionally discarded before strict schema validation.
 */
export function normalizeVisualReview(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const rawIssues = [value.issues, value.findings, value.defects, value.problems].find(Array.isArray);
  if (!Array.isArray(rawIssues)) return null;

  const issues: JsonRecord[] = [];
  for (const rawIssue of rawIssues.slice(0, 12)) {
    const normalized = issueRecord(rawIssue);
    if (normalized) issues.push(normalized);
  }

  const rawScore = value.score ?? value.qualityScore ?? value.visualScore ?? value.overallScore;
  let score: number;
  if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
    score = rawScore;
  } else if (typeof rawScore === "string" && rawScore.trim()) {
    const match = rawScore.match(/-?\d+(?:\.\d+)?/);
    score = match ? Number(match[0]) : 0;
  } else {
    // Missing score must fail the quality gate rather than accidentally pass.
    score = 0;
  }
  score = Math.max(0, Math.min(100, score));

  const summary = firstString(value, ["summary", "assessment", "overallAssessment", "conclusion", "reviewSummary"])
    || "Visual review normalized from model findings. Inspect the listed issues before accepting the variation.";

  return { issues, score, summary: summary.slice(0, 500) };
}
