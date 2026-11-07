/**
 * "States pack": empty / loading / error / success versions of a selected screen.
 *
 * A state intentionally loses some source content (an empty list has no rows, a loading screen
 * shows skeletons), so the source-preservation gates need to know which texts may go. The header
 * band (app bar, title) and the bottom navigation always stay: a state is the same screen.
 */
export const SCREEN_STATES = ["empty", "loading", "error", "success"] as const;
export type ScreenState = typeof SCREEN_STATES[number];

type Rec = Record<string, unknown>;
const asRec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const STATE_LABELS: Record<ScreenState, string> = { empty: "Empty state", loading: "Loading state", error: "Error state", success: "Success state" };

export const STATE_BRIEFS: Record<ScreenState, string> = {
  empty: "SCREEN STATE: EMPTY. Design the EMPTY state of this exact screen. Keep the same app bar, title, tabs and bottom navigation (copy their texts exactly). Replace the list/cards/data content with one empty-state section: a skeleton block with shape \"circle\" as simple art, a heading saying nothing is here yet in this product's words (e.g. \"No active loans\"), one short muted explanation and ONE primary button that starts the first item (e.g. \"Apply for a loan\"). Do not show any source rows, amounts or IDs, and no transactional buttons that need data (Pay now, View details).",
  loading: "SCREEN STATE: LOADING. Design the LOADING (skeleton) state of this exact screen. Keep the same app bar, title, tabs and bottom navigation (copy their texts exactly). Replace every content card/row with text-free skeleton placeholders that keep the source layout rhythm: use skeleton blocks ({lines: 2–3} for text rows, {height: 56–120} for cards/charts) inside the same card sections, in the source theme. No real amounts, IDs, row texts or \"Loading\" labels.",
  error: "SCREEN STATE: ERROR. Design the ERROR state of this exact screen: keep the full screen and all source content, and add a danger banner near the top with a short, specific problem message for this screen (e.g. \"Couldn't load your loans\") and a \"Retry\" action.",
  success: "SCREEN STATE: SUCCESS. Design the SUCCESS state of this exact screen: keep the full screen and all source content, and add a success banner near the top that confirms the screen's main action completed (e.g. \"Payment successful\"), with one short supporting line.",
};

/** Empty and loading states replace the content area; error and success keep everything. */
export function stateDropsContent(state: ScreenState | null | undefined): boolean {
  return state === "empty" || state === "loading";
}

function textsWithY(node: Rec, offsetY: number, out: Array<{ text: string; y: number }>, depth = 0): void {
  if (depth > 14) return;
  const y = offsetY + (depth === 0 ? 0 : num(node.y) ?? 0);
  if (node.type === "TEXT" && typeof node.text === "string" && node.text.trim()) out.push({ text: node.text.trim(), y });
  if (Array.isArray(node.children)) for (const child of node.children) { const c = asRec(child); if (c) textsWithY(c, y, out, depth + 1); }
}

/** Source texts a state must keep: the header band and the bottom navigation bar. */
export function stateKeepTexts(sourceCanvas: unknown): Set<string> {
  const root = asRec(Array.isArray(asRec(sourceCanvas)?.nodes) ? (asRec(sourceCanvas)!.nodes as unknown[])[0] : null);
  const keep = new Set<string>();
  if (!root) return keep;
  const height = num(root.height) ?? 800;
  const children = (Array.isArray(root.children) ? root.children : []).map(asRec).filter((c): c is Rec => !!c);
  // The header is the top child (app bar / title block); the nav is a short bar flush with the bottom.
  const top = children.find((c) => (num(c.y) ?? 99) <= 8 && (num(c.height) ?? 999) <= 160);
  const bottom = height > 560 ? children.find((c) => (num(c.y) ?? 0) + (num(c.height) ?? 0) >= height - 4 && (num(c.height) ?? 999) <= 100) : undefined;
  const headerBand = top ? num(top.height) ?? 60 : 60;
  const navBand = bottom ? num(bottom.y) ?? Infinity : height > 560 ? height - 80 : Infinity;
  const items: Array<{ text: string; y: number }> = [];
  textsWithY(root, 0, items);
  for (const item of items) if (item.y < headerBand || item.y >= navBand) keep.add(item.text);
  return keep;
}

/** All source texts a state may drop (everything outside the header and the nav). */
export function stateDroppableTexts(sourceCanvas: unknown, state: ScreenState | null | undefined): string[] {
  if (!stateDropsContent(state)) return [];
  const root = asRec(Array.isArray(asRec(sourceCanvas)?.nodes) ? (asRec(sourceCanvas)!.nodes as unknown[])[0] : null);
  if (!root) return [];
  const keep = stateKeepTexts(sourceCanvas);
  const items: Array<{ text: string; y: number }> = [];
  textsWithY(root, 0, items);
  return [...new Set(items.map((item) => item.text))].filter((text) => !keep.has(text)).slice(0, 300);
}

/**
 * The prompt the source-content gates read. They already accept a removal the request names
 * ("remove X"), so a state lists the texts it intentionally drops; the header and nav stay guarded.
 */
export function stateGatePrompt(prompt: string, state: ScreenState | null | undefined, sourceCanvas: unknown): string {
  const droppable = stateDroppableTexts(sourceCanvas, state);
  if (!droppable.length) return prompt;
  return prompt + "\n" + droppable.map((text) => "remove " + text.replace(/\s+/g, " ").slice(0, 200) + ".").join("\n");
}

/** Empty-state copy in the screen's own words ("Manage Loans" → "No loans yet" / "Apply for a loan"). */
export function emptyCopy(title: string): { heading: string; body: string; action: string } {
  const subject = title.replace(/^(manage|my|your|all|view)\s+/i, "").trim() || "items";
  const lower = subject.toLowerCase();
  const action = /loan/.test(lower) ? "Apply for a loan" : /card/.test(lower) ? "Apply for a card" : /account/.test(lower) ? "Add an account"
    : /payment|transaction|transfer/.test(lower) ? "Make a payment" : /goal|saving|investment|deposit/.test(lower) ? "Start saving" : "Get started";
  return { heading: "No " + lower + " yet", body: "When you have " + lower + ", they will show up here.", action };
}

function blockTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") { out.push(value.trim()); return out; }
  if (Array.isArray(value)) { for (const item of value) blockTexts(item, out); return out; }
  const rec = asRec(value);
  if (rec) for (const [key, item] of Object.entries(rec)) if (key !== "type" && key !== "tone" && key !== "variant") blockTexts(item, out);
  return out;
}

/** Deterministic state built from the source fallback spec, used when no model answer passed. */
export function stateFallbackSpec(sourceSpec: Rec, state: ScreenState, sourceCanvas: unknown): Rec {
  const sections = (Array.isArray(sourceSpec.sections) ? sourceSpec.sections : []).map(asRec).filter((s): s is Rec => !!s);
  const keep = stateKeepTexts(sourceCanvas);
  const isChrome = (section: Rec) => {
    const texts = blockTexts(section.blocks).filter(Boolean);
    return texts.length > 0 && texts.every((text) => keep.has(text));
  };
  const chromeTop: Rec[] = [], chromeBottom: Rec[] = [], content: Rec[] = [];
  sections.forEach((section, index) => {
    if (isChrome(section) && (index === 0 || chromeTop.length === index)) chromeTop.push(section);
    else if (isChrome(section)) chromeBottom.push(section);
    else content.push(section);
  });
  const title = String(blockTexts(chromeTop[0]?.blocks)[0] || "this screen");
  // Tabs/chips are navigation, not data: an empty or loading screen keeps them (round 8).
  const isNav = (section: Rec) => Array.isArray(section.blocks) && section.blocks.length > 0 &&
    section.blocks.every((block) => ["tabs", "chips", "segmented"].includes(String(asRec(block)?.type)));
  const nav = content.filter(isNav);
  const data = content.filter((section) => !isNav(section));
  let middle: Rec[];
  if (state === "empty") {
    const empty = emptyCopy(title);
    middle = [...nav, { name: "Empty state", blocks: [
      { type: "skeleton", shape: "circle", height: 96 },
      { type: "heading", title: empty.heading, subtitle: empty.body },
      { type: "button", label: empty.action, variant: "primary" },
    ] }];
  } else if (state === "loading") {
    const cards = data.slice(0, 4).map((section, index) => ({ name: "Loading " + (index + 1), surface: section.surface ?? "card",
      blocks: [{ type: "skeleton", lines: 2 }, { type: "skeleton", height: 56 }] }));
    middle = [...nav, ...(cards.length ? cards : [{ name: "Loading", surface: "card", blocks: [{ type: "skeleton", lines: 3 }] }])];
  } else {
    const banner = state === "error"
      ? { type: "banner", tone: "danger", title: "Couldn't load " + title, body: "Check your connection and try again.", action: "Retry" }
      : { type: "banner", tone: "success", title: "Done", body: "Your request was completed successfully." };
    middle = [{ name: state === "error" ? "Error" : "Success", blocks: [banner] }, ...content];
  }
  const frame = asRec(sourceSpec.frame) ?? {};
  // Same naming as the plugin's states pack: "<screen> / Error".
  const word = state.charAt(0).toUpperCase() + state.slice(1);
  return { ...sourceSpec, frame: { ...frame, name: (String(frame.name || title) + " / " + word).slice(0, 80) },
    sections: [...chromeTop, ...middle, ...chromeBottom].slice(0, 8) };
}
