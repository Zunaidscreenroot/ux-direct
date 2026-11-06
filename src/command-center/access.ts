import { timingSafeEqual } from "node:crypto";

/**
 * The command center is OPEN by default (owner decision, 2026-11-06).
 * Optional lock: set the Worker secret UX_DIRECT_COMMAND_CENTER_KEY (16+ chars); the
 * browser then sends it in the X-UXD-Command-Key header after the owner enters it once.
 */
export const COMMAND_CENTER_KEY_HEADER = "x-uxd-command-key";
const MIN_KEY_LENGTH = 16;

function configuredKey(): string {
  return (process.env.UX_DIRECT_COMMAND_CENTER_KEY || "").trim();
}

export function isCommandCenterConfigured(): boolean {
  return configuredKey().length >= MIN_KEY_LENGTH;
}

export function isCommandCenterAuthorized(request: Request): boolean {
  const expected = configuredKey();
  if (!expected) return true; // Open mode: no key configured.
  if (expected.length < MIN_KEY_LENGTH) return false;
  const supplied = (request.headers.get(COMMAND_CENTER_KEY_HEADER) || "").trim();
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function commandCenterLockedResponse(): Response {
  const configured = isCommandCenterConfigured();
  return Response.json(
    {
      error: configured
        ? "Command center access key is missing or wrong."
        : "UX_DIRECT_COMMAND_CENTER_KEY is set but shorter than 16 characters; lengthen or remove it.",
      locked: true,
      configured,
    },
    { status: configured ? 401 : 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
  );
}
