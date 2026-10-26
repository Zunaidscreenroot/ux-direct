import type { BackendStatus } from "@/src/backend/status";

export type NodeHealth = "ok" | "warn" | "down" | "unknown";
export type GraphNode = {
  id: string; label: string; kind: string; health: NodeHealth; summary: string; detail: string;
  x: number; y: number; logMatch: { source?: string; action?: string; category?: string };
};
export type GraphEdge = { id: string; from: string; to: string; active: boolean };
export type LogEvent = {
  id: string; at: string; source: string; event: string; status: "success" | "warning" | "error" | "info";
  summary: string; durationMs?: number; category?: string; action?: string; mode?: string; requestId?: string;
};

export const NODE_W = 210;
export const NODE_H = 78;

/** Pure: turns the consolidated status payload into the n8n-style node graph. */
export function buildGraph(status: BackendStatus | null): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const selected = status?.providers.selected ?? "openrouter";
  const provider = (id: "openrouter" | "freellmapi") => status?.providers.options.find((option) => option.id === id);
  const providerNode = (id: "openrouter" | "freellmapi", label: string, x: number, y: number): GraphNode => {
    const info = provider(id);
    const health: NodeHealth = !info ? "unknown" : !info.configured ? "warn" : info.reachable === true ? "ok" : info.reachable === false ? "down" : "unknown";
    return {
      id, label, kind: "Model provider", health,
      summary: !info ? "Unknown" : !info.configured ? "Not configured" : info.reachable ? (selected === id ? "Active · reachable" : "Standby · reachable") : "Unreachable",
      detail: info ? info.description + ". " + info.detail : "No status yet.",
      x, y, logMatch: { action: id },
    };
  };
  const plugin = status?.plugin;
  const chat = status?.chatgpt;
  const nodes: GraphNode[] = [
    {
      id: "plugin", label: "Figma Plugin", kind: "Client", x: 20, y: 70,
      health: !status ? "unknown" : plugin?.connected ? "ok" : "down",
      summary: !status ? "Unknown" : plugin?.connected ? "Connected · " + plugin.sessions + " session" + (plugin.sessions === 1 ? "" : "s") : "No live session",
      detail: plugin?.lastHeartbeatAt ? "Last heartbeat " + plugin.lastHeartbeatAt : "No recent plugin heartbeat. Open the UX Direct plugin in Figma.",
      logMatch: { source: "figma-plugin" },
    },
    {
      id: "chatgpt", label: "ChatGPT · MCP", kind: "Client", x: 20, y: 310,
      health: !chat || chat.state === "unknown" ? "unknown" : chat.state === "connected" ? "ok" : "warn",
      summary: !chat ? "Unknown" : chat.state === "connected" ? "Active" : chat.state === "idle" ? "Idle" : chat.state === "not_seen" ? "Never seen" : "Unknown",
      detail: chat?.lastActivityAt ? "Last MCP request " + chat.lastActivityAt : "Supervisor and monitoring connection. Design requests do not depend on it.",
      logMatch: { category: "mcp" },
    },
    {
      id: "backend", label: "UX Direct Backend", kind: "Central brain", x: 320, y: 190,
      health: status ? "ok" : "unknown",
      summary: status ? "Online · " + status.backend.host : "Checking…",
      detail: "Cloudflare Workers. Routes design generation, chat, audits, memory and logs; the plugin bridge lives here.",
      logMatch: { source: "backend" },
    },
    {
      id: "brain", label: "Shared Knowledge Base", kind: "Memory", x: 320, y: 20,
      health: !status || status.brain.reachable === null ? "unknown" : status.brain.reachable ? "ok" : "down",
      summary: !status || status.brain.reachable === null ? "Not checked" : status.brain.reachable ? "Reachable" : "Unavailable",
      detail: "Approved UX Direct memories and patterns used as context for every design task.",
      logMatch: { category: "brain" },
    },
    {
      id: "audit", label: "UX Audit", kind: "Service", x: 320, y: 360,
      health: !status ? "unknown" : status.uxAudit.reachable ? "ok" : "down",
      summary: !status ? "Unknown" : status.uxAudit.reachable ? "Reachable" : "Unreachable",
      detail: "Audit tasks are routed here by UX Direct; the plugin does not talk to it directly.",
      logMatch: { category: "audit" },
    },
    {
      id: "router", label: "Model Router", kind: "Routing", x: 620, y: 190,
      health: !status ? "unknown" : provider(selected)?.reachable === true ? "ok" : provider(selected)?.configured === false ? "warn" : "down",
      summary: "Selected: " + (selected === "freellmapi" ? "FreeLLMAPI" : "OpenRouter"),
      detail: "Switch providers from the plugin's connection panel. OpenRouter uses auto with low cost and image-capable models; FreeLLMAPI uses auto.",
      logMatch: { category: "model" },
    },
    providerNode("openrouter", "OpenRouter", 910, 70),
    providerNode("freellmapi", "FreeLLMAPI", 910, 310),
  ];
  const edges: GraphEdge[] = [
    { id: "plugin-backend", from: "plugin", to: "backend", active: !!plugin?.connected },
    { id: "chatgpt-backend", from: "chatgpt", to: "backend", active: chat?.state === "connected" },
    { id: "backend-brain", from: "backend", to: "brain", active: status?.brain.reachable === true },
    { id: "backend-audit", from: "backend", to: "audit", active: status?.uxAudit.reachable === true },
    { id: "backend-router", from: "backend", to: "router", active: !!status },
    { id: "router-openrouter", from: "router", to: "openrouter", active: selected === "openrouter" },
    { id: "router-freellmapi", from: "router", to: "freellmapi", active: selected === "freellmapi" },
  ];
  return { nodes, edges };
}

/** Pure: cubic path between the closest facing ports of two nodes. */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) > Math.abs(dx)) {
    const down = dy > 0;
    const x1 = a.x + NODE_W / 2, y1 = a.y + (down ? NODE_H : 0);
    const x2 = b.x + NODE_W / 2, y2 = b.y + (down ? 0 : NODE_H);
    const k = Math.max(30, Math.abs(y2 - y1) / 2);
    return `M ${x1} ${y1} C ${x1} ${y1 + (down ? k : -k)}, ${x2} ${y2 + (down ? -k : k)}, ${x2} ${y2}`;
  }
  const right = dx > 0;
  const x1 = a.x + (right ? NODE_W : 0), y1 = a.y + NODE_H / 2;
  const x2 = b.x + (right ? 0 : NODE_W), y2 = b.y + NODE_H / 2;
  const k = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + (right ? k : -k)} ${y1}, ${x2 + (right ? -k : k)} ${y2}, ${x2} ${y2}`;
}

export function eventMatchesNode(event: LogEvent, match: GraphNode["logMatch"]): boolean {
  if (match.source && event.source === match.source && !match.category && !match.action) return true;
  if (match.action && (event.action === match.action || event.mode === match.action)) return true;
  if (match.category && event.category === match.category) return true;
  return false;
}
