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

const HEX = /^#[0-9a-f]{6}$/i;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The file's own screen background, so a new screen matches the file's theme (a dark file gets a
 * dark screen): the page's dominant frame fill, else a paint style named like a background.
 */
export function fileBackground(canvas: Rec): string | null {
  const page = typeof canvas.pageBackground === "string" && HEX.test(canvas.pageBackground) ? canvas.pageBackground.toUpperCase() : null;
  if (page) return page;
  // Component-scoped fills ("Button / bg", "Card background") are not the screen background.
  const styles = arr(asRec(canvas.styles)?.paint).map(asRec).filter((x): x is Rec => !!x && typeof x.color === "string" && HEX.test(String(x.color)) &&
    !/\b(button|btn|badge|chip|input|field|card|alert|banner|toast|tag|on[- ])/i.test(String(x.name)));
  const leaf = (name: unknown) => String(name ?? "").split("/").pop()!.trim().toLowerCase();
  const pick = styles.find((st) => /^(background|bg|screen background|page background|canvas|base)( ?\d+)?$/.test(leaf(st.name))) ??
    styles.find((st) => /\b(background|bg)\b/i.test(String(st.name)));
  return pick ? String(pick.color).toUpperCase() : null;
}

/** The file's app bar component that fits the new screen's width, so create mode reuses it. */
export function fileHeaderComponent(canvas: Rec, width: number): Rec | null {
  const components = arr(canvas.components).map(asRec).filter((x): x is Rec => !!x && typeof x.id === "string");
  const fits = components.filter((c) => /\b(app ?bar|top ?bar|header|nav(igation)? ?bar|tool ?bar)\b/i.test(String(c.name)) &&
    !/\b(bottom|tab ?bar|section|card|table|list)\b/i.test(String(c.name)) &&
    typeof c.width === "number" && c.width >= width * 0.85 && c.width <= width * 1.15 &&
    typeof c.height === "number" && c.height >= 40 && c.height <= 140);
  fits.sort((a, b) => Number(b.uses ?? 0) - Number(a.uses ?? 0));
  return fits[0] ?? null;
}

/** The request canvas with its (empty or absent) nodes replaced by one empty frame of the target size. */
export function createModeCanvas(canvas: unknown, size: { width: number; height: number }, prompt: string): Rec {
  const base = asRec(canvas) ?? {};
  const header = fileHeaderComponent(base, size.width);
  // The header is an instance with no texts: there is still nothing to preserve, only something to reuse.
  const children = header ? [{ id: CREATE_FRAME_ID + ":header", name: String(header.name).slice(0, 80), type: "INSTANCE", x: 0, y: 0,
    width: size.width, height: Math.round(Number(header.height)), mainComponentId: header.id, children: [] }] : [];
  return {
    ...base,
    scope: "new-screen",
    nodes: [{ id: CREATE_FRAME_ID, name: createFrameName(prompt), type: "FRAME", x: 0, y: 0, width: size.width, height: size.height,
      fillColors: [fileBackground(base) ?? "#FFFFFF"], layoutMode: "VERTICAL", children }],
  };
}

export function createScopeInstructions(size: { width: number; height: number; platform: "mobile" | "web" }, localeLine = ""): string {
  return [
    "TARGET SCOPE: NEW SCREEN FROM PROMPT (create mode). Nothing is selected: figmaCanvas.nodes[0] is an EMPTY " + size.width + "×" + size.height + " " + size.platform + " frame, not a source design.",
    "Every instruction about preserving, copying or inventorying source texts does not apply: there are no source texts. Design the complete screen the prompt asks for.",
    "Write realistic, specific content for the product domain instead of placeholders: real-looking labels, values, statuses, dates and action copy in the CONTENT LOCALE below (masked IDs like XXXX 4821). Never use lorem ipsum or 'Label'/'Value'.",
    localeLine,
    size.platform === "mobile"
      ? "Mobile structure: app bar with the screen title, the primary content (summary card, list or form), then the primary action; add tabs or bottom navigation only when the screen needs them. 4–7 sections."
      : "Web structure: page header with title and primary action, a summary/KPI row, the main table/list/chart area and supporting detail. 4–7 sections.",
    "FILE THEME: figmaCanvas.nodes[0].fillColors is the file's own screen background; use the file's colours (canvas.styles.paint) for theme.background, surface, text and primary, so the new screen matches the other screens (dark file → dark screen). If nodes[0] has an app bar instance, start with an app_bar block: it renders that component with your title.",
    "DESIGN SYSTEM FIRST still applies: when figmaCanvas.components lists a button, input, tab, chip, badge, list row, nav bar or card component, use it through a component block.",
  ].filter(Boolean).join("\n");
}

export const CREATE_OPERATING_CONTRACT = [
  "The user's prompt describes a NEW screen to design from scratch; there is no source frame to preserve.",
  "Apply the senior designer workflow: pick the screen's primary task, order sections by importance, keep one clear primary action, use realistic domain content.",
  "DESIGN SYSTEM FIRST: figmaCanvas.components lists the file's components ranked by use. Use them for controls through component blocks with exact componentIds and listed property names only.",
  "After creation the plugin runs one rendered screenshot + native layer review and may perform one bounded surgical repair.",
];
