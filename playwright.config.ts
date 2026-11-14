import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

// Pick a free port once and share it with worker processes through the env.
function freePort(): string {
  return execFileSync(
    process.execPath,
    [
      "-e",
      "const s=require('net').createServer();s.listen(0,()=>{process.stdout.write(String(s.address().port));s.close()})",
    ],
    { encoding: "utf8" },
  ).trim();
}

const port = (process.env.PLAYWRIGHT_PORT ??= freePort());
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
