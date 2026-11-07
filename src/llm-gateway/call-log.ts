import { neon } from "@neondatabase/serverless";

/**
 * One row per model attempt (UX Direct gateway and FreeLLMAPI alike) in Neon table uxd_llm_calls.
 * The same rows drive routing (per-model RPM/RPD use, cooldowns, success rate, latency) and the
 * analytics view, so there is a single source of truth across Worker isolates.
 */
export type CallRecord = {
  requestId: string;
  gateway: "uxd" | "freellmapi";
  role: string;
  provider: string;
  model: string;
  ok: boolean;
  httpStatus: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
  attempt: number;
  stream: boolean;
  cooldownUntil?: string;
};

export type ModelUsage = {
  provider: string;
  model: string;
  lastMinute: number;
  today: number;
  tokensToday: number;
  calls24h: number;
  ok24h: number;
  avgLatencyMs: number;
  cooldownUntil?: number;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS public.uxd_llm_calls (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    request_id text,
    gateway text NOT NULL,
    role text,
    provider text NOT NULL,
    model text NOT NULL,
    ok boolean NOT NULL,
    http_status integer,
    latency_ms integer,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    error text,
    attempt integer,
    stream boolean,
    cooldown_until timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS uxd_llm_calls_at_idx ON public.uxd_llm_calls (at DESC)",
  "CREATE INDEX IF NOT EXISTS uxd_llm_calls_model_at_idx ON public.uxd_llm_calls (provider, model, at DESC)",
];

function databaseUrl(): string | null {
  return process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL_NON_POOLING || null;
}

let schemaReady: Promise<void> | null = null;

async function sqlClient() {
  const url = databaseUrl();
  if (!url) return null;
  const sql = neon(url);
  if (!schemaReady) {
    schemaReady = (async () => { for (const statement of SCHEMA) await sql.query(statement); })()
      .catch((error) => { schemaReady = null; throw error; });
  }
  await schemaReady;
  return sql;
}

const clip = (value: string | undefined, max: number) => (value ? value.replace(/\s+/g, " ").slice(0, max) : null);
const int = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

export async function writeCalls(records: CallRecord[]): Promise<void> {
  if (!records.length) return;
  const sql = await sqlClient();
  if (!sql) return;
  const columns = 15;
  const values: unknown[] = [];
  const rows = records.map((record, index) => {
    values.push(
      record.requestId.slice(0, 80), record.gateway, record.role.slice(0, 40), record.provider.slice(0, 40), record.model.slice(0, 160),
      record.ok, int(record.httpStatus), int(record.latencyMs), int(record.promptTokens), int(record.completionTokens),
      int(record.totalTokens), clip(record.error, 400), record.attempt, record.stream, record.cooldownUntil ?? null,
    );
    const base = index * columns;
    return "(" + Array.from({ length: columns }, (_, column) => "$" + (base + column + 1)).join(",") + ")";
  });
  await sql.query(
    "INSERT INTO public.uxd_llm_calls (request_id,gateway,role,provider,model,ok,http_status,latency_ms,prompt_tokens,completion_tokens,total_tokens,error,attempt,stream,cooldown_until) VALUES "
      + rows.join(","),
    values,
  );
}

/** Per-model usage for routing: last 60 s, today (UTC), 24 h success and latency, active cooldown. */
export async function readModelUsage(): Promise<ModelUsage[]> {
  const sql = await sqlClient();
  if (!sql) return [];
  const rows = await sql.query(
    `SELECT provider, model,
       count(*) FILTER (WHERE at > now() - interval '60 seconds')::int AS last_minute,
       count(*) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')::int AS today,
       coalesce(sum(total_tokens) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'), 0)::bigint AS tokens_today,
       count(*)::int AS calls_24h,
       count(*) FILTER (WHERE ok)::int AS ok_24h,
       coalesce(avg(latency_ms) FILTER (WHERE ok), 0)::int AS avg_latency_ms,
       max(cooldown_until) AS cooldown_until
     FROM public.uxd_llm_calls
     WHERE gateway = 'uxd' AND at > now() - interval '24 hours'
     GROUP BY provider, model`,
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    provider: String(row.provider),
    model: String(row.model),
    lastMinute: Number(row.last_minute) || 0,
    today: Number(row.today) || 0,
    tokensToday: Number(row.tokens_today) || 0,
    calls24h: Number(row.calls_24h) || 0,
    ok24h: Number(row.ok_24h) || 0,
    avgLatencyMs: Number(row.avg_latency_ms) || 0,
    ...(row.cooldown_until ? { cooldownUntil: new Date(String(row.cooldown_until)).getTime() } : {}),
  }));
}

export type CallStats = {
  window: string;
  totals: { calls: number; ok: number; tokens: number; avgLatencyMs: number };
  models: Array<{
    gateway: string; provider: string; model: string; calls: number; ok: number; errors: number;
    promptTokens: number; completionTokens: number; totalTokens: number; p50LatencyMs: number; p95LatencyMs: number;
    lastAt: string; lastError?: string;
  }>;
  roles: Array<{ role: string; calls: number; ok: number; topModel: string }>;
  recent: Array<{ at: string; gateway: string; role: string; provider: string; model: string; ok: boolean; status: number; latencyMs: number; tokens: number; error?: string }>;
};

/** Analytics for the backend's Models view. */
export async function readCallStats(hours: number): Promise<CallStats> {
  const sql = await sqlClient();
  const window = Math.max(1, Math.min(24 * 30, Math.round(hours))) + "h";
  if (!sql) return { window, totals: { calls: 0, ok: 0, tokens: 0, avgLatencyMs: 0 }, models: [], roles: [], recent: [] };
  const interval = Math.max(1, Math.min(24 * 30, Math.round(hours))) + " hours";
  const [models, roles, recent] = await Promise.all([
    sql.query(
      `SELECT gateway, provider, model, count(*)::int AS calls, count(*) FILTER (WHERE ok)::int AS ok,
         coalesce(sum(prompt_tokens),0)::bigint AS prompt_tokens, coalesce(sum(completion_tokens),0)::bigint AS completion_tokens,
         coalesce(sum(total_tokens),0)::bigint AS total_tokens,
         coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok),0)::int AS p50,
         coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok),0)::int AS p95,
         max(at) AS last_at,
         (array_agg(error ORDER BY at DESC) FILTER (WHERE NOT ok))[1] AS last_error
       FROM public.uxd_llm_calls WHERE at > now() - $1::interval
       GROUP BY gateway, provider, model ORDER BY calls DESC LIMIT 200`, [interval]),
    sql.query(
      `SELECT role, count(*)::int AS calls, count(*) FILTER (WHERE ok)::int AS ok,
         mode() WITHIN GROUP (ORDER BY provider || '/' || model) FILTER (WHERE ok) AS top_model
       FROM public.uxd_llm_calls WHERE at > now() - $1::interval GROUP BY role ORDER BY calls DESC LIMIT 50`, [interval]),
    sql.query(
      `SELECT at, gateway, role, provider, model, ok, http_status, latency_ms, total_tokens, error
       FROM public.uxd_llm_calls ORDER BY at DESC LIMIT 100`),
  ]) as Array<Array<Record<string, unknown>>>;
  const modelRows = models.map((row) => ({
    gateway: String(row.gateway), provider: String(row.provider), model: String(row.model),
    calls: Number(row.calls) || 0, ok: Number(row.ok) || 0, errors: (Number(row.calls) || 0) - (Number(row.ok) || 0),
    promptTokens: Number(row.prompt_tokens) || 0, completionTokens: Number(row.completion_tokens) || 0, totalTokens: Number(row.total_tokens) || 0,
    p50LatencyMs: Number(row.p50) || 0, p95LatencyMs: Number(row.p95) || 0,
    lastAt: new Date(String(row.last_at)).toISOString(),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  }));
  const calls = modelRows.reduce((sum, row) => sum + row.calls, 0);
  const ok = modelRows.reduce((sum, row) => sum + row.ok, 0);
  const latencyWeight = modelRows.reduce((sum, row) => sum + row.p50LatencyMs * row.ok, 0);
  return {
    window,
    totals: { calls, ok, tokens: modelRows.reduce((sum, row) => sum + row.totalTokens, 0), avgLatencyMs: ok ? Math.round(latencyWeight / ok) : 0 },
    models: modelRows,
    roles: roles.map((row) => ({ role: String(row.role || "default"), calls: Number(row.calls) || 0, ok: Number(row.ok) || 0, topModel: String(row.top_model || "") })),
    recent: recent.map((row) => ({
      at: new Date(String(row.at)).toISOString(), gateway: String(row.gateway), role: String(row.role || ""), provider: String(row.provider), model: String(row.model),
      ok: Boolean(row.ok), status: Number(row.http_status) || 0, latencyMs: Number(row.latency_ms) || 0, tokens: Number(row.total_tokens) || 0,
      ...(row.error ? { error: String(row.error) } : {}),
    })),
  };
}
