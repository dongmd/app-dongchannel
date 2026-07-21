import type { NextConfig } from "next";

// Standalone output chỉ bật khi deploy (tránh Windows symlink issue trong local build).
// Prod build script trên Linux VPS: NEXT_STANDALONE=1 pnpm build
const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(process.env.NEXT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  typedRoutes: true,
  serverExternalPackages: ["postgres"],
  async headers() {
    const baseHeaders = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    // HSTS chỉ set trong production (localhost HTTP không nên bị pin HTTPS).
    if (process.env.NODE_ENV === "production") {
      baseHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      });
    }
    return [{ source: "/(.*)", headers: baseHeaders }];
  },
};

export default nextConfig;
