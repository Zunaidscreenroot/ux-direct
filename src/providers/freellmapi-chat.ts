export type ChatPromptMessage = { role: "user" | "assistant"; content: string };
export type ChatPromptLimits = { maxMessages?: number; maxTotalChars?: number; maxMessageChars?: number };

function trimPromptContent(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 24) return value.slice(-limit);
  const marker = "\n[context trimmed]\n";
  const payloadLength = limit - marker.length;
  const headLength = Math.ceil(payloadLength * 0.72);
  const tailLength = payloadLength - headLength;
  return value.slice(0, headLength) + marker + value.slice(-tailLength);
}

/** Keep a bounded recent conversation window while preserving the newest user input. */
export function compactRecentMessages(
  messages: ChatPromptMessage[],
  limits: ChatPromptLimits = {},
): ChatPromptMessage[] {
  const maxMessages = Math.max(1, Math.min(20, Math.floor(limits.maxMessages ?? 14)));
  const maxTotalChars = Math.max(1000, Math.min(24000, Math.floor(limits.maxTotalChars ?? 22000)));
  const maxMessageChars = Math.max(500, Math.min(8000, Math.floor(limits.maxMessageChars ?? 6000)));
  const recent = messages.slice(-maxMessages);
  const selected: ChatPromptMessage[] = [];
  let totalChars = 0;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const remaining = maxTotalChars - totalChars;
    if (remaining <= 0) break;
    const limit = Math.min(maxMessageChars, remaining);
    const content = trimPromptContent(recent[index].content, limit);
    if (!content.trim()) continue;
    selected.push({ role: recent[index].role, content });
    totalChars += content.length;
  }
  return selected.reverse();
}

/** Returns true only for non-empty assistant text in a complete OpenAI-compatible SSE data line. */
export function hasAssistantTextDelta(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return false;

  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return false;
    const choices = (parsed as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return false;
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : {};
    const message = choice.message && typeof choice.message === "object"
      ? choice.message as Record<string, unknown>
      : {};
    const content = delta.content ?? message.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (typeof part === "string") return part.trim().length > 0;
      if (!part || typeof part !== "object") return false;
      const item = part as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0;
    });
  } catch {
    return false;
  }
}
