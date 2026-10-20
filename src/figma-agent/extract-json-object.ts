type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUsefulResponseObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["issues", "findings", "defects", "problems", "patch", "summary", "assessment", "overallAssessment", "score", "qualityScore", "visualScore", "overallScore", "frame", "elements"].some((key) => key in value);
}

function parseJsonRecordText(text: string): JsonRecord | null {
  const cleaned = text.trim().replace(/^\uFEFF/, "");
  if (!cleaned) return null;

  const candidates = [
    cleaned,
    cleaned.replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "").trim(),
  ];
  for (const candidateText of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidateText);
      if (isUsefulResponseObject(parsed)) return parsed as JsonRecord;
      if (isRecord(parsed)) {
        const nested = extractJsonObject(parsed);
        if (nested) return nested;
      }
    } catch {
      // Continue with balanced-object extraction for preambles or fenced output.
    }
  }

  // Extract the first balanced JSON object, respecting quoted braces and escapes.
  for (let start = cleaned.indexOf("{"); start >= 0; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(cleaned.slice(start, index + 1));
            if (isUsefulResponseObject(parsed)) return parsed as JsonRecord;
          } catch {
            break;
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Parses arbitrary structured JSON responses from OpenRouter's compatible API.
 * Accepts plain JSON, fenced/prefixed JSON, parsed payloads, text content blocks,
 * and tool/function-call arguments. It intentionally does not assume a particular
 * task schema; each endpoint validates its own required fields after extraction.
 */
export function extractJsonObject(value: unknown): JsonRecord | null {
  if (typeof value === "string") return parseJsonRecordText(value);
  if (Array.isArray(value)) {
    for (const part of value) {
      const found = extractJsonObject(part);
      if (found) return found;
    }
    const joined = value
      .filter((part): part is JsonRecord => isRecord(part) && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
    return joined ? parseJsonRecordText(joined) : null;
  }
  if (!isRecord(value)) return null;
  if (isUsefulResponseObject(value)) return value;

  const functionRecord = isRecord(value.function) ? value.function : null;
  const candidates: unknown[] = [
    value.parsed,
    value.json,
    value.output,
    value.output_text,
    value.content,
    value.text,
    value.arguments,
    value.input,
    functionRecord?.arguments,
    ...(Array.isArray(value.tool_calls) ? value.tool_calls : []),
    value.message,
  ];
  for (const candidate of candidates) {
    const found = extractJsonObject(candidate);
    if (found) return found;
  }
  return null;
}
