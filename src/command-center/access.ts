import { timingSafeEqual } from "node:crypto";

/**
 * The command center lists shared-brain knowledge and plugin activity, so it is
 * locked behind an owner key (Worker secret UX_DIRECT_COMMAND_CENTER_KEY).
 * The browser sends it in the X-UXD-Command-Key header after the owner enters it once.
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
        : "Command center is locked until the UX_DIRECT_COMMAND_CENTER_KEY Worker secret is set (16+ characters).",
      locked: true,
      configured,
    },
    { status: configured ? 401 : 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
  );
}
