export type OperationalEvent = {
  id: string;
  at: string;
  source: "dashboard" | "figma-plugin" | "backend";
  event: string;
  status: "success" | "warning" | "error" | "info";
  summary: string;
  requestId?: string;
  project?: string;
  durationMs?: number;
  mode?: string;
  category?: string;
  action?: string;
  testType?: "availability" | "functional" | "not-tested";
};

const MAX_EVENTS = 100;
const runtimeEvents: OperationalEvent[] = [];

export function recordOperationalEvent(event: Omit<OperationalEvent, "id" | "at"> & { id?: string; at?: string }) {
  const normalized: OperationalEvent = {
    id: event.id ?? crypto.randomUUID(),
    at: event.at ?? new Date().toISOString(),
    source: event.source,
    event: event.event.slice(0, 80),
    status: event.status,
    summary: event.summary.slice(0, 240),
    requestId: event.requestId?.slice(0, 80),
    project: event.project?.slice(0, 80),
    durationMs: typeof event.durationMs === "number" ? Math.max(0, Math.round(event.durationMs)) : undefined,
    mode: event.mode?.slice(0, 40),
    category: event.category?.slice(0, 80),
    action: event.action?.slice(0, 120),
    testType: event.testType,
  };
  runtimeEvents.unshift(normalized);
  if (runtimeEvents.length > MAX_EVENTS) runtimeEvents.length = MAX_EVENTS;
  persistEvent(normalized);
  // Structured runtime logs also appear in the hosting platform's function logs.
  console.info("[ux-direct-event]", JSON.stringify(normalized));
  return normalized;
}

export function getOperationalEvents(limit = 30) {
  return runtimeEvents.slice(0, Math.max(1, Math.min(100, limit)));
}

const PERSIST_KEY = "ux-direct-events/recent.json";
const MAX_PERSISTED = 300;

/**
 * Best-effort durable copy in R2 so logs survive Worker isolate restarts. This is a read-modify-write
 * on one small object, so two simultaneous events can occasionally drop one; it is operational visibility,
 * not an audit trail. Failures are swallowed so logging can never break a request.
 */
function persistEvent(event: OperationalEvent) {
  const work = (async () => {
    try {
      const { readR2Json, writeR2Json } = await import("@/src/storage/r2-json-store");
      const existing = (await readR2Json<OperationalEvent[]>(PERSIST_KEY)) ?? [];
      await writeR2Json(PERSIST_KEY, [event, ...existing].slice(0, MAX_PERSISTED));
    } catch {
      // R2 unavailable (local dev, tests); the in-memory ring still has the event.
    }
  })();
  void (async () => {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      getCloudflareContext().ctx.waitUntil(work);
    } catch {
      // Not running on Workers.
    }
  })();
}

/** Persisted events merged with this isolate's memory, newest first, de-duplicated by id. */
export async function getRecentOperationalEvents(limit = 100): Promise<OperationalEvent[]> {
  const cap = Math.max(1, Math.min(300, Math.floor(limit)));
  let persisted: OperationalEvent[] = [];
  try {
    const { readR2Json } = await import("@/src/storage/r2-json-store");
    persisted = (await readR2Json<OperationalEvent[]>(PERSIST_KEY)) ?? [];
  } catch {
    persisted = [];
  }
  const byId = new Map<string, OperationalEvent>();
  for (const event of [...runtimeEvents, ...persisted]) if (event && typeof event.id === "string" && !byId.has(event.id)) byId.set(event.id, event);
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, cap);
}
