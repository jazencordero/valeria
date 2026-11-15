import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Content-Security-Policy, the "Without Nonces" variant from
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.
//
// What is relaxed, and why:
// - script-src 'unsafe-inline': Next.js writes small inline <script> tags
//   (the RSC payload and bootstrap). The strict alternative is a per-request
//   nonce, but that forces every page to render dynamically and the docs say
//   it is incompatible with the prerendered static shell that cacheComponents
//   uses. So no nonce for now (ticket M1-44 "Cut").
// - style-src 'unsafe-inline': React and Next.js set inline style attributes.
// - Dev only: script-src 'unsafe-eval' (React uses eval for better error
//   stacks in development; not needed in production) and connect-src ws:
//   (the hot-reload websocket). Neither is in the production header.
// Not relaxed: fonts load only from this site (layout.tsx uses no Google
// Fonts; next/font self-hosts anyway), and the browser connects only to this
// site, never to Moodle or AI providers directly.
// If client-side WebAssembly is added later (e.g. sql.js in the browser),
// script-src will also need 'wasm-unsafe-eval'.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Camera only for this site (the QR scan); every other feature is off.
const permissionsPolicy = [
  "camera=(self)",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "midi=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "display-capture=()",
  "browsing-topics=()",
].join(", ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: permissionsPolicy },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  // PGlite (the local database when DATABASE_URL is unset) loads its WASM and
  // data files relative to its own module URL. Bundled into Server Components
  // under `next dev` that URL breaks ("path" argument ... Received an instance
  // of URL), so load it with Node's own require instead (M1-46).
  serverExternalPackages: ["@electric-sql/pglite"],
  // Hand-in files (up to 4 MB, M1 Cut) travel through a server action, whose
  // body is capped at 1 MB by default. 4.5 MB leaves room for the multipart
  // overhead and matches Vercel's own 4.5 MB request limit (M1-47).
  experimental: {
    serverActions: {
      bodySizeLimit: "4.5mb",
    },
  },
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // This checkout only. Without it Turbopack picks the nearest folder above with a
    // lockfile; for a git worktree under .claude/worktrees that is the main checkout,
    // so it watched every worktree and each file another session wrote made every
    // open dev page rebuild and reload (199 loads of /home in 20 s, M1-51).
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
