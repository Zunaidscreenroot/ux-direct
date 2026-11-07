import { containsSensitiveMaterial } from "@/src/memory/inline-learning";
import { objectivePlaybook } from "@/src/figma-agent/design-thinking";

export type DesignerFeedbackKind = "critique" | "explanation" | "rule";
export type DesignerLesson = {
  title: string;
  rawFeedback: string;
  normalizedRule: string;
  rationale: string;
  keywords: string[];
  feedbackKind: "recommendation_quality" | "design_system" | "general";
  originalLanguage: string;
};

const STOP = new Set(["this", "that", "with", "make", "screen", "please", "karo", "kardo", "hai", "the", "and", "for", "from", "into", "your", "mera", "meri", "ye", "yeh", "isko", "usko", "have", "should"]);

function clip(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
function language(text: string): string {
  return /\b(hai|nahi|nhi|karo|kar|mein|ko|ka|ki|vesa|jaisa|chahiye|toh|bhi)\b/i.test(text) ? "Hinglish" : "English";
}

/**
 * Turns what the designer said in the plugin into a generic, reusable lesson for the shared brain:
 * what was wrong and what to do instead, without node IDs or screen content. Deterministic, so a
 * lesson is saved even when every free model is rate limited. Returns null for empty or sensitive text.
 */
export function buildDesignerLesson(kind: DesignerFeedbackKind, textValue: string, requestValue = ""): DesignerLesson | null {
  const text = clip(textValue, 600);
  const request = clip(String(requestValue ?? "").split(/\n?FEEDBACK ON THE PREVIOUS ATTEMPT/)[0], 300);
  if (text.length < 3 || containsSensitiveMaterial(text + " " + request)) return null;
  const keywords = [...new Set((request + " " + text).toLowerCase().match(/[a-zऀ-ॿ]{4,}/g) || [])]
    .filter((word) => !STOP.has(word)).slice(0, 12).concat(["designer feedback"]);
  if (kind === "critique") {
    const objective = request || "the design request";
    const moves = objectivePlaybook(request).split("\n").filter((line) => line.startsWith("- ")).slice(0, 4).join(" ");
    return {
      title: clip("Designer rejected a result: \"" + objective + "\"", 180),
      rawFeedback: "Request: \"" + objective + "\". Designer feedback on the result: \"" + text + "\".",
      normalizedRule: clip("When a designer asks for \"" + objective + "\" in Figma, the screen design must clearly deliver it. A previous result was rejected with: \"" + text +
        "\". Compare the output with the source before answering; make the requested change obvious at a glance and never return a near copy of the source." + (moves ? " Useful moves: " + moves : ""), 2400),
      rationale: "Captured automatically from designer feedback in the UX Direct Figma plugin so the same mistake is not repeated.",
      keywords, feedbackKind: "recommendation_quality", originalLanguage: language(text),
    };
  }
  return {
    title: clip("Designer guidance: " + text, 180),
    rawFeedback: text,
    normalizedRule: clip("Designer guidance for UX Direct screen design in Figma: \"" + text + "\". Apply it to every design task and layout unless the designer says otherwise.", 2400),
    rationale: "Captured automatically from what the designer explained in the UX Direct Figma plugin.",
    keywords, feedbackKind: kind === "rule" ? "design_system" : "general", originalLanguage: language(text),
  };
}
