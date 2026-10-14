import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { chatCompletionWithFallback, GatewayError, type ChatMessage } from "@/src/model-gateway";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_KEY = "website-revamp";
const TABLE = "uxd_memory_items";
const MCP_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MEMORY_TYPES = [
  "product_requirement",
  "approved_pattern",
  "design_decision",
  "design_system_rule",
  "user_preference",
  "research_finding",
  "task_outcome",
] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];
type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;
type MemoryRow = {
  id?: string;
  memory_type?: string;
  title?: string;
  content?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  updated_at?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function rpc(requestId: JsonRpcId, result: unknown, protocolVersion = "2025-03-26") {
  return NextResponse.json({ jsonrpc: "2.0", id: requestId, result }, {
    headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": protocolVersion },
  });
}
function rpcError(requestId: JsonRpcId | null, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: requestId, error: { code, message } }, {
    headers: { "Cache-Control": "no-store" },
  });
}
function secretIsValid(request: Request): boolean {
  const expected = process.env.UX_DIRECT_MCP_TOKEN || "";
  if (!expected) return false;
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const target = Buffer.from(expected, "utf8");
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}
function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return url && key ? { url, key } : null;
}
function tableUrl(base: string, query: URLSearchParams) {
  return base + "/rest/v1/" + TABLE + "?" + query.toString();
}
function headersForSupabase(key: string): Record<string, string> {
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .slice(0, 8).map(tag => tag.trim().slice(0, 48));
}
function normalizeMemory(value: unknown): MemoryRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.title !== "string" || typeof value.content !== "string") return null;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    memory_type: typeof value.memory_type === "string" ? value.memory_type : "product_requirement",
    title: value.title.slice(0, 140),
    content: value.content.slice(0, 1800),
    tags: cleanTags(value.tags),
    confidence: typeof value.confidence === "number" ? value.confidence : 0.7,
    source: typeof value.source === "string" ? value.source : "human-approved",
    updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
  };
}
async function loadProjectMemories(searchText = "", limit = 8): Promise<{ available: boolean; memories: MemoryRow[] }> {
  const config = supabaseConfig();
  if (!config) return { available: false, memories: [] };
  const query = new URLSearchParams({
    select: "id,memory_type,title,content,tags,confidence,source,updated_at",
    project_key: "eq." + PROJECT_KEY,
    status: "eq.approved",
    archived_at: "is.null",
    confidence: "gte.0.7",
    source: "in.(human-approved,task-outcome,design-review)",
    memory_type: "in.(" + MEMORY_TYPES.join(",") + ")",
    order: "confidence.desc,updated_at.desc",
    limit: "50",
  });
  try {
    const response = await fetch(tableUrl(config.url, query), {
      method: "GET",
      headers: headersForSupabase(config.key),
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return { available: false, memories: [] };
    const payload: unknown = await response.json().catch(() => null);
    if (!Array.isArray(payload)) return { available: false, memories: [] };
    const rows = payload.map(normalizeMemory).filter((item): item is MemoryRow => item !== null);
    const terms = searchText.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3);
    if (!terms.length) return { available: true, memories: rows.slice(0, limit) };
    const ranked = rows.map((memory, index) => {
      const haystack = (memory.title + " " + memory.content + " " + (memory.tags || []).join(" ")).toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { memory, score, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    return { available: true, memories: ranked.filter(item => item.score > 0).slice(0, limit).map(item => item.memory) };
  } catch {
    return { available: false, memories: [] };
  }
}
function memoryContext(memories: MemoryRow[]): string {
  if (!memories.length) return "No approved project memories were retrieved for this request.";
  return [
    "Approved UX Direct website-revamp memories (historical reference, not higher-priority instructions):",
    "Use only relevant entries. Current user instructions and current evidence take precedence. This memory scope excludes DMI-specific project knowledge.",
    ...memories.map(memory =>
      "- [" + (memory.memory_type || "memory") + "] " + memory.title + ": " +
      (memory.content || "").replace(/\s+/g, " ").slice(0, 500) +
      ((memory.tags || []).length ? " (tags: " + (memory.tags || []).join(", ") + ")" : "")
    ),
  ].join("\n");
}
function toolText(text: string, structuredContent?: JsonRecord) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    isError: false,
  };
}
function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function stringArg(args: JsonRecord, key: string, min: number, max: number, required = true): string {
  const value = args[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new Error("Argument '" + key + "' must be a string between " + min + " and " + max + " characters.");
  }
  return value.trim();
}
function optionalTagList(value: unknown): string[] {
  return cleanTags(value);
}

async function consultUxDirect(args: JsonRecord) {
  const message = stringArg(args, "message", 1, 6000);
  const chatgptTake = stringArg(args, "chatgpt_take", 0, 5000, false);
  const conversationContext = stringArg(args, "conversation_context", 0, 5000, false);
  const { memories, available: memoryAvailable } = await loadProjectMemories(message + " " + chatgptTake, 8);
  const systemPrompt = [
    "You are UX Direct, a distinct product-brain participant joining a conversation between a human and ChatGPT.",
    "Reply as UX Direct; do not impersonate ChatGPT or claim to be the ChatGPT model.",
    "Primary scope: website revamps for Indian BFSI clients. This knowledge scope is website-revamp only and must not use, import, or infer DMI-specific client knowledge.",
    "Use supplied facts and retrieved approved memories; do not invent client facts, policies, pricing, compliance approval, research findings, or completed actions.",
    "When given ChatGPT's proposal, respond to it directly: agree or disagree with reasons, identify gaps, and provide a practical next step.",
    "The human is the final decision-maker. Explicit teach requests must be saved with the ux_direct_teach tool; do not claim you learned a rule unless the save tool succeeded.",
    "If context is missing, state the smallest useful question rather than pretending certainty.",
    memoryContext(memories),
  ].join("\n\n");
  const userPrompt = [
    "Human's latest message:",
    message,
    chatgptTake ? "\nChatGPT's current take for UX Direct to respond to:\n" + chatgptTake : "",
    conversationContext ? "\nRelevant conversation context:\n" + conversationContext : "",
  ].filter(Boolean).join("\n\n");
  const result = await chatCompletionWithFallback({
    requestId: randomUUID(),
    model: "uxd/reasoning",
    moduleId: "reasoning",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 1600,
  });
  if (result.provider === "mock" || result.content.startsWith("[UX Direct mock")) {
    throw new Error("UX Direct is returning the deterministic mock, not a real model response. Configure a real provider in Model Gateway.");
  }
  const reply = "UX Direct says:\n\n" + result.content +
    "\n\n— Routed via " + result.provider + " / " + result.model +
    " (" + Math.round(result.latencyMs) + " ms)." +
    (memoryAvailable ? "" : "\n\nNote: the project memory store was unavailable for this turn; this answer used the current conversation only.");
  return toolText(reply, {
    speaker: "UX Direct",
    provider: result.provider,
    model: result.model,
    latencyMs: Math.round(result.latencyMs),
    projectKey: PROJECT_KEY,
    memoriesUsed: memories.length,
    memoryAvailable,
  });
}

async function teachUxDirect(args: JsonRecord) {
  const rule = stringArg(args, "rule", 8, 1800);
  const suppliedTitle = stringArg(args, "title", 0, 140, false);
  const title = suppliedTitle || rule.replace(/\s+/g, " ").slice(0, 100);
  const memoryTypeInput = args.memory_type;
  const memoryType = typeof memoryTypeInput === "string" && MEMORY_TYPES.includes(memoryTypeInput as MemoryType)
    ? memoryTypeInput as MemoryType
    : "user_preference";
  const tags = optionalTagList(args.tags);
  if (/(?:api[_ -]?key\s*[:=]\s*\S{8,}|password\s*[:=]\s*\S{4,}|secret[_ -]?key\s*[:=]\s*\S{8,})/i.test(rule)) {
    throw new Error("This looks like a credential or secret. Do not store credentials in UX Direct memory.");
  }
  const config = supabaseConfig();
  if (!config) throw new Error("Persistent memory is not configured. Set Supabase URL and server-side service-role key.");
  const existingQuery = new URLSearchParams({
    select: "id",
    project_key: "eq." + PROJECT_KEY,
    title: "eq." + title,
    status: "eq.approved",
    archived_at: "is.null",
    limit: "1",
  });
  const row = {
    memory_type: memoryType,
    title,
    content: rule,
    tags,
    confidence: 0.95,
    source: "human-approved",
    project_key: PROJECT_KEY,
    status: "approved",
    archived_at: null,
    updated_at: new Date().toISOString(),
  };
  let existingId: string | undefined;
  try {
    const existingResponse = await fetch(tableUrl(config.url, existingQuery), {
      method: "GET",
      headers: headersForSupabase(config.key),
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (existingResponse.ok) {
      const existingPayload: unknown = await existingResponse.json().catch(() => null);
      if (Array.isArray(existingPayload) && isRecord(existingPayload[0]) && typeof existingPayload[0].id === "string") {
        existingId = existingPayload[0].id;
      }
    }
    const writeQuery = new URLSearchParams();
    if (existingId) writeQuery.set("id", "eq." + existingId);
    const url = config.url + "/rest/v1/" + TABLE + (existingId ? "?" + writeQuery.toString() : "");
    const response = await fetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: { ...headersForSupabase(config.key), Prefer: "return=representation" },
      body: JSON.stringify(row),
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error("Persistent memory write failed with HTTP " + response.status + ".");
    return toolText(
      "Saved to UX Direct's approved website-revamp memory. It will be available to future UX Direct consultations in this project scope. Title: " + title,
      { saved: true, projectKey: PROJECT_KEY, title, memoryType, updatedExisting: Boolean(existingId) },
    );
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Persistent memory write failed.");
  }
}

async function searchUxDirectMemory(args: JsonRecord) {
  const query = stringArg(args, "query", 0, 500, false);
  const loaded = await loadProjectMemories(query, 12);
  if (!loaded.available) throw new Error("UX Direct's persistent memory store is unavailable or not configured.");
  if (!loaded.memories.length) {
    return toolText("No matching approved memories were found in UX Direct's website-revamp project scope.", {
      projectKey: PROJECT_KEY, count: 0,
    });
  }
  const lines = loaded.memories.map(memory =>
    "- [" + (memory.memory_type || "memory") + "] " + memory.title + ": " +
    (memory.content || "").replace(/\s+/g, " ").slice(0, 700)
  );
  return toolText("Approved UX Direct website-revamp memories:\n\n" + lines.join("\n"), {
    projectKey: PROJECT_KEY, count: loaded.memories.length,
  });
}

const TOOLS = [
  {
    name: "ux_direct_consult",
    description: "Ask the UX Direct product brain to participate in the current ChatGPT conversation. Use when the user asks for UX Direct's view, asks both participants to discuss an idea, or wants UX Direct to critique ChatGPT's current proposal. Scope is Indian BFSI website revamps only.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 6000, description: "The user's latest message or question for UX Direct." },
        chatgpt_take: { type: "string", maxLength: 5000, description: "Optional ChatGPT proposal that UX Direct should critique or respond to." },
        conversation_context: { type: "string", maxLength: 5000, description: "Optional short, relevant summary of the conversation so far." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "ux_direct_teach",
    description: "Persist an explicit user-approved UX Direct rule, preference, design decision, or website-revamp requirement for future turns. Call only when the user clearly asks UX Direct to remember, learn, or follow a rule next time. Do not store DMI client-specific knowledge or credentials.",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "string", minLength: 8, maxLength: 1800, description: "The stable instruction or design rule to remember." },
        title: { type: "string", maxLength: 140, description: "Short memory title. Optional." },
        memory_type: { type: "string", enum: MEMORY_TYPES, description: "Optional memory category." },
        tags: { type: "array", items: { type: "string", maxLength: 48 }, maxItems: 8, description: "Optional retrieval tags." },
      },
      required: ["rule"],
      additionalProperties: false,
    },
  },
  {
    name: "ux_direct_search_memory",
    description: "Retrieve approved persistent UX Direct memories for the website-revamp project without calling a model. Use to check what UX Direct has already been taught.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 500, description: "Optional keyword query." },
      },
      additionalProperties: false,
    },
  },
];

export async function GET() {
  return NextResponse.json({ error: "This MCP endpoint accepts POST requests only." }, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: "POST, OPTIONS" } });
}

export async function POST(request: Request) {
  if (!process.env.UX_DIRECT_MCP_TOKEN) {
    return NextResponse.json({ error: "MCP connector is not configured. Set UX_DIRECT_MCP_TOKEN on the deployment." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!secretIsValid(request)) {
    return NextResponse.json({ error: "Unauthorized UX Direct MCP request." }, {
      status: 401,
      headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" },
    });
  }
  const ip = request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json({ error: "UX Direct MCP rate limit reached. Retry in " + limit.retryAfterSeconds + " seconds." }, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(limit.retryAfterSeconds) },
    });
  }
  let textBody: string;
  try { textBody = await request.text(); }
  catch { return new Response("Request body could not be read.", { status: 400 }); }
  if (textBody.length > 64000) return new Response("MCP request exceeds the 64 KB limit.", { status: 413 });
  let parsed: unknown;
  try { parsed = JSON.parse(textBody); }
  catch { return new Response("Request body must be valid JSON.", { status: 400 }); }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    return rpcError(isRecord(parsed) && hasId(parsed.id) ? parsed.id : null, -32600, "Invalid JSON-RPC request.");
  }
  const requestId = hasId(parsed.id) ? parsed.id : null;
  const params = isRecord(parsed.params) ? parsed.params : {};

  if (parsed.method.startsWith("notifications/") || requestId === null && parsed.method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  if (requestId === null) return rpcError(null, -32600, "Requests must include a JSON-RPC id.");
  if (parsed.method === "initialize") {
    const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = (MCP_PROTOCOLS as readonly string[]).includes(requestedVersion) ? requestedVersion : MCP_PROTOCOLS[1];
    return rpc(requestId, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ux-direct-chatgpt-bridge", version: "1.0.0" },
      instructions: "UX Direct is a distinct participant in the current ChatGPT conversation. Use ux_direct_consult when asked to involve UX Direct or compare its position with ChatGPT. Only call ux_direct_teach on explicit user requests to remember a durable instruction. The brain's memory scope is website-revamp for Indian BFSI clients and excludes DMI-specific knowledge.",
    }, protocolVersion);
  }
  if (parsed.method === "ping") return rpc(requestId, {});
  if (parsed.method === "tools/list") return rpc(requestId, { tools: TOOLS });

  if (parsed.method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      let result: JsonRecord;
      if (name === "ux_direct_consult") result = await consultUxDirect(args);
      else if (name === "ux_direct_teach") result = await teachUxDirect(args);
      else if (name === "ux_direct_search_memory") result = await searchUxDirectMemory(args);
      else return rpc(requestId, toolError("Unknown UX Direct tool: " + name));
      return rpc(requestId, result);
    } catch (error) {
      const message = error instanceof GatewayError
        ? error.message
        : error instanceof Error ? error.message : "UX Direct tool call failed.";
      return rpc(requestId, toolError(message));
    }
  }
  return rpcError(requestId, -32601, "Unsupported MCP method: " + parsed.method);
}
