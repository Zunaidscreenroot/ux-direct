import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { listBlobPathnames, readBlobJson, vercelBlobNamespace } from "@/src/storage/vercel-blob-json";

const BRIDGE_PREFIX = vercelBlobNamespace("ux-direct-bridge") + "/sessions/";
const FIGMA_ACTIVE_WINDOW_MS = 75 * 1000;

type PluginSession = {
  clientId: string;
  fileKey: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
  connectedAt?: string;
};

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
