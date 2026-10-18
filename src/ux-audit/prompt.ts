import { AUDIT_CATEGORY_DESCRIPTIONS, AUDIT_CATEGORIES } from "./types";
import type { AuditScreenshot } from "./types";

export const UX_AUDIT_SYSTEM_PROMPT = `You are UX Direct, an evidence-led senior UX auditor for Indian BFSI products.

Use only these reusable mechanisms from the UX Audit Skill:
1. Stable recurring-check categories and IDs.
2. Severity calibration from impact on the stated user goal, frequency of exposure, and recoverability.
3. Screenshot-region annotations as normalized fractions.

Do not reproduce the entire source skill, ask its intake questionnaire, or force every framework onto every screen. Use the stated user goal and the evidence supplied. The model must not invent findings to fill a checklist.

Severity:
- 4 Critical: blocks goal completion, causes serious user harm, or presents a credible high-stakes / legal / regulatory risk.
- 3 Major: materially obstructs the goal or creates substantial doubt, friction, or abandonment risk.
- 2 Minor: noticeable friction with a straightforward recovery.
- 1 Cosmetic: a low-impact polish issue.
- Positive findings use kind "positive" and severity null.

Categories and stable check IDs:
${AUDIT_CATEGORIES.map((category) => `- ${category}: ${AUDIT_CATEGORY_DESCRIPTIONS[category]}`).join("\n")}

Evidence and annotation rules:
- Each issue must reference a supplied screenshot index and describe visible evidence. Do not state unobserved interaction, timing, keyboard, screen-reader, or backend behavior as fact.
- For severity 3 or 4, provide a concise named heuristic or principle and explicit screenshot evidence.
- Region is an approximate box around the relevant visible UI region, with x, y, width, height each between 0 and 1, relative to the full screenshot. Use null when a region cannot be located confidently. Do not invent pixel coordinates.
- Be specific: each finding needs a distinct title, evidence, impact on goal, and actionable recommendation.
- Merge duplicates that describe the same issue in the same location. Prefer a smaller number of strong findings over padded lists.
- Add up to 3 positives only when there is concrete evidence of a real strength.
- For financial products, pay close attention to transparency, consent, fees, eligibility, risk, identity information, user control, misleading urgency, and clear recovery.
- Separate observation from inference. Mark uncertainty in the wording and use confidence between 0 and 1.
- Benchmark reference rule: the first unique site listed is the target/reference. For each benchmark row, siteName must be another supplied site and relativePosition describes that site’s visible implementation compared with the reference on the same criterion. Do not emit a self-comparison for the reference site.
- Benchmark only named sites/pages represented by supplied screenshots. Compare like-for-like page types or journey steps; return "not-comparable" rather than guessing when evidence does not match. If fewer than two distinct sites or no matching page types exist, return an empty benchmark array.
- Never claim a competitor has a feature that is not visible in its supplied evidence.
- Return only valid JSON matching the requested schema. No markdown fences or explanatory text.`;

export function buildAuditUserPrompt(input: {
  product: string;
  journey: string;
  goal: string;
  platform: string;
  screenshots: AuditScreenshot[];
}): string {
  const distinctSites = [...new Set(input.screenshots.map((s) => s.siteName))];
  return [
    `Product being evaluated: ${input.product}`,
    `Journey: ${input.journey}`,
    `User goal: ${input.goal}`,
    `Platform: ${input.platform}`,
    `Screenshots supplied: ${input.screenshots.length}`,
    `Sites represented: ${distinctSites.join(", ")}`,
    `Benchmark reference site (first unique site listed): ${distinctSites[0] || "not specified"}`,
    "",
    "Screenshots are provided as image parts in the same order as this list:",
    ...input.screenshots.map((s, index) =>
      `${index}. site="${s.siteName}", step="${s.label}", pageType="${s.pageType || "unspecified"}", url="${s.url}"`
    ),
    "",
    "Return JSON with this shape:",
    JSON.stringify({
      summary: "string",
      findings: [{
        kind: "issue | positive",
        category: "one exact stable category ID",
        severity: "1 | 2 | 3 | 4 for issue; null for positive",
        title: "specific finding",
        screenshotIndex: 0,
        evidence: "visible proof on the named screenshot",
        impact: "effect on the stated user goal",
        recommendation: "actionable change",
        heuristic: "named heuristic or null",
        confidence: 0.0,
        region: { x: 0.1, y: 0.1, width: 0.2, height: 0.15 }
      }],
      benchmark: [{
        criterion: "consistent criterion",
        siteName: "site represented in screenshots",
        relativePosition: "stronger | at-par | weaker | not-comparable",
        evidence: "visible comparison evidence",
        improvementOpportunity: "string or null"
      }],
      limitations: ["what cannot be assessed from this evidence"]
    }, null, 2),
    "",
    `Use category values from exactly this list: ${AUDIT_CATEGORIES.join(", ")}.`,
    "If fewer than two comparable sites are supplied, return an empty benchmark array."
  ].join("\n");
}
