export type FreeLLMModel = { id: string; name?: string; vision: boolean; reasoning: boolean; tools: boolean; contextWindow: number | null };

const trimSlash = (value: string) => value.replace(/\/+$/, "");
export function freeLlmBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return trimSlash(env.FREELLMAPI_BASE_URL?.trim() || "http://127.0.0.1:3001/v1");
}
export function freeLlmApiKey(env: Record<string, string | undefined> = process.env): string {
  return env.FREELLMAPI_API_KEY?.trim() || "";
}
export function inferFreeLlmCapabilities(id: string, raw: Record<string, unknown> = {}): FreeLLMModel {
  const text = id.toLowerCase();
  const metadata = JSON.stringify(raw).toLowerCase();
  const context = Number(raw.context_length ?? raw.context_window ?? raw.contextLength ?? 0);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    vision: /vision|visual|multimodal|image|vl-|4v|llava|pixtral|gemini|gpt-4o|glm.*v|4\.6v|4\.5v/.test(text) || /vision|image input|multimodal/.test(metadata),
    reasoning: /reason|thinking|deepseek-r1|glm|kimi|qwen3|qwq|o1|o3|o4|nemotron|deepseek-v/.test(text) || /reasoning|thinking/.test(metadata),
    tools: /tool.call|function.call|tool_calling|supports_tools|tools.*true/.test(metadata),
    contextWindow: Number.isFinite(context) && context > 0 ? context : null,
  };
}
export async function getFreeLlmModels(options: { timeoutMs?: number } = {}): Promise<FreeLLMModel[]> {
  const key = freeLlmApiKey();
  if (!key) throw new Error("FREELLMAPI_API_KEY is not configured on the UX Direct Worker.");
  const response = await fetch(freeLlmBaseUrl() + "/models", {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  if (!response.ok) throw new Error("FreeLLMAPI model catalog returned HTTP " + response.status + ".");
  const payload = await response.json() as { data?: unknown[]; models?: unknown[] };
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
    return id && id.length <= 200 ? [inferFreeLlmCapabilities(id, raw)] : [];
  });
}
export async function resolveFreeLlmModel(id: string, capability?: "vision" | "reasoning" | "tools"): Promise<FreeLLMModel> {
  if (!id || id.length > 200) throw new Error("A valid FreeLLMAPI model ID is required.");
  const models = await getFreeLlmModels();
  const model = models.find((entry) => entry.id === id);
  if (!model) throw new Error("Selected model is not present in the current FreeLLMAPI catalog: " + id);
  if (capability && !model[capability]) throw new Error("Selected model is not marked as " + capability + "-capable: " + id);
  return model;
}
