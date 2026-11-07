import { pluginOptions } from "@/src/figma-agent/route-cors";
import { recordQuickTask } from "@/src/memory/task-run-log";
import { handleIconTask } from "@/src/figma-agent/icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return pluginOptions(request);
}

/**
 * Icon quick task: resolves icon queries ("credit card", or a button label like "Pay now") to sanitized
 * Lucide SVGs from Iconify's free public API. No model call. The plugin turns each SVG into native
 * vector layers with createNodeFromSvg, so the plugin manifest needs no extra network domain.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const response = await handleIconTask(request, (url) => fetch(url, { headers: { Accept: "image/svg+xml, application/json" } }));
  recordQuickTask("icon", startedAt, response);
  return response;
}
