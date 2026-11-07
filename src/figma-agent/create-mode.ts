/**
 * "0-to-1 from prompt": nothing is selected, the prompt asks for a new screen. The pipeline is
 * built around a source frame, so create mode hands it an empty virtual frame of the target size
 * plus the file's real component/style catalogue. Every source-preservation gate then has nothing
 * to preserve, and the planner gets create-specific instructions instead of "keep every source text".
 */
type Rec = Record<string, unknown>;
const asRec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null);

export const CREATE_DESIGN_SCOPE = "new_screen";
export const CREATE_FRAME_ID = "uxd:new-screen";

const WEB = /\b(web|desktop|website|web ?app|landing ?page|admin|back ?office|laptop|1440|1280)\b/i;

/** Mobile 360×800 by default; a web/desktop prompt gets 1440×1024. An explicit size wins. */
export function createFrameSize(prompt: string, frame?: { width: number; height: number } | null): { width: number; height: number; platform: "mobile" | "web" } {
  if (frame) return { width: frame.width, height: frame.height, platform: frame.width >= 768 ? "web" : "mobile" };
  return WEB.test(prompt) ? { width: 1440, height: 1024, platform: "web" } : { width: 360, height: 800, platform: "mobile" };
}

/** A short frame name from the prompt ("create a loan dashboard" → "Loan dashboard"). */
export function createFrameName(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim()
    .replace(/^(please\s+)?(create|make|design|build|generate|draw|add)\s+(me\s+)?(a|an|the|new)?\s*(new\s+)?/i, "")
    .replace(/\b(screen|page|frame|ui|design)\b\s*$/i, "").replace(/[.!?]+$/, "").trim();
  const name = (cleaned || "New screen").slice(0, 60);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The request canvas with its (empty or absent) nodes replaced by one empty frame of the target size. */
export function createModeCanvas(canvas: unknown, size: { width: number; height: number }, prompt: string): Rec {
  const base = asRec(canvas) ?? {};
  return {
    ...base,
    scope: "new-screen",
    nodes: [{ id: CREATE_FRAME_ID, name: createFrameName(prompt), type: "FRAME", x: 0, y: 0, width: size.width, height: size.height,
      fillColors: ["#FFFFFF"], layoutMode: "VERTICAL", children: [] }],
  };
}

export function createScopeInstructions(size: { width: number; height: number; platform: "mobile" | "web" }): string {
  return [
    "TARGET SCOPE: NEW SCREEN FROM PROMPT (create mode). Nothing is selected: figmaCanvas.nodes[0] is an EMPTY " + size.width + "×" + size.height + " " + size.platform + " frame, not a source design.",
    "Every instruction about preserving, copying or inventorying source texts does not apply: there are no source texts. Design the complete screen the prompt asks for.",
    "Write realistic, specific content for the product domain instead of placeholders: real-looking labels, values, statuses, dates and action copy (for Indian finance: ₹ with lakh grouping like ₹1,25,000, dates like 12 Mar 2026, masked IDs like XXXX 4821). Never use lorem ipsum or 'Label'/'Value'.",
    size.platform === "mobile"
      ? "Mobile structure: app bar with the screen title, the primary content (summary card, list or form), then the primary action; add tabs or bottom navigation only when the screen needs them. 4–7 sections."
      : "Web structure: page header with title and primary action, a summary/KPI row, the main table/list/chart area and supporting detail. 4–7 sections.",
    "DESIGN SYSTEM FIRST still applies: when figmaCanvas.components lists a button, input, tab, chip, badge, list row, nav bar or card component, use it through a component block.",
  ].join("\n");
}

export const CREATE_OPERATING_CONTRACT = [
  "The user's prompt describes a NEW screen to design from scratch; there is no source frame to preserve.",
  "Apply the senior designer workflow: pick the screen's primary task, order sections by importance, keep one clear primary action, use realistic domain content.",
  "DESIGN SYSTEM FIRST: figmaCanvas.components lists the file's components ranked by use. Use them for controls through component blocks with exact componentIds and listed property names only.",
  "After creation the plugin runs one rendered screenshot + native layer review and may perform one bounded surgical repair.",
];
