import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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

// The fake AI (tests/fake-ai/server.ts): started by tests/e2e/global-setup.ts on this port,
// called by the dev server below, scripted by the tests. The address is always this machine's.
const fakeAiPort = (process.env.PLAYWRIGHT_FAKE_AI_PORT ??= freePort());
const fakeAiUrl = (process.env.AI_FAKE_URL = `http://127.0.0.1:${fakeAiPort}`);

// A `.env.local` made by `vercel env pull` carries VERCEL* names, and the router ignores
// AI_FAKE_URL wherever one of those has a value (so the switch is dead on every deploy). The
// test server is not a deploy: every VERCEL* name is passed to it blank, which also stops Next
// from loading it from an env file (a name already in the environment is never overwritten).
// The names come from the env files Next would load (names only: the values are never kept,
// printed or passed on) and from the shell, with the list below as a fallback.
const VERCEL_NAMES = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_SKEW_PROTECTION_ENABLED",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_GIT_PROVIDER",
  "VERCEL_GIT_REPO_SLUG",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_ID",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "VERCEL_GIT_PREVIOUS_SHA",
  "VERCEL_GIT_PULL_REQUEST_ID",
];

/** The VERCEL* variable names an env file sets. Only the names are taken from each line. */
function vercelNamesIn(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(__dirname, file), "utf8");
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = /^\s*(?:export\s+)?(VERCEL[\w.-]*)\s*[=:]/.exec(line)?.[1];
    if (name) names.push(name);
  }
  return names;
}

const notOnVercel = Object.fromEntries(
  [
    ...VERCEL_NAMES,
    ...Object.keys(process.env).filter((name) => name.startsWith("VERCEL")),
    ...[".env.development.local", ".env.local", ".env.development", ".env"].flatMap(vercelNamesIn),
  ].map((name) => [name, ""]),
);

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
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
    // The whole-flow tests run against the pretend Moodle. The fallback seal value is a
    // test value for this throwaway local server, not a secret.
    //
    // AI: every call goes to the fake AI. The provider "keys" are made-up words, set here so the
    // router picks the providers and so a real key from the shell or .env.local is never used in
    // a test run (values given here win over the .env files). They exist only in the environment
    // of this throwaway `next dev`; nothing here is read by `next build`, `next start` or Vercel,
    // and the router ignores AI_FAKE_URL on any Vercel deploy and in production anyway.
    env: {
      ...(process.env as Record<string, string>),
      MOODLE_FAKE: "1",
      KEY_SEAL_SECRET: process.env.KEY_SEAL_SECRET ?? "e2e-only-not-a-secret",
      AI_FAKE_URL: fakeAiUrl,
      GROQ_API_KEY: "e2e-fake-groq",
      OPENROUTER_API_KEY: "e2e-fake-openrouter",
      CLOUDFLARE_API_TOKEN: "e2e-fake-cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "e2e-fake-account",
      ...notOnVercel,
    },
  },
});
