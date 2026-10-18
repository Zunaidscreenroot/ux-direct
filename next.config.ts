import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  poweredByHeader: false,
};

// Enable Cloudflare bindings in the local Next.js dev server.
initOpenNextCloudflareForDev();

export default nextConfig;
