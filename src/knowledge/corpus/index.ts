import type { KnowledgeEntry } from "../types";
import { CRAFT } from "./craft";
import { DOMAINS } from "./domains";
import { FOUNDATIONS } from "./foundations";
import { PATTERNS } from "./patterns";

/** The curated core corpus that ships with the code (versioned in git). */
export const CORE_KNOWLEDGE: KnowledgeEntry[] = [...FOUNDATIONS, ...CRAFT, ...PATTERNS, ...DOMAINS];

export const CORE_KNOWLEDGE_VERSION = "2026-11-07";
