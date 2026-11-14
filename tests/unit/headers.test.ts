// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Fetches "/" from the production build (next start) and checks the security
// headers from next.config.ts. Builds first if there is no build, or if the
// build is older than the files that define the headers and robots.txt.

const root = path.resolve(__dirname, "../..");
const nextBin = path.join(root, "node_modules/next/dist/bin/next");
const buildId = path.join(root, ".next/BUILD_ID");
const inputs = ["next.config.ts", "src/app/robots.ts"].map((f) => path.join(root, f));

let server: ChildProcess | undefined;
let baseUrl = "";
let serverLog = "";

function buildIsStale(): boolean {
  if (!existsSync(buildId)) return true;
  const builtAt = statSync(buildId).mtimeMs;
  return inputs.some((f) => existsSync(f) && statSync(f).mtimeMs > builtAt);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function stopServer() {
  if (!server || server.exitCode !== null || server.pid === undefined) return;
  try {
    // Negative pid: kill the whole process group (next start may fork).
    process.kill(-server.pid, "SIGKILL");
  } catch {
    server.kill("SIGKILL");
  }
}

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`next start exited early (code ${server?.exitCode}):\n${serverLog}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`next start did not answer within ${timeoutMs} ms:\n${serverLog}`);
}

beforeAll(async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };

  if (buildIsStale()) {
    const build = spawnSync(process.execPath, [nextBin, "build"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`next build failed; run \`npm run build\` to see why.\n${build.stdout}\n${build.stderr}`);
    }
  }

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  child.stdout?.on("data", (d) => (serverLog += d));
  child.stderr?.on("data", (d) => (serverLog += d));
  process.once("exit", stopServer);

  await waitForServer(`${baseUrl}/`, 60_000);
}, 300_000);

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server?.once("exit", r));
  stopServer();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
});

describe("security headers on the built app", () => {
  it("sends the five headers on /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const h = res.headers;

    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("x-frame-options")).toBe("DENY");

    const permissions = h.get("permissions-policy") ?? "";
    expect(permissions).toContain("camera=(self)");
    expect(permissions).toContain("microphone=()");
    expect(permissions).toContain("geolocation=()");

    const csp = h.get("content-security-policy") ?? "";
    const directives = Object.fromEntries(
      csp
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((parts) => parts[0])
        .map(([name, ...values]) => [name, values]),
    );
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["font-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(csp).not.toContain("unsafe-eval");
  });

  it("serves a robots.txt that disallows everything", async () => {
    const res = await fetch(`${baseUrl}/robots.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/User-Agent: \*/i);
    expect(text).toMatch(/^Disallow: \/$/m);
    expect(text).not.toMatch(/^Allow:/m);
  });
});
