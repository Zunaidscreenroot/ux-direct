import { getStore } from "@netlify/blobs";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { netlifyDeploymentScope } from "@/src/netlify/deployment-scope";

const REGION = "us-east-2";
const ACTIVITY_STORE = "ux-direct-connection-status";
const activityKey = () => `${netlifyDeploymentScope()}/chatgpt/last-activity.json`;
const BRIDGE_STORE = "ux-direct-plugin-bridge";
const bridgePrefix = () => `ux-direct-bridge/${netlifyDeploymentScope()}/sessions/`;
export const CHATGPT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const FIGMA_ACTIVE_WINDOW_MS = 75 * 1000;

type ChatGPTActivity = { lastActivityAt: string };
type PluginSession = {
  clientId: string;
  fileKey: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
  connectedAt?: string;
};

function activityStore() {
  return getStore(ACTIVITY_STORE, { region: REGION, consistency: "strong" });
}
function bridgeStore() {
  return getStore(BRIDGE_STORE, { region: REGION, consistency: "strong" });
}

export async function recordChatGPTActivity(): Promise<void> {
  const activity: ChatGPTActivity = { lastActivityAt: new Date().toISOString() };
  await activityStore().set(activityKey(), JSON.stringify(activity), {
    metadata: { contentType: "application/json" },
  });
}

export async function getChatGPTConnectionStatus(now = Date.now()) {
  const store = activityStore();
  const key = activityKey();
  const index = await store.list({ prefix: key });
  if (!index.blobs.some((blob) => blob.key === key)) {
    return { state: "not_seen" as const, connected: false, lastActivityAt: null, ageMs: null };
  }
  const raw = await store.get(key, { type: "text" });
  let activity: ChatGPTActivity | null = null;
  try { activity = raw ? JSON.parse(raw) as ChatGPTActivity : null; } catch { activity = null; }
  const timestamp = activity?.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN;
  if (!Number.isFinite(timestamp)) {
    return { state: "not_seen" as const, connected: false, lastActivityAt: null, ageMs: null };
  }
  const ageMs = now - timestamp;
  const connected = ageMs >= 0 && ageMs <= CHATGPT_ACTIVE_WINDOW_MS;
  return {
    state: connected ? "connected" as const : "idle" as const,
    connected,
    lastActivityAt: activity!.lastActivityAt,
    ageMs,
  };
}

export async function getFigmaPluginConnectionStatus(clientId?: string, now = Date.now()) {
  const store = bridgeStore();
  const index = await store.list({ prefix: bridgePrefix() });
  const keys = index.blobs
    .map((blob) => blob.key)
    .filter((key) => key.endsWith("/session.json"))
    .slice(0, 100);
  const sessions = await Promise.all(keys.map(async (key): Promise<PluginSession | null> => {
    try {
      const raw = await store.get(key, { type: "text" });
      if (!raw) return null;
      const session = JSON.parse(raw) as PluginSession;
      if (!session || !isAllowedFigmaFileKey(session.fileKey) || typeof session.clientId !== "string") return null;
      return session;
    } catch {
      return null;
    }
  }));
  const validSessions = sessions.filter((session): session is PluginSession => session !== null);
  const isOnline = (session: PluginSession) => {
    const heartbeat = Date.parse(session.lastHeartbeatAt);
    const age = now - heartbeat;
    return session.status === "online" && Number.isFinite(heartbeat) && age >= 0 && age < FIGMA_ACTIVE_WINDOW_MS;
  };
  const online = validSessions.filter(isOnline).sort((a, b) => Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt));
  const current = clientId ? validSessions.find((session) => session.clientId === clientId) : undefined;
  const selected = clientId ? current : online[0];
  const connected = selected ? isOnline(selected) : (!clientId && online.length > 0);
  return {
    state: connected ? "connected" as const : "disconnected" as const,
    connected,
    connectedSessions: online.length,
    lastHeartbeatAt: selected?.lastHeartbeatAt ?? online[0]?.lastHeartbeatAt ?? null,
  };
}
