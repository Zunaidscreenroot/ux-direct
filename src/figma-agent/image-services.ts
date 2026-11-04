import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Free image services for the Figma quick tasks, all reached from the Worker so the
 * plugin's network allowlist stays a single domain:
 * - Generation: Cloudflare Workers AI (FLUX.1 schnell, inside the free daily allocation),
 *   falling back to Pollinations (free, no key) when the AI binding is missing or out of quota.
 * - Exact sizing and background removal: the Cloudflare Images binding
 *   (`fit: "cover"` crop and `segment: "foreground"`, free tier 5,000 transformations/month).
 */

type ImagesTransformer = {
  transform(options: Record<string, unknown>): ImagesTransformer;
  output(options: { format: string; quality?: number }): Promise<{ response(): Response }>;
};
type ImagesBinding = { input(stream: ReadableStream): ImagesTransformer };
type AiBinding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

export type ImageResult = { bytes: Uint8Array; mime: string; provider: string; width: number | null; height: number | null; notes: string[] };

const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MAX_SIDE = 2048;

function env(): Record<string, unknown> {
  try {
    return getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}
function imagesBinding(): ImagesBinding | null {
  const candidate = env().IMAGES as Partial<ImagesBinding> | undefined;
  return candidate && typeof candidate.input === "function" ? candidate as ImagesBinding : null;
}
function aiBinding(): AiBinding | null {
  const candidate = env().AI as Partial<AiBinding> | undefined;
  return candidate && typeof candidate.run === "function" ? candidate as AiBinding : null;
}
function streamOf(bytes: Uint8Array): ReadableStream {
  return new Response(bytes as unknown as BodyInit).body as ReadableStream;
}
function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/^data:[^,]*;base64,/, ""), "base64"));
}

/** Output pixel size: the shape's aspect ratio at 2x for sharpness, longest side capped at 2048. */
export function targetImageSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(2, MAX_SIDE / Math.max(w, h));
  return { width: Math.max(64, Math.round(w * scale)), height: Math.max(64, Math.round(h * scale)) };
}

/** Adds composition guidance for the frame's aspect ratio and keeps stray text out of the picture. */
export function enrichImagePrompt(prompt: string, width: number, height: number): string {
  const ratio = width / Math.max(1, height);
  const composition = ratio >= 1.6 ? "wide landscape composition with the subject centred and room on the sides"
    : ratio <= 0.7 ? "tall portrait composition with the subject centred"
    : "balanced, centred composition";
  const wantsText = /\b(text|words?|lettering|typography|logo|caption|label)\b/i.test(prompt);
  return [prompt.trim(), composition, "high quality, sharp focus, professional lighting", wantsText ? "" : "no text, no watermark, no UI elements"]
    .filter(Boolean).join(", ").slice(0, 1800);
}

async function cropToSize(bytes: Uint8Array, width: number, height: number, notes: string[]): Promise<{ bytes: Uint8Array; mime: string; exact: boolean }> {
  const images = imagesBinding();
  if (!images) {
    notes.push("Exact crop skipped (Images binding unavailable); Figma's Fill mode crops it to the shape.");
    return { bytes, mime: "image/jpeg", exact: false };
  }
  try {
    const result = await images.input(streamOf(bytes)).transform({ width, height, fit: "cover", gravity: "auto" }).output({ format: "image/jpeg", quality: 88 });
    return { bytes: new Uint8Array(await result.response().arrayBuffer()), mime: "image/jpeg", exact: true };
  } catch (error) {
    notes.push("Exact crop failed (" + String(error instanceof Error ? error.message : error).slice(0, 120) + "); Figma's Fill mode crops it to the shape.");
    return { bytes, mime: "image/jpeg", exact: false };
  }
}

async function generateWithWorkersAi(prompt: string): Promise<Uint8Array> {
  const ai = aiBinding();
  if (!ai) throw new Error("Workers AI binding is not configured.");
  const model = String(env().UXD_IMAGE_MODEL || DEFAULT_IMAGE_MODEL);
  const output = await ai.run(model, { prompt, steps: 8 }) as Record<string, unknown> | ReadableStream | null;
  if (output && typeof (output as Record<string, unknown>).image === "string") return base64ToBytes((output as { image: string }).image);
  if (output instanceof ReadableStream) return new Uint8Array(await new Response(output).arrayBuffer());
  throw new Error("Workers AI returned no image.");
}

async function generateWithPollinations(prompt: string, width: number, height: number): Promise<Uint8Array> {
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    "?width=" + width + "&height=" + height + "&nologo=true&model=flux&seed=" + Math.floor(Math.random() * 1_000_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "image/*", "User-Agent": "UX-Direct-Figma-Plugin" } });
    if (!response.ok || !String(response.headers.get("content-type") || "").startsWith("image/")) {
      throw new Error("Pollinations returned HTTP " + response.status + ".");
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function generateImage(prompt: string, frameWidth: number, frameHeight: number): Promise<ImageResult> {
  const size = targetImageSize(frameWidth, frameHeight);
  const fullPrompt = enrichImagePrompt(prompt, frameWidth, frameHeight);
  const notes: string[] = [];
  const order = String(env().UXD_IMAGE_PROVIDERS || "workers-ai,pollinations").split(",").map((item) => item.trim()).filter(Boolean);
  for (const provider of order) {
    try {
      const raw = provider === "workers-ai" ? await generateWithWorkersAi(fullPrompt)
        : provider === "pollinations" ? await generateWithPollinations(fullPrompt, size.width, size.height)
        : null;
      if (!raw) continue;
      const cropped = await cropToSize(raw, size.width, size.height, notes);
      return { bytes: cropped.bytes, mime: cropped.mime, provider, width: cropped.exact ? size.width : null, height: cropped.exact ? size.height : null, notes };
    } catch (error) {
      notes.push(provider + ": " + String(error instanceof Error ? error.message : error).slice(0, 160));
    }
  }
  throw new Error("No free image service produced an image. " + notes.join(" | "));
}

export async function removeImageBackground(imageBase64: string): Promise<ImageResult> {
  const images = imagesBinding();
  if (!images) throw new Error("The Cloudflare Images binding is not available on this Worker.");
  const input = base64ToBytes(imageBase64);
  if (input.length < 16) throw new Error("The image is empty.");
  const result = await images.input(streamOf(input)).transform({ segment: "foreground" }).output({ format: "image/png" });
  const response = result.response();
  if (!response.ok) throw new Error("Cloudflare Images returned HTTP " + response.status + ".");
  return { bytes: new Uint8Array(await response.arrayBuffer()), mime: "image/png", provider: "cloudflare-images-segment", width: null, height: null, notes: [] };
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
