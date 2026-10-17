import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { listBlobPathnames, readBlobJson, writeBlobJson } from "@/src/storage/vercel-blob-json";

const ACTIVITY_KEY = "ux-direct-connection-status/chatgpt/last-activity.json";
const BRIDGE_PREFIX = "ux-direct-bridge/sessions/";
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

export async function recordChatGPTActivity(): Promise<void> {
  const activity: ChatGPTActivity = { lastActivityAt: new Date().toISOString() };
  await writeBlobJson(ACTIVITY_KEY, activity);
}

export async function getChatGPTConnectionStatus(now = Date.now()) {
  const activity = await readBlobJson<ChatGPTActivity>(ACTIVITY_KEY);
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
  const keys = (await listBlobPathnames(BRIDGE_PREFIX))
    .filter((key) => key.endsWith("/session.json"))
    .slice(0, 100);

  const sessions = await Promise.all(keys.map(async (key): Promise<PluginSession | null> => {
    try {
      const session = await readBlobJson<PluginSession>(key);
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
