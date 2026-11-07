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

/**
 * Knowledge-base edits change what every model is told, so they are never open to the internet:
 * - with UX_DIRECT_COMMAND_CENTER_KEY set, the same key unlocks edits;
 * - without it, edits need UX_DIRECT_KB_EDIT_OPEN=1 (owner opt-in for the open command center).
 */
export function knowledgeEditState(request: Request): { allowed: boolean; reason?: string } {
  if (isCommandCenterConfigured()) {
    return isCommandCenterAuthorized(request) ? { allowed: true } : { allowed: false, reason: "Enter the command center access key to edit knowledge." };
  }
  if ((process.env.UX_DIRECT_KB_EDIT_OPEN || "").trim() === "1") return { allowed: true };
  return { allowed: false, reason: "Knowledge editing is locked. Set the Worker secret UX_DIRECT_COMMAND_CENTER_KEY (16+ characters) and enter it here, or set UX_DIRECT_KB_EDIT_OPEN=1." };
}
