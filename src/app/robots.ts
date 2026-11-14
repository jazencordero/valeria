import type { MetadataRoute } from "next";

// Keep the app and every preview link out of search engines.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
