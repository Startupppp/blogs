import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const r2Origin = (() => {
  try {
    return process.env.R2_ENDPOINT ? new URL(process.env.R2_ENDPOINT).origin : "";
  } catch {
    return "";
  }
})();

/**
 * The admin is private: never indexed, never framed, and its CSP only lets the browser talk to
 * this origin and the R2 S3 endpoint (for presigned uploads). Draft images come through the
 * authenticated proxy on this origin; published images from the public media domain.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${process.env.MEDIA_PUBLIC_ORIGIN ?? ""} https://lh3.googleusercontent.com`,
  `connect-src 'self' ${r2Origin} https://*.r2.cloudflarestorage.com${dev ? " ws:" : ""}`,
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["sharp"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
          ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
