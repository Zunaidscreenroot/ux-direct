import { NextResponse } from "next/server";
import { z } from "zod";
import { callFigmaJsonModel } from "@/src/figma-agent/json-model-call";
import { normalizeTextEdits } from "@/src/figma-agent/text-tasks";
import { isAllowedPluginOrigin, pluginCorsHeaders, pluginOptions } from "@/src/figma-agent/route-cors";

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
      "Only return layers you actually change.",
      'Return JSON only: {"summary": string, "updates": [{"id": string, "text": string}]}.',
    ].join("\n")
    : [
      "You name Figma layers the way a senior product designer would: short, purpose-based, Title Case, no numbering suffixes (e.g. Header, Price Row, Primary CTA, Avatar, Card / Loan Summary).",
      "Use the layer's type, its text and its children to infer its purpose. Keep names under 40 characters. Keep names that are already meaningful.",
      'Return JSON only: {"summary": string, "names": [{"id": string, "name": string}]}.',
    ].join("\n");

  const result = await callFigmaJsonModel({
    title: mode === "rewrite" ? "UX Direct Text Rewrite" : "UX Direct Layer Rename",
    origin: new URL(request.url).origin,
    hasVisionInput: false,
    maxTokens: mode === "rewrite" ? 3000 : 2500,
    temperature: mode === "rewrite" ? 0.5 : 0.2,
    system,
    user: JSON.stringify({ request: prompt, screen: parsed.data.screenName || "", layers: items }),
    accept: (data) => normalizeTextEdits(mode, data, items).length ? null : "returned no valid edits for the selected layers",
  });
  if (!result.ok) return NextResponse.json({ error: result.error, details: result.errors }, { status: result.status, headers });
  const edits = normalizeTextEdits(mode, result.data, items);
  return NextResponse.json({
    ok: true, mode, edits, model: result.model,
    summary: typeof result.data.summary === "string" ? result.data.summary.slice(0, 400) : "",
  }, { headers });
}
