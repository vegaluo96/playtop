import type { NextConfig } from "next";
import pkg from "./package.json";

/* 安全响应头(CSP 先 Report-Only:全站内联样式遍布,直接强制会白屏;P5 后续收紧) */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  {
    key: "Content-Security-Policy-Report-Only",
    value:
      "default-src 'self'; img-src 'self' data: https://media.api-sports.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
