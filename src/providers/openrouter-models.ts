/**
 * Model priority for UX Direct. Requests go through OpenRouter without provider
 * allowlists, filters, or per-request router plugins.
 *
 * First: MiniMax M3.1 Flash free.
 * Fallback: OpenRouter Auto with its native, unfiltered routing.
 */
export const OPENROUTER_MODELS = [
  "minimax/minimax-m3.1-flash:free",
  "openrouter/auto",
] as const;

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.";
