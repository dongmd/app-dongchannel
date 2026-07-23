import type { NextConfig } from "next";

// Standalone output chỉ bật khi deploy (tránh Windows symlink issue).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(process.env.NEXT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  typedRoutes: true,
  serverExternalPackages: ["postgres"],
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    const baseHeaders = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      // AC02 — CSP. 'unsafe-inline' script cần cho Next.js hydration; style thì OK để có Tailwind inline.
      // 'unsafe-eval' cần cho dev-mode HMR (bỏ khi prod thật cần optimize).
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'" + (isProd ? "" : " 'unsafe-eval'"),
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https://*.googleusercontent.com",
          "font-src 'self' data:",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self' https://accounts.google.com",
        ].join("; "),
      },
    ];
    if (isProd) {
      baseHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      });
    }
    return [{ source: "/(.*)", headers: baseHeaders }];
  },
};

export default nextConfig;
