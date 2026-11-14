import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    // In-memory PGlite plus migrations can take several seconds when the whole suite runs in parallel.
    testTimeout: 30_000,
    // Each test file starts its own PGlite; dozens starting at once on a busy
    // machine starved each other past the old 30 s. Fewer at a time, more patience.
    hookTimeout: 120_000,
    maxWorkers: 4,
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}", "tests/arch/**/*.test.{ts,tsx}"],
  },
});
