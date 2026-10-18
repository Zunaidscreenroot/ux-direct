import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/.well-known/oauth-authorization-server", destination: "/api/mcp/oauth/metadata/authorization-server" },
        { source: "/.well-known/oauth-protected-resource/api/mcp", destination: "/api/mcp/oauth/metadata/protected-resource" },
        { source: "/.well-known/oauth-protected-resource", destination: "/api/mcp/oauth/metadata/protected-resource" },
      ],
    };
  },
};

export default nextConfig;
