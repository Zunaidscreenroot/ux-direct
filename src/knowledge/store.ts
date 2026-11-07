import { neonRequest } from "@/src/memory/neon-rest";
import { CORE_KNOWLEDGE } from "./corpus";
import { packKnowledge, rankKnowledge, type KnowledgePack, type KnowledgeQuery } from "./retrieve";
import {
  CATEGORY_LABELS, KNOWLEDGE_DOMAINS, KNOWLEDGE_ROLES,
  type KnowledgeCategory, type KnowledgeDomain, type KnowledgeEntry, type KnowledgeRole,
} from "./types";

/**
 * Owner-editable layer on top of the core corpus, stored in Neon `uxd_knowledge_documents`
 * as document rows with version_label = "kb-entry" (no chunks, so the older full-text
 * knowledge search never returns them twice). An entry whose metadata.coreId names a core
 * entry replaces it; metadata.disabled hides it.
 */

const KB_MARKER = "kb-entry";
const CACHE_MS = 60_000;

export type StoredEntry = KnowledgeEntry & {
  origin: "core" | "custom" | "edited";
  /** Neon row id when the entry is custom or edited. */
  rowId?: string;
  updatedAt?: string;
};

type Row = { id: string; title: string; status: string; updated_at: string; metadata: Record<string, unknown> };

let cache: { at: number; rows: Row[] } | null = null;

export function invalidateKnowledgeCache() {
  cache = null;
}

async function loadRows(): Promise<Row[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const result = await neonRequest(`uxd_knowledge_documents?select=id,title,status,updated_at,metadata&version_label=eq.${KB_MARKER}&status=eq.approved&order=updated_at.desc&limit=500`);
  const rows = (Array.isArray(result) ? result : []) as Row[];
  cache = { at: Date.now(), rows };
  return rows;
}

const strings = (value: unknown, max: number, count: number) =>
  (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, max)).filter(Boolean).slice(0, count);

function rowToEntry(row: Row): (StoredEntry & { coreId?: string; disabled?: boolean }) | null {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const category = String(meta.category || "") as KnowledgeCategory;
  const body = typeof meta.body === "string" ? meta.body : "";
  const coreId = typeof meta.coreId === "string" ? meta.coreId : undefined;
  const disabled = meta.disabled === true;
  if (!disabled && (!body || !(category in CATEGORY_LABELS))) return null;
  const roles = strings(meta.roles, 40, 14).filter((role) => role === "all" || (KNOWLEDGE_ROLES as string[]).includes(role)) as Array<KnowledgeRole | "all">;
  const domains = strings(meta.domains, 40, 11).filter((domain) => (KNOWLEDGE_DOMAINS as string[]).includes(domain)) as KnowledgeDomain[];
  return {
    id: coreId || "kb-" + row.id,
    title: row.title,
    category: category in CATEGORY_LABELS ? category : "patterns",
    roles: roles.length ? roles : ["all"],
    domains: domains.length && !domains.includes("general") ? domains : undefined,
    tags: strings(meta.tags, 64, 24),
    body,
    sources: strings(meta.sources, 300, 8),
    origin: coreId ? "edited" : "custom",
    rowId: row.id,
    updatedAt: row.updated_at,
    coreId,
    disabled,
  };
}

/** Core + owner entries merged: edits replace core entries, disabled ones are dropped. */
export async function loadKnowledgeEntries(): Promise<StoredEntry[]> {
  let overrides: ReturnType<typeof rowToEntry>[] = [];
  try {
    overrides = (await loadRows()).map(rowToEntry);
  } catch (error) {
    console.warn("[uxd-kb] owner entries unavailable, using core only:", error instanceof Error ? error.message.slice(0, 160) : "unknown");
  }
  const byCore = new Map<string, NonNullable<ReturnType<typeof rowToEntry>>>();
  const custom: StoredEntry[] = [];
  for (const entry of overrides) {
    if (!entry) continue;
    if (entry.coreId) { if (!byCore.has(entry.coreId)) byCore.set(entry.coreId, entry); }
    else if (!entry.disabled) custom.push(entry);
  }
  const merged: StoredEntry[] = [];
  for (const core of CORE_KNOWLEDGE) {
    const override = byCore.get(core.id);
    if (!override) { merged.push({ ...core, origin: "core" }); continue; }
    if (override.disabled) continue;
    merged.push({ ...override, id: core.id, pinned: core.pinned });
  }
  return [...merged, ...custom];
}

let mergedCache: { at: number; entries: StoredEntry[] } | null = null;

/** Ranked, packed knowledge for one task (core + owner entries). Never throws. */
export async function retrieveKnowledge(input: KnowledgeQuery & { maxChars?: number }): Promise<KnowledgePack> {
  let entries: StoredEntry[];
  if (mergedCache && Date.now() - mergedCache.at < CACHE_MS) entries = mergedCache.entries;
  else {
    entries = await loadKnowledgeEntries();
    mergedCache = { at: Date.now(), entries };
  }
  return packKnowledge(rankKnowledge(entries, input), Math.max(400, Math.floor(input.maxChars ?? 4000)));
}

export type KnowledgeEntryInput = {
  /** Existing entry id (core id or "kb-<uuid>") to edit; omit to add a new entry. */
  id?: string;
  title: string;
  category: KnowledgeCategory;
  roles: Array<KnowledgeRole | "all">;
  domains?: KnowledgeDomain[];
  tags: string[];
  body: string;
  sources?: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function findOverrideRow(coreId: string): Promise<Row | null> {
  cache = null;
  return (await loadRows()).find((row) => row.metadata?.coreId === coreId) || null;
}

function metadataFor(input: KnowledgeEntryInput, coreId?: string, disabled = false) {
  return {
    kbEntry: true,
    ...(coreId ? { coreId } : {}),
    ...(disabled ? { disabled: true } : {}),
    category: input.category,
    roles: input.roles,
    domains: input.domains || [],
    tags: input.tags,
    body: input.body,
    sources: input.sources || [],
    editedVia: "command-center",
  };
}

async function insertRow(title: string, metadata: Record<string, unknown>) {
  const now = new Date().toISOString();
  const result = await neonRequest("uxd_knowledge_documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      project_key: "UX_SHARED_BRAIN", title, source_type: "design_decision", source_authority: "owner",
      version_label: KB_MARKER, status: "approved", last_verified_at: now.slice(0, 10), metadata, updated_at: now,
    }),
  });
  const row = Array.isArray(result) ? result[0] : null;
  if (!row?.id) throw new Error("The knowledge entry was not saved.");
  return String(row.id);
}

async function patchRow(rowId: string, patch: Record<string, unknown>) {
  const result = await neonRequest(`uxd_knowledge_documents?id=eq.${encodeURIComponent(rowId)}&version_label=eq.${KB_MARKER}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  const row = Array.isArray(result) ? result[0] : null;
  if (!row?.id) throw new Error("Knowledge entry not found.");
}

function done() {
  cache = null;
  mergedCache = null;
}

/** Add a new entry, or edit an existing one (editing a core entry stores an override). */
export async function saveKnowledgeEntry(input: KnowledgeEntryInput): Promise<{ id: string }> {
  const id = input.id?.trim();
  try {
    if (id?.startsWith("kb-") && UUID.test(id.slice(3))) {
      await patchRow(id.slice(3), { title: input.title, metadata: metadataFor(input) });
      return { id };
    }
    if (id) {
      if (!CORE_KNOWLEDGE.some((entry) => entry.id === id)) throw new Error("Unknown knowledge entry id.");
      const existing = await findOverrideRow(id);
      if (existing) await patchRow(existing.id, { title: input.title, metadata: metadataFor(input, id) });
      else await insertRow(input.title, metadataFor(input, id));
      return { id };
    }
    return { id: "kb-" + await insertRow(input.title, metadataFor(input)) };
  } finally {
    done();
  }
}

/** Remove an entry: owner entries are archived; core entries are hidden by an override. */
export async function removeKnowledgeEntry(id: string): Promise<void> {
  try {
    if (id.startsWith("kb-") && UUID.test(id.slice(3))) {
      await patchRow(id.slice(3), { status: "archived" });
      return;
    }
    const core = CORE_KNOWLEDGE.find((entry) => entry.id === id);
    if (!core) throw new Error("Unknown knowledge entry id.");
    const existing = await findOverrideRow(id);
    const metadata = metadataFor({ ...core }, id, true);
    if (existing) await patchRow(existing.id, { metadata });
    else await insertRow(core.title, metadata);
  } finally {
    done();
  }
}

/** Undo an edit or removal of a core entry. */
export async function restoreCoreEntry(id: string): Promise<void> {
  try {
    if (!CORE_KNOWLEDGE.some((entry) => entry.id === id)) throw new Error("Unknown core entry id.");
    const existing = await findOverrideRow(id);
    if (existing) await patchRow(existing.id, { status: "archived" });
  } finally {
    done();
  }
}

/** Every entry for the knowledge page, including hidden core entries (so they can be restored). */
export async function listKnowledgeForPage(): Promise<{ entries: StoredEntry[]; hidden: Array<{ id: string; title: string }>; ownerLayer: "ok" | "unavailable" }> {
  let rows: Row[] = [];
  let ownerLayer: "ok" | "unavailable" = "ok";
  try {
    cache = null;
    rows = await loadRows();
  } catch {
    ownerLayer = "unavailable";
  }
  const entries = ownerLayer === "ok" ? await loadKnowledgeEntries() : CORE_KNOWLEDGE.map((entry) => ({ ...entry, origin: "core" as const }));
  const hidden = rows.map(rowToEntry).filter((entry) => entry?.coreId && entry.disabled)
    .map((entry) => ({ id: entry!.coreId!, title: entry!.title }));
  return { entries, hidden, ownerLayer };
}
