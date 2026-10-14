/**
 * Netlify Blobs are site-wide by default, so a write from a Deploy Preview can
 * otherwise affect the same keys read by production. Suffix non-production
 * store names with the Netlify deploy context and review ID to isolate testing.
 */
export function scopedNetlifyStoreName(
  baseName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const context = (env.CONTEXT || "").trim();
  if (!context || context === "production") return baseName;

  let suffix: string;
  if (context === "deploy-preview") {
    const reviewId = (env.REVIEW_ID || "shared").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "shared";
    suffix = "preview-" + reviewId;
  } else if (context === "branch-deploy") {
    const branch = (env.BRANCH || "shared").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 12) || "shared";
    suffix = "branch-" + branch;
  } else {
    suffix = context.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 18) || "nonprod";
  }
  const maxBaseLength = 64 - 1 - suffix.length;
  return baseName.slice(0, Math.max(1, maxBaseLength)) + "-" + suffix;
}
