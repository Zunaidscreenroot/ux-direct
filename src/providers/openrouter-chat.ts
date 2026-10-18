const FREE_MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*:free$/i;

export function isFreeModelId(value: unknown): value is string {
  return typeof value === "string" && FREE_MODEL_ID.test(value.trim());
}

export function collectFreeModelCandidates(
  primary: string,
  configuredModels: string[],
  discoveredModels: string[],
  maxCandidates = 3,
): string[] {
  const values = [
    primary,
    ...configuredModels.flatMap((value) => value.split(",")),
    ...discoveredModels,
  ];
  const unique: string[] = [];
  for (const value of values) {
    const model = typeof value === "string" ? value.trim() : "";
    if (isFreeModelId(model) && !unique.includes(model)) unique.push(model);
    if (unique.length >= Math.max(1, Math.min(3, Math.floor(maxCandidates)))) break;
  }
  return unique;
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
