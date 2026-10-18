import { getCloudflareContext } from "@opennextjs/cloudflare";

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};
type D1DatabaseBinding = { prepare(sql: string): D1Statement };

export function getCloudflareDatabase(): D1DatabaseBinding | null {
  try {
    const context = getCloudflareContext();
    const env = context.env as unknown as Record<string, unknown>;
    const db = env.UX_DIRECT_STATE as D1DatabaseBinding | undefined;
    if (db && typeof db.prepare === "function") return db;
  } catch {
    // Local Node.js development and legacy deployments do not expose Worker bindings.
  }
  return null;
}

export async function persistentGet(key: string): Promise<string | null> {
  const db = getCloudflareDatabase();
  if (!db) throw new Error("Cloudflare D1 binding UX_DIRECT_STATE is unavailable.");
  const row = await db.prepare("SELECT value FROM ux_direct_kv WHERE key = ? LIMIT 1")
    .bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function persistentPut(key: string, value: string): Promise<void> {
  const db = getCloudflareDatabase();
  if (!db) throw new Error("Cloudflare D1 binding UX_DIRECT_STATE is unavailable.");
  await db.prepare(
    "INSERT INTO ux_direct_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).bind(key, value).run();
}

export async function persistentList(prefix: string): Promise<string[]> {
  const db = getCloudflareDatabase();
  if (!db) throw new Error("Cloudflare D1 binding UX_DIRECT_STATE is unavailable.");
  const result = await db.prepare(
    "SELECT key FROM ux_direct_kv WHERE substr(key, 1, length(?)) = ? ORDER BY key LIMIT 10000"
  ).bind(prefix, prefix).all<{ key: string }>();
  return (result.results ?? []).map((row) => row.key);
}
