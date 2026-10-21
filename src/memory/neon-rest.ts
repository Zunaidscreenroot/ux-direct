import { neon } from "@neondatabase/serverless";

type JsonRow = Record<string, unknown>;
const ALLOWED_TABLES = new Set([
  "uxd_brain_feedback",
  "uxd_knowledge_documents",
  "uxd_knowledge_chunks",
  "uxd_brain_eval_cases",
  "uxd_task_runs",
  "uxd_model_learning_events",
]);

// The Neon/Postgres driver treats JavaScript arrays as PostgreSQL arrays by
// default. JSONB columns such as examples must receive JSON text instead,
// or an empty JS array becomes an object-like PostgreSQL array and violates
// the JSON-array constraint.
const JSONB_COLUMNS: Record<string, ReadonlySet<string>> = {
  uxd_brain_feedback: new Set(["examples", "metadata"]),
  uxd_knowledge_documents: new Set(["metadata"]),
  uxd_knowledge_chunks: new Set(["metadata"]),
  uxd_brain_eval_cases: new Set(["last_run_result", "metadata"]),
  uxd_task_runs: new Set(["metadata", "plan", "retrieval", "lesson"]),
  uxd_model_learning_events: new Set(["operation_profile"]),
};

export function serializeDatabaseValue(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (JSONB_COLUMNS[table]?.has(column) && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL
    || process.env.POSTGRES_PRISMA_URL
    || process.env.POSTGRES_URL_NON_POOLING;
  if (!value) throw new Error("DATABASE_URL is not configured for the shared Neon brain.");
  return value;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Unsupported database identifier.");
  return '"' + value.replace(/"/g, '""') + '"';
}

function parseFilter(value: string): { op: string; value: string } {
  const match = value.match(/^(eq|neq|gt|gte|lt|lte|is|in)\.([\s\S]*)$/);
  if (!match) throw new Error("Unsupported database filter.");
  return { op: match[1], value: match[2] };
}

function addWhere(params: URLSearchParams, values: unknown[], startIndex = 1): string[] {
  const ignored = new Set(["select", "order", "limit", "offset", "on_conflict"]);
  const conditions: string[] = [];
  for (const [key, raw] of params.entries()) {
    if (ignored.has(key)) continue;
    const column = quoteIdentifier(key);
    const filter = parseFilter(raw);
    if (filter.op === "is" && filter.value === "null") {
      conditions.push(`${column} IS NULL`);
    } else if (filter.op === "is" && filter.value === "not.null") {
      conditions.push(`${column} IS NOT NULL`);
    } else if (filter.op === "in") {
      if (!filter.value.startsWith("(") || !filter.value.endsWith(")")) throw new Error("Invalid IN filter.");
      const list = filter.value.slice(1, -1).split(",").filter(Boolean).map(item => item.replace(/^"(.*)"$/, "$1"));
      values.push(list);
      conditions.push(`${column}::text = ANY($${startIndex + values.length - 1}::text[])`);
    } else {
      const op = ({ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as Record<string, string>)[filter.op];
      if (!op) throw new Error("Unsupported filter operator.");
      values.push(filter.value);
      conditions.push(`${column} ${op} $${startIndex + values.length - 1}`);
    }
  }
  return conditions;
}

function returningClause(prefer: string): string {
  return /return=representation/i.test(prefer) ? " RETURNING *" : "";
}

async function execute(query: string, values: unknown[] = []): Promise<JsonRow[]> {
  const sql = neon(databaseUrl());
  return await sql.query(query, values) as JsonRow[];
}

/**
 * Small, allow-listed adapter for the subset of Supabase/PostgREST used by the
 * shared-brain module. It preserves existing callers while all queries run on Neon.
 */
export async function neonRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = new URL(path.startsWith("/") ? path : "/" + path, "https://neon.internal");
  const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
  const method = (init.method || "GET").toUpperCase();
  const prefer = String(new Headers(init.headers).get("Prefer") || "");
  let body: unknown = null;
  if (typeof init.body === "string" && init.body) body = JSON.parse(init.body);

  if (pathname.startsWith("rpc/")) {
    if (method !== "POST") throw new Error("Shared brain RPC methods require POST.");
    const name = pathname.slice(4);
    const args = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (name === "uxd_brain_search_memories") {
      const rows = await execute(
        "SELECT * FROM public.uxd_brain_search_memories($1::text,$2::text[],$3::integer,$4::text[])",
        [args.p_query ?? "", args.p_scope_keys ?? ["UX_SHARED_BRAIN"], args.p_limit ?? 6, args.p_memory_types ?? null],
      );
      return rows;
    }
    if (name === "uxd_brain_search_knowledge") {
      return await execute(
        "SELECT * FROM public.uxd_brain_search_knowledge($1::text,$2::text[],$3::integer)",
        [args.p_query ?? "", args.p_scope_keys ?? ["UX_SHARED_BRAIN"], args.p_limit ?? 6],
      );
    }
    if (name === "uxd_brain_mark_used") {
      const rows = await execute("SELECT public.uxd_brain_mark_used($1::uuid[]) AS result", [args.ids ?? []]);
      return rows[0]?.result ?? null;
    }
    if (name === "uxd_brain_capture_task_lesson") {
      const rows = await execute(
        "SELECT public.uxd_brain_capture_task_lesson($1::text,$2::text,$3::text,$4::text,$5::text[],$6::text) AS result",
        [args.p_scope, args.p_memory_type, args.p_title, args.p_content, args.p_tags ?? [], args.p_dedupe_key],
      );
      return rows[0]?.result ?? null;
    }
    if (name === "uxd_task_claim_lesson") {
      const rows = await execute("SELECT public.uxd_task_claim_lesson($1::uuid) AS result", [args.p_task_run_id]);
      return rows[0]?.result ?? false;
    }
    if (name === "uxd_brain_review_feedback") {
      const rows = await execute(
        "SELECT public.uxd_brain_review_feedback($1::uuid,$2::text,$3::text) AS result",
        [args.p_feedback_id, args.p_action, args.p_review_note ?? ""],
      );
      return rows[0]?.result ?? null;
    }
    throw new Error("This shared-brain RPC is not allow-listed.");
  }

  const table = pathname;
  if (!ALLOWED_TABLES.has(table)) throw new Error("Database table is not allow-listed.");
  const tableSql = `public.${quoteIdentifier(table)}`;
  const params = url.searchParams;
  const filters: unknown[] = [];
  const where = addWhere(params, filters);
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  if (method === "GET") {
    const columns = (params.get("select") || "*").split(",").map(c => c.trim());
    const selectSql = columns.length === 1 && columns[0] === "*"
      ? "*"
      : columns.map(quoteIdentifier).join(", ");
    const order = params.get("order");
    let orderSql = "";
    if (order) {
      const parts = order.split(",").map(item => item.trim());
      orderSql = " ORDER BY " + parts.map(item => {
        const [column, direction] = item.split(".");
        if (direction && !["asc", "desc"].includes(direction.toLowerCase())) throw new Error("Invalid order direction.");
        return quoteIdentifier(column) + (direction ? " " + direction.toUpperCase() : " ASC");
      }).join(", ");
    }
    const limit = params.get("limit");
    const offset = params.get("offset");
    const limitSql = limit ? " LIMIT " + String(Math.min(1000, Math.max(0, Number.parseInt(limit, 10) || 0))) : "";
    const offsetSql = offset ? " OFFSET " + String(Math.max(0, Number.parseInt(offset, 10) || 0)) : "";
    return await execute(`SELECT ${selectSql} FROM ${tableSql}${whereSql}${orderSql}${limitSql}${offsetSql}`, filters);
  }

  if (method === "POST") {
    const rows = Array.isArray(body) ? body : [body];
    if (!rows.length || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("Database insert body must be an object or array of objects.");
    }
    const results: JsonRow[] = [];
    for (const rowValue of rows) {
      const row = rowValue as Record<string, unknown>;
      const columns = Object.keys(row);
      if (!columns.length) throw new Error("Database insert body is empty.");
      const colSql = columns.map(quoteIdentifier).join(", ");
      const placeholders = columns.map((_, index) => "$" + (index + 1)).join(", ");
      const values = columns.map(column => serializeDatabaseValue(table, column, row[column]));
      const conflict = params.get("on_conflict");
      let conflictSql = "";
      if (conflict && /resolution=merge-duplicates/i.test(prefer)) {
        const conflictCols = conflict.split(",").map(x => x.trim());
        const updates = columns.filter(column => !conflictCols.includes(column));
        conflictSql = updates.length
          ? " ON CONFLICT (" + conflictCols.map(quoteIdentifier).join(", ") + ") DO UPDATE SET " + updates.map(c => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`).join(", ")
          : " ON CONFLICT (" + conflictCols.map(quoteIdentifier).join(", ") + ") DO NOTHING";
      }
      const result = await execute(
        `INSERT INTO ${tableSql} (${colSql}) VALUES (${placeholders})${conflictSql}${returningClause(prefer)}`,
        values,
      );
      results.push(...result);
    }
    return /return=representation/i.test(prefer) ? results : null;
  }

  if (method === "PATCH") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Database update body must be an object.");
    const row = body as Record<string, unknown>;
    const columns = Object.keys(row);
    if (!columns.length) return null;
    const setSql = columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(", ");
    const values = columns.map(column => serializeDatabaseValue(table, column, row[column]));
    const conditions = addWhere(params, values, 1);
    const whereSql = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const result = await execute(
      `UPDATE ${tableSql} SET ${setSql}${whereSql}${returningClause(prefer)}`,
      values,
    );
    return /return=representation/i.test(prefer) ? result : null;
  }

  throw new Error("Unsupported database method.");
}
