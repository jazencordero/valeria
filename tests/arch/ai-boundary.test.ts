// @vitest-environment node
// Keeps every AI call behind one doorway: only src/server/ai/ talks to the AI SDK and the router,
// and every route under src/app/api/ai/ is built with aiRoute (src/server/ai/doorway.ts).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const AI_DIR = "src/server/ai/";
const ROUTER = "src/server/ai/router.ts";
const DOORWAY = "src/server/ai/doorway.ts";
const AI_ROUTES = "src/app/api/ai/";

/** Folders scanned. tests/ is held to the same rule: a test outside AI goes through the doorway too. */
const SCANNED = ["src", "tests"];

/** Files outside src/server/ai/ that may import the AI SDK or the router anyway, and why. */
const ALLOWLIST: { match: (file: string) => boolean; why: string }[] = [
  { match: (f) => f.startsWith("tests/fake-ai/"), why: "the fake AI server stands in for the providers" },
  { match: (f) => f.startsWith("tests/arch/"), why: "arch tests hold forbidden imports as string fixtures" },
];

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "graphify-out"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (CODE.test(e.name)) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

/** True for the AI SDK: `ai`, `ai/<subpath>` and anything under `@ai-sdk/`. */
function isAiSdk(spec: string): boolean {
  return spec === "ai" || spec.startsWith("ai/") || spec.startsWith("@ai-sdk/");
}

/** Every import specifier in `text`, with a repo path for relative and `@/` ones. */
function importsOf(file: string, text: string, known: Set<string>): { spec: string; target: string | null }[] {
  const out: { spec: string; target: string | null }[] = [];
  for (const m of text.matchAll(SPEC)) {
    const spec = m[1];
    let base: string | null = null;
    if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
    else if (spec.startsWith(".")) base = relative(ROOT, resolve(ROOT, dirname(file), spec)).split(sep).join("/");
    const target = base === null ? null : (EXTS.map((x) => base + x).find((t) => known.has(t)) ?? null);
    out.push({ spec, target });
  }
  return out;
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

/** Every way `files` (path -> text) break the AI boundary. Empty means clean. */
function aiBoundaryViolations(files: Map<string, string>): string[] {
  const problems: string[] = [];
  const known = new Set(files.keys());

  for (const [file, text] of files) {
    const imports = importsOf(file, text, known);
    const outside = !file.startsWith(AI_DIR) && !ALLOWLIST.some((a) => a.match(file));
    if (outside) {
      for (const { spec, target } of imports) {
        if (isAiSdk(spec)) problems.push(`${file} imports the AI SDK ("${spec}"); only ${AI_DIR} may`);
        if (target === ROUTER) problems.push(`${file} imports ${ROUTER}; go through ${DOORWAY} (aiRoute)`);
      }
    }

    if (file.startsWith(AI_ROUTES) && !/\.test\.tsx?$/.test(file)) {
      const usesDoorway = imports.some((i) => i.target === DOORWAY) && /\baiRoute\s*\(/.test(text);
      if (!usesDoorway) problems.push(`${file} is under ${AI_ROUTES} but does not use aiRoute from ${DOORWAY}`);
      for (const method of METHODS) {
        const plain = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`);
        const wrapped = new RegExp(`export\\s+const\\s+${method}\\s*(?::[^=]+)?=\\s*aiRoute\\s*\\(`);
        const anyConst = new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\b`);
        if (plain.test(text) || (anyConst.test(text) && !wrapped.test(text))) {
          problems.push(`${file} exports ${method} without aiRoute`);
        }
      }
    }
  }
  return problems;
}

function readTree(): Map<string, string> {
  const files = SCANNED.flatMap((d) => walk(join(ROOT, d)));
  return new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
}

describe("AI boundary", () => {
  it("keeps the AI SDK and the router inside src/server/ai, and every AI route on aiRoute", () => {
    const files = readTree();
    expect(files.has(ROUTER)).toBe(true);
    expect(files.has(DOORWAY)).toBe(true);
    expect(files.has("src/app/api/ai/ping/route.ts")).toBe(true);
    expect(aiBoundaryViolations(files)).toEqual([]);
  });

  it("catches each kind of break", () => {
    const files = readTree();
    files.set("src/components/chat.tsx", 'import { generateText } from "ai";\n');
    files.set("src/server/study/plan.ts", 'const m = await import("@ai-sdk/openai-compatible");\n');
    files.set("src/app/page.tsx", 'import { runText } from "@/server/ai/router";\n');
    files.set("src/server/chat/thing.ts", 'import { streamChat } from "../ai/router";\n');
    files.set("tests/unit/x.test.ts", 'import { runText } from "../../src/server/ai/router";\n');
    files.set("src/app/api/ai/raw/route.ts", 'export async function POST() { return Response.json({}); }\n');
    files.set(
      "src/app/api/ai/half/route.ts",
      'import { aiRoute } from "@/server/ai/doorway";\nexport const POST = aiRoute(h, o);\nexport const GET = () => new Response();\n',
    );
    const found = aiBoundaryViolations(files).join("\n");
    expect(found).toContain('src/components/chat.tsx imports the AI SDK ("ai")');
    expect(found).toContain('src/server/study/plan.ts imports the AI SDK ("@ai-sdk/openai-compatible")');
    expect(found).toContain("src/app/page.tsx imports src/server/ai/router.ts");
    expect(found).toContain("src/server/chat/thing.ts imports src/server/ai/router.ts");
    expect(found).toContain("tests/unit/x.test.ts imports src/server/ai/router.ts");
    expect(found).toContain("src/app/api/ai/raw/route.ts is under src/app/api/ai/ but does not use aiRoute");
    expect(found).toContain("src/app/api/ai/raw/route.ts exports POST without aiRoute");
    expect(found).toContain("src/app/api/ai/half/route.ts exports GET without aiRoute");
    expect(found).not.toContain("half/route.ts exports POST");
    expect(found).not.toContain("half/route.ts is under");
  });

  it("lets src/server/ai and the fake AI server use the SDK", () => {
    const files = new Map([
      ["src/server/ai/router.ts", 'import { generateText } from "ai";\n'],
      ["src/server/ai/doorway.ts", 'import * as r from "./router";\n'],
      ["src/server/ai/router.test.ts", 'import { createRouter } from "./router";\n'],
      ["tests/fake-ai/server.ts", 'import type { ModelMessage } from "ai";\n'],
    ]);
    expect(aiBoundaryViolations(files)).toEqual([]);
  });
});
