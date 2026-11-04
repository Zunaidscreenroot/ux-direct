import { NextResponse } from "next/server";
import { z } from "zod";
import { bytesToBase64, generateImage, removeImageBackground } from "@/src/figma-agent/image-services";
import { isAllowedPluginOrigin, pluginCorsHeaders, pluginOptions } from "@/src/figma-agent/route-cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return pluginOptions(request);
}

const MAX_INPUT_BASE64 = 12_000_000;

/** Image quick tasks: generate an image for a shape's exact aspect ratio, or remove an image's background. */
export async function POST(request: Request) {
  const headers = pluginCorsHeaders(request);
  if (!isAllowedPluginOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("generate"),
      prompt: z.string().trim().min(3).max(1500),
      width: z.number().min(8).max(10000),
      height: z.number().min(8).max(10000),
    }).strict(),
    z.object({
      action: z.literal("remove-background"),
      imageBase64: z.string().min(16).max(MAX_INPUT_BASE64),
    }).strict(),
  ]).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Image task input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  try {
    const result = parsed.data.action === "generate"
      ? await generateImage(parsed.data.prompt, parsed.data.width, parsed.data.height)
      : await removeImageBackground(parsed.data.imageBase64);
    return NextResponse.json({
      ok: true, action: parsed.data.action, provider: result.provider, mime: result.mime,
      width: result.width, height: result.height, notes: result.notes, imageBase64: bytesToBase64(result.bytes),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error instanceof Error ? error.message : error).slice(0, 800) }, { status: 502, headers });
  }
}
