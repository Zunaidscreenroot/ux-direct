/**
 * UX Direct core knowledge: a curated, versioned UX/product-design corpus that ships with the
 * code. It is retrieved per task (role + domain + query) and given to free models as context.
 *
 * Rules for every entry:
 * - Facts only from well-known, citable sources (listed in `sources`). No invented numbers.
 * - Written as instructions a designer can act on, not as essays.
 * - Short: one idea per entry, ~300–900 characters, so retrieval can pick exactly what is needed.
 */

export type KnowledgeCategory =
  | "identity"
  | "director"
  | "principles"
  | "heuristics"
  | "laws"
  | "gestalt"
  | "cognition"
  | "accessibility"
  | "design-systems"
  | "visual"
  | "layout"
  | "patterns"
  | "screens"
  | "components"
  | "content"
  | "motion"
  | "dataviz"
  | "platform"
  | "research"
  | "process"
  | "domain"
  | "market"
  | "quality";

/** Agency seats that read knowledge. Other role names are mapped onto these by `normalizeRole`. */
export type KnowledgeRole =
  | "director"
  | "lead"
  | "strategist"
  | "researcher"
  | "ux-designer"
  | "ui-designer"
  | "interaction"
  | "writer"
  | "accessibility"
  | "design-system"
  | "dataviz"
  | "motion"
  | "reviewer"
  | "qa";

export const KNOWLEDGE_ROLES: KnowledgeRole[] = [
  "director", "lead", "strategist", "researcher", "ux-designer", "ui-designer", "interaction",
  "writer", "accessibility", "design-system", "dataviz", "motion", "reviewer", "qa",
];

/** Matches the domain ids in src/figma-agent/agent-roles.ts, plus "government". */
export type KnowledgeDomain =
  | "fintech" | "insurance" | "healthcare" | "ecommerce" | "edtech" | "travel" | "food"
  | "saas" | "social" | "government" | "general";

export const KNOWLEDGE_DOMAINS: KnowledgeDomain[] = [
  "fintech", "insurance", "healthcare", "ecommerce", "edtech", "travel", "food", "saas", "social", "government", "general",
];

export type KnowledgeEntry = {
  /** Stable id, e.g. "law-fitts". Edits on the web page override by this id. */
  id: string;
  title: string;
  category: KnowledgeCategory;
  /** Seats this entry is written for; "all" means every seat. */
  roles: Array<KnowledgeRole | "all">;
  /** Domains this entry is specific to; omitted = applies everywhere. */
  domains?: KnowledgeDomain[];
  tags: string[];
  body: string;
  sources: string[];
  /** Always included for these roles regardless of the query (kept tiny). */
  pinned?: boolean;
};

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  identity: "UX Direct identity",
  director: "Design director thinking",
  principles: "Design principles (Norman, Rams, Apple)",
  heuristics: "Usability heuristics",
  laws: "Laws of UX",
  gestalt: "Gestalt perception",
  cognition: "Cognition and behaviour",
  accessibility: "Accessibility (WCAG)",
  "design-systems": "Design systems",
  visual: "Visual design (type, colour, space)",
  layout: "Layout and grids",
  patterns: "UI patterns",
  screens: "Screen patterns (reference library)",
  components: "Components (open design systems)",
  content: "Content design",
  motion: "Motion",
  dataviz: "Data visualisation",
  platform: "Platforms (iOS, Android, web)",
  research: "Research and validation",
  process: "Process and critique",
  domain: "Industry domains",
  market: "Markets (India focus)",
  quality: "Quality gates and anti-slop",
};
