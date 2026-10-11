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
    mode: event.mode?.slice(0, 40),\n    category: event.category?.slice(0, 80),\n    action: event.action?.slice(0, 120),\n    testType: event.testType,
  };
  runtimeEvents.unshift(normalized);
  if (runtimeEvents.length > MAX_EVENTS) runtimeEvents.length = MAX_EVENTS;
  // Structured runtime logs also appear in Vercel's function logs.
  console.info("[ux-direct-event]", JSON.stringify(normalized));
  return normalized;
}

export function getOperationalEvents(limit = 30) {
  return runtimeEvents.slice(0, Math.max(1, Math.min(100, limit)));
}
