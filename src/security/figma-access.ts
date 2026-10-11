/**
 * Fail-closed Figma access boundary.
 *
 * Workspace names are labels, not authorization. Figma operations must be
 * scoped to explicitly allowlisted file keys. An empty allowlist denies all.
 */
export const ALLOWED_WORKSPACE_LABEL = "zunaid_workspace";

export type FigmaAccessConfig = {
  allowedFileIds: string[];
  allowedWorkspaceLabel?: string;
};

export type FigmaAccessDecision =
  | { allowed: true; fileId: string; workspaceLabel: string }
  | { allowed: false; reason: "allowlist_empty" | "file_not_allowlisted" | "workspace_mismatch" };

export function parseAllowedFileIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

export function authorizeFigmaFile(
  fileId: string,
  workspaceLabel: string,
  config: FigmaAccessConfig,
): FigmaAccessDecision {
  const allowedIds = new Set(config.allowedFileIds);
  if (allowedIds.size === 0) return { allowed: false, reason: "allowlist_empty" };
  if (workspaceLabel !== (config.allowedWorkspaceLabel ?? ALLOWED_WORKSPACE_LABEL)) {
    return { allowed: false, reason: "workspace_mismatch" };
  }
  if (!allowedIds.has(fileId)) return { allowed: false, reason: "file_not_allowlisted" };
  return { allowed: true, fileId, workspaceLabel };
}

/** Call before every read or write adapter operation. Never infer access from selection alone. */
export function assertFigmaFileAccess(
  fileId: string,
  workspaceLabel: string,
  config: FigmaAccessConfig,
): void {
  const decision = authorizeFigmaFile(fileId, workspaceLabel, config);
  if (!decision.allowed) {
    throw new Error(`Figma access denied: ${decision.reason}`);
  }
}
