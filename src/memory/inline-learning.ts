export type InlineLearningCandidate = {
  title: string;
  normalizedRule: string;
  rationale: string;
  scopeKey: string;
  feedbackKind: string;
  keywords: string[];
  originalLanguage: string;
};

const OPEN = "<UXD_LEARNING>";
const CLOSE = "</UXD_LEARNING>";
const ALLOWED_SCOPES = new Set([
  "UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:ux-audit",
  "project:general-ux", "project:dmi-finance", "project:ujjivan-sfb", "project:express-computers",
]);
const ALLOWED_KINDS = new Set([
  "general", "false_positive", "missed_issue", "severity_calibration", "recommendation_quality",
  "duplicate_finding", "benchmarking", "scope", "visual_evidence", "accessibility",
  "interaction_logic", "design_system", "cost_optimization", "other",
]);

function containsSensitiveMaterial(value: string): boolean {
  return /\b(api[_ -]?key|password\s*[:=]|secret\s*[:=]|private key|recovery phrase|bearer\s+[A-Za-z0-9._-]{20,})\b/i.test(value)
    || /\b[A-Z]{5}\d{4}[A-Z]\b/i.test(value)
    || /\b[6-9]\d{9}\b/.test(value)
    || /\b\d{12,}\b/.test(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value);
}

export function sanitizeInlineLearningCandidate(parsed: unknown): InlineLearningCandidate | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const item = parsed as Record<string, unknown>;
  if (typeof item.title !== "string" || typeof item.normalizedRule !== "string" ||
      typeof item.scopeKey !== "string" || !ALLOWED_SCOPES.has(item.scopeKey)) return null;
  const title = item.title.trim().slice(0, 180);
  const normalizedRule = item.normalizedRule.trim().slice(0, 1600);
  const rationale = typeof item.rationale === "string" ? item.rationale.trim().slice(0, 1000) : "";
  const combined = [title, normalizedRule, rationale].join("\n");
  if (title.length < 8 || normalizedRule.length < 24 || containsSensitiveMaterial(combined)) return null;
  const feedbackKind = typeof item.feedbackKind === "string" && ALLOWED_KINDS.has(item.feedbackKind)
    ? item.feedbackKind : "general";
  const keywords = Array.isArray(item.keywords)
    ? [...new Set(item.keywords.filter((entry): entry is string => typeof entry === "string")
      .map(entry => entry.trim().toLowerCase()).filter(entry => entry.length > 0 && entry.length <= 64 && !containsSensitiveMaterial(entry)))].slice(0, 20)
    : [];
  const languageValue = typeof item.originalLanguage === "string" ? item.originalLanguage.trim().toLowerCase() : "english";
  const originalLanguage = languageValue === "hindi" ? "Hindi"
    : languageValue === "hinglish" ? "Hinglish"
    : languageValue === "mixed" ? "Mixed"
    : languageValue === "unknown" ? "unknown"
    : "English";
  return { title, normalizedRule, rationale, scopeKey: item.scopeKey, feedbackKind, keywords, originalLanguage };
}

export function parseInlineLearningCandidate(raw: string): InlineLearningCandidate | null {
  const value = raw.trim();
  if (!value || value.length > 5000) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  return sanitizeInlineLearningCandidate(parsed);
}

/** Prevent a model from copying a client name into a broader scope when the task did not name that client. */
export function referencesUnstatedClient(candidate: InlineLearningCandidate, context: string): boolean {
  const output = [candidate.title, candidate.normalizedRule, candidate.rationale, ...candidate.keywords].join(" ");
  const names: Array<{ pattern: RegExp; contextPattern: RegExp }> = [
    { pattern: /\b(ujjivan|ujjivan sfb|ujjivan small finance bank)\b/i, contextPattern: /\b(ujjivan|ujjivan sfb|ujjivan small finance bank)\b/i },
    { pattern: /\b(dmi|dmi hfc|dmi finance|dmi wealth)\b/i, contextPattern: /\b(dmi|dmi hfc|dmi finance|dmi wealth)\b/i },
    { pattern: /\bexpress computers\b/i, contextPattern: /\bexpress computers\b/i },
  ];
  return names.some(({ pattern, contextPattern }) => pattern.test(output) && !contextPattern.test(context));
}

/**
 * Strip the assistant's private learning marker from an OpenAI-compatible SSE
 * stream and expose only its validated compact candidate to the caller.
 */
export function createLearningMarkerTransform(
  onCandidate: (candidate: InlineLearningCandidate) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";
  let visiblePending = "";
  let inMarker = false;
  let markerBody = "";
  let markerOverflow = false;
  let candidateCaptured = false;

  function consumeText(input: string): string {
    let remaining = visiblePending + input;
    visiblePending = "";
    let visible = "";

    while (remaining.length > 0) {
      if (inMarker) {
        const closeIndex = remaining.indexOf(CLOSE);
        if (closeIndex < 0) {
          markerBody += remaining;
          if (markerBody.length > 5000) {
            markerOverflow = true;
            markerBody = markerBody.slice(0, 5000);
          }
          return visible;
        }
        markerBody += remaining.slice(0, closeIndex);
        if (markerBody.length > 5000) markerOverflow = true;
        if (!markerOverflow && !candidateCaptured) {
          const candidate = parseInlineLearningCandidate(markerBody);
          if (candidate) {
            candidateCaptured = true;
            onCandidate(candidate);
          }
        }
        inMarker = false;
        markerBody = "";
        markerOverflow = false;
        remaining = remaining.slice(closeIndex + CLOSE.length);
        continue;
      }

      const openIndex = remaining.indexOf(OPEN);
      if (openIndex >= 0) {
        visible += remaining.slice(0, openIndex);
        inMarker = true;
        markerBody = "";
        markerOverflow = false;
        remaining = remaining.slice(openIndex + OPEN.length);
        continue;
      }

      // Hold only a suffix that could be the start of the marker across chunks.
      let hold = Math.min(OPEN.length - 1, remaining.length);
      while (hold > 0 && !OPEN.startsWith(remaining.slice(-hold))) hold -= 1;
      visible += remaining.slice(0, remaining.length - hold);
      visiblePending = remaining.slice(remaining.length - hold);
      break;
    }
    return visible;
  }

  function processLine(line: string, controller: TransformStreamDefaultController<Uint8Array>) {
    if (!line.startsWith("data:")) {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(data); } catch {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    const frame = payload as Record<string, unknown>;
    const choices = Array.isArray(frame.choices) ? frame.choices : [];
    const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
    const delta = first?.delta && typeof first.delta === "object" ? first.delta as Record<string, unknown> : null;
    if (!delta) {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    if (typeof delta.content === "string") {
      delta.content = consumeText(delta.content);
    } else if (Array.isArray(delta.content)) {
      delta.content = delta.content.map((part) => {
        if (typeof part === "string") return consumeText(part);
        if (!part || typeof part !== "object" || Array.isArray(part)) return part;
        const textPart = part as Record<string, unknown>;
        return typeof textPart.text === "string" && (textPart.type === "text" || textPart.type === undefined)
          ? { ...textPart, text: consumeText(textPart.text) }
          : part;
      });
    } else {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    controller.enqueue(encoder.encode("data: " + JSON.stringify(frame) + "\n"));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      lineBuffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        let line = lineBuffer.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        lineBuffer = lineBuffer.slice(newline + 1);
        processLine(line, controller);
      }
    },
    flush(controller) {
      lineBuffer += decoder.decode();
      if (lineBuffer) processLine(lineBuffer, controller);
      // An incomplete private marker is discarded rather than shown to the user.
      if (!inMarker && visiblePending && !visiblePending.startsWith("<UXD_")) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: visiblePending } }] }) + "\n"));
      }
      visiblePending = "";
      markerBody = "";
    },
  });
}
