import type { MetadataRoute } from "next";

// M7-06: lets her "Add to Home Screen" and open Ready without browser bars.
// Served at /manifest.webmanifest; Next adds the <link rel="manifest"> itself.
// The icons are the cap (src/components/vitonen.tsx) on cream, made once from
// that drawing. Cream is the light `--paper` token, oklch(0.972 0.012 85),
// as sRGB hex.
const CREAM = "#f9f5ed";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ready",
    short_name: "Ready",
    description: "Know if you'll be ready. Start studying in 10 seconds.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: CREAM,
    theme_color: CREAM,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
