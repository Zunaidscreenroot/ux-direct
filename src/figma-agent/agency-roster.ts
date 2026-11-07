/**
 * Per-section staffing used only by the optional section pass (UXD_AGENCY=on, off by default).
 * The live team is STUDIO in studio.ts: Director, UX Lead, one UX Designer, one UI Designer.
 *
 * UX Direct's design-agency roster: every role the UX Director can staff, how many seats it
 * has, which Lead it reports to, and which gateway model tier (X-UXD-Agent-Role) it runs on.
 *
 * Seats are capacity, not simultaneous calls. One Worker request keeps at most 6 outgoing
 * connections open, and the free providers have per-minute quotas, so a screen runs about
 * 4 model calls at a time. A 3-variation batch runs ~12 across providers. The roster says WHO
 * does the work. agencyConcurrency() says how many work at once.
 *
 * Roles marked `deterministic` are code, not models (QA gates, the Director's routing), so the
 * same input always gets the same decision whichever model the gateway picks.
 * This is backend architecture: nothing here is shown in plugin replies.
 */
import type { AgentRole } from "@/src/providers/active-chat-provider";

export type RosterTeam = "direction" | "ux" | "ui" | "content" | "research" | "quality";

export interface RosterRole {
  id: string;
  title: string;
  team: RosterTeam;
  seats: number;
  /** Gateway model tier; undefined = deterministic code. */
  modelRole?: AgentRole;
  does: string;
}

export const AGENCY_ROSTER: RosterRole[] = [
  { id: "director", title: "UX Director", team: "direction", seats: 1,
    does: "Reads the screen and brief, writes the work order, routes each section to a specialist, merges the result. Thinks like a senior Apple design director: one clear goal per screen, ruthless hierarchy, content first." },
  { id: "ux-lead", title: "UX Lead — structure & flow", team: "direction", seats: 1, does: "Owns information, form, interaction and navigation designers; splits large sections." },
  { id: "ui-lead", title: "UI Lead — visual & data", team: "direction", seats: 1, does: "Owns data-viz, status, header and layout designers; keeps the source theme." },
  { id: "content-lead", title: "Content Lead", team: "direction", seats: 1, does: "Owns UX writers; copy changes only when asked." },
  { id: "quality-lead", title: "Quality Lead", team: "direction", seats: 1, does: "Owns reviewers, the accessibility check and the QA gates." },

  { id: "researcher", title: "UX researcher", team: "research", seats: 3, modelRole: "classifier", does: "Detects domain, product, user goal and primary action from evidence only (the detector and analyst sub-agents)." },
  { id: "ds-scout", title: "Design-system specialist", team: "research", seats: 2, modelRole: "classifier", does: "Maps the screen's controls to the file's real components." },

  { id: "information", title: "Information designer", team: "ux", seats: 5, modelRole: "section-designer", does: "Lists, key-value detail, scan order." },
  { id: "form", title: "Form designer", team: "ux", seats: 3, modelRole: "section-designer", does: "Inputs, validation, field order, submit last." },
  { id: "interaction", title: "Interaction designer", team: "ux", seats: 3, modelRole: "section-designer", does: "Action priority: one primary, the rest secondary." },
  { id: "navigation", title: "Navigation designer", team: "ux", seats: 2, does: "Tabs, chips, bottom nav: kept exactly from the source (deterministic)." },
  { id: "generalist", title: "Product designer", team: "ux", seats: 3, modelRole: "section-designer", does: "Sections no specialist owns." },

  { id: "dataviz", title: "Data-viz designer", team: "ui", seats: 5, modelRole: "section-designer", does: "Amounts, stats, progress rings/bars with real values." },
  { id: "status", title: "Status designer", team: "ui", seats: 2, modelRole: "section-designer", does: "Badges, banners, feedback tones." },
  { id: "header", title: "Header designer", team: "ui", seats: 1, does: "App bar: kept exactly from the source (deterministic)." },

  { id: "writer", title: "UX writer", team: "content", seats: 4, modelRole: "section-designer", does: "Headings, body and button copy; numbers and names untouched." },

  { id: "reviewer", title: "Design reviewer", team: "quality", seats: 6, modelRole: "critic", does: "Reviews each section as soon as it is designed, top to bottom while other sections are still being designed; sends concrete fixes back to the designer for another iteration, then re-reviews." },
  { id: "a11y", title: "Accessibility reviewer", team: "quality", seats: 3, modelRole: "critic", does: "Contrast, touch targets, labels, reading order (part of every review call; contrast is also enforced by the renderer)." },
  { id: "qa", title: "QA engineer", team: "quality", seats: 3, does: "Deterministic gates: source content kept, schema, components, styles, lint (code, not a model)." },
];

export function rosterSeats(): number {
  return AGENCY_ROSTER.reduce((sum, role) => sum + role.seats, 0);
}
