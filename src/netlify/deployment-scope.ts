/** Keep preview state separate from production state across rebuilds. */
export function netlifyDeploymentScope(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const branch = (env.NETLIFY_BRANCH || env.BRANCH || "").trim().toLowerCase();
  if (env.CONTEXT === "production") return "production";
  if (branch) return `branch-${branch.replace(/[^a-z0-9_-]+/g, "-")}`;
  return "local";
}
