import { NextResponse } from "next/server";
import { z } from "zod";
import { callFigmaJsonModel } from "@/src/figma-agent/json-model-call";
import { deterministicLayerNames, modelLayers, normalizeTextEdits } from "@/src/figma-agent/text-tasks";
import { isAllowedPluginOrigin, pluginCorsHeaders, pluginOptions } from "@/src/figma-agent/route-cors";
import { recordQuickTask } from "@/src/memory/task-run-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return pluginOptions(request);
}

const itemSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.string().max(40),
  name: z.string().max(200),
  text: z.string().max(5000).optional(),
  fontSize: z.number().optional(),
  parent: z.string().max(200).optional(),
  hint: z.string().max(300).optional(),
}).strict();

/**
 * Text quick tasks on the selected layers:
 * - "rewrite": improve, shorten, extend, translate or replace copy in text layers.
 * - "rename": give layers meaningful names from their content and role.
 * The model only returns {id, value} pairs; the plugin applies them with native update-node.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const response = await handleTextTask(request);
  recordQuickTask("text", startedAt, response);
  return response;
}

async function handleTextTask(request: Request): Promise<Response> {
  const headers = pluginCorsHeaders(request);
  if (!isAllowedPluginOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.object({
    mode: z.enum(["rewrite", "rename"]),
    prompt: z.string().trim().min(1).max(4000),
    items: z.array(itemSchema).min(1).max(150),
    screenName: z.string().max(200).optional(),
  }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Text task input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  const { mode, prompt, items } = parsed.data;
  if (mode === "rewrite" && items.length > 60) {
    return NextResponse.json({ error: "Select up to 60 text layers to rewrite at once." }, { status: 400, headers });
  }

  const system = mode === "rewrite"
    ? [
      "You edit UI copy inside Figma text layers.",
      "Apply the user's request to the given text layers. Keep each layer's role: a button stays a short action label, a title stays a title, a price or number stays exact unless the request asks to change it.",
      "Keep roughly the same length unless the request asks to shorten, expand or add content. Preserve the language unless asked to translate. Preserve line breaks that structure lists.",
      "Do not invent facts (prices, dates, names) that the request did not give. Realistic sample content is allowed only when the request asks for it.",
      "Do not change IDs, account or reference numbers, amounts, percentages or dates unless the request is about them, and do not add words that a nearby layer already shows.",
      "When the request is to make copy clearer or better, apply this rubric: plain everyday words over jargon or internal terms (say what a charge or status means for the user); alerts state the consequence and the action to take; keep titles and buttons verb-led or as short as the source, never turn a clear title into a vaguer noun phrase; one idea per line.",
      "A label above an amount names what the amount is (\"Overdue\" → \"Overdue amount\"). Leave the screen title and tab labels as they are unless the request names them; never make a tab, chip or button label noticeably longer.",
      "A change must change wording. Never return an edit that only adds or removes punctuation, capitalisation or spacing; leave that layer out instead.",
      "Only return layers whose text really changes. Refer to each layer by its ref (t1, t2, …) exactly as given.",
      'Return JSON only: {"summary": string, "updates": [{"ref": "t1", "text": "the new full text"}]}.',
    ].join("\n")
    : [
      "You name Figma layers the way a senior product designer would: short, purpose-based, Title Case, no numbering suffixes (e.g. Header, Price Row, Primary CTA, Avatar, Card / Loan Summary).",
      "Use the layer's type, its text and its children to infer its purpose. Keep names under 40 characters. Keep names that are already meaningful.",
      "Refer to each layer by its ref (t1, t2, …) exactly as given.",
      'Return JSON only: {"summary": string, "names": [{"ref": "t1", "name": "Primary CTA"}]}.',
    ].join("\n");

  const result = await callFigmaJsonModel({
    title: mode === "rewrite" ? "UX Direct Text Rewrite" : "UX Direct Layer Rename",
    origin: new URL(request.url).origin,
    hasVisionInput: false,
    role: "writer",
    maxTokens: mode === "rewrite" ? 3000 : 2500,
    temperature: mode === "rewrite" ? 0.5 : 0.2,
    system,
    user: JSON.stringify({ request: prompt, screen: parsed.data.screenName || "", layers: modelLayers(mode, items) }),
    accept: (data, raw) => normalizeTextEdits(mode, data, items, raw, prompt, parsed.data.screenName).length ? null : "returned no usable edits for the selected layers",
  });
  if (!result.ok) {
    // Renaming has a model-free fallback; rewriting copy does not.
    const fallback = mode === "rename" ? deterministicLayerNames(items) : [];
    if (fallback.length) {
      return NextResponse.json({ ok: true, mode, edits: fallback, model: "rule-based", summary: "The free model was unavailable, so default-named layers were named from their content and shape." }, { headers });
    }
    return NextResponse.json({
      error: mode === "rewrite"
        ? "The free model did not return a usable rewrite for these " + items.length + " text layer(s). Try again, or say exactly what the new text should be."
        : result.error,
      details: result.errors,
    }, { status: result.status, headers });
  }
  const edits = normalizeTextEdits(mode, result.data, items, result.raw, prompt, parsed.data.screenName);
  return NextResponse.json({
    ok: true, mode, edits, model: result.model,
    summary: typeof result.data.summary === "string" ? result.data.summary.slice(0, 400) : "",
  }, { headers });
}
