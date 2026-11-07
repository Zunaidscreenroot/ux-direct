/**
 * Chat cannot touch the Figma canvas. Weak models still sometimes answer an edit request with
 * "Filled 4 values in 4 text layers" and invented before→after pairs. The system prompt forbids
 * it; this guard catches what slips through and appends a correction before the stream ends.
 */
const VERB = "(?:filled|changed|updated|applied|added|removed|deleted|replaced|renamed|re-?colou?red|recolou?red|created|moved|resized|set|swapped|inserted|aligned|fixed|edited|modified)";
const OBJECT = "(?:layers?|text(?:\\s+layers?)?|texts|values?|frames?|nodes?|canvas|buttons?|cards?|fills?|shadows?|colou?rs?|components?|instances?|screens?|rows?|fields?|labels?|icons?|images?|styles?|spacing|padding|font)";
const CLAIMS = [
  // "Filled 4 value(s) in 4 text layers", "Updated the button colour"
  new RegExp("(?:^|[\\n.!:>*-]\\s*|\\bI(?:'ve| have)?\\s+|\\bI\\s+)" + VERB + "\\s+(?:\\d+|the|all|your|a|an|this|these|each|every)\\b[^.\\n]{0,100}?\\b" + OBJECT + "\\b", "i"),
  // "Done! ... has been updated" / "was applied to the canvas"
  new RegExp("\\b(?:has|have)\\s+been\\s+" + VERB + "\\b[^.\\n]{0,60}\\b(?:canvas|layer|frame|figma)", "i"),
  new RegExp("\\b" + VERB + "\\b[^.\\n]{0,40}\\b(?:on|in|to)\\s+(?:the|your)\\s+(?:canvas|figma\\s+file|selected\\s+(?:frame|layer))", "i"),
];

export const CANVAS_CLAIM_NOTE = "\n\n_Note: this chat can't edit the canvas, so nothing above was changed in Figma. To apply it, ask for it as a direct edit with the layer selected (for example \"fill realistic data\" or \"add a soft shadow to the selected card\")._";

export function detectCanvasEditClaim(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return false;
  // Explicit suggestions/negations are fine: "I can't change the canvas", "you could update the button".
  return CLAIMS.some((pattern) => {
    const match = pattern.exec(value);
    if (!match) return false;
    const before = value.slice(Math.max(0, match.index - 40), match.index).toLowerCase().split(/\s+/).slice(-5).join(" ");
    return !/\b(can't|cannot|can|could|would|should|try|not|never|suggest|recommend|will|i'll|want|to)\b/.test(before);
  });
}

function deltaText(frame: Record<string, unknown>): string {
  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
  const delta = first?.delta && typeof first.delta === "object" ? first.delta as Record<string, unknown> : null;
  if (!delta) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content.map((part) => typeof part === "string" ? part
      : part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : "").join("");
  }
  return "";
}

/** SSE transform: passes frames through, holds [DONE], and appends the correction when the answer claimed a canvas edit. */
export function createCanvasClaimGuard(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let text = "";
  const held: string[] = [];
  const handle = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data === "[DONE]") { held.push(line); return; }
      if (text.length < 20000) {
        try { const parsed: unknown = JSON.parse(data); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) text += deltaText(parsed as Record<string, unknown>); } catch { /* not JSON */ }
      }
    }
    controller.enqueue(encoder.encode(line + "\n"));
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        handle(line, controller);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) handle(buffer, controller);
      if (detectCanvasEditClaim(text)) {
        controller.enqueue(encoder.encode("\ndata: " + JSON.stringify({ choices: [{ delta: { content: CANVAS_CLAIM_NOTE } }] }) + "\n\n"));
      }
      for (const line of held) controller.enqueue(encoder.encode(line + "\n\n"));
    },
  });
}
