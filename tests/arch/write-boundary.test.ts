// @vitest-environment node
// Keeps Moodle writes in one place (src/server/moodle/write.ts) and out of
// reach of anything that runs without her: sync, jobs and cron.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");

const WRITE = "src/server/moodle/write.ts";
const HER_TAP = "src/server/moodle/her-tap.ts";
const WRITE_STRINGS = ["upload.php", "mod_assign_save_submission", "mod_assign_submit_for_grading"];

/** Files that may contain the write strings although they are not write.ts, and why. */
const STRING_ALLOWLIST: { match: (file: string) => boolean; why: string }[] = [
  { match: (f) => /\.test\.tsx?$/.test(f), why: "tests are not app code; they check the strings are sent" },
  { match: (f) => f === "src/server/moodle/fake-inline.ts", why: "the in-process fake answers these calls, it never makes them" },
];

/** Folders whose code runs without her (sync, background jobs, cron routes). */
const UNATTENDED = ["src/server/sync/", "src/server/jobs/", "src/app/api/cron/"];

/** The only files that may import her-tap: write.ts checks taps, confirm.ts makes them. Tests too. */
const HER_TAP_IMPORTERS = [WRITE, "src/server/handin/confirm.ts"];

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Every code file under `dir`, as a path relative to the repo with forward slashes. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (CODE.test(e.name)) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

/** The src files `file` imports (relative and `@/` imports; packages are skipped). */
function importsOf(file: string, text: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPEC)) {
    const spec = m[1];
    let target: string;
    if (spec.startsWith("@/")) target = "src/" + spec.slice(2);
    else if (spec.startsWith(".")) target = relative(ROOT, resolve(ROOT, dirname(file), spec)).split(sep).join("/");
    else continue;
    const hit = EXTS.map((x) => target + x).find((t) => known.has(t));
    if (hit) out.push(hit);
  }
  return out;
}

/** Every way `files` (path → text) break the write boundary. Empty means clean. */
function writeBoundaryViolations(files: Map<string, string>): string[] {
  const problems: string[] = [];
  const known = new Set(files.keys());
  const graph = new Map<string, string[]>();
  for (const [file, text] of files) graph.set(file, importsOf(file, text, known));

  for (const [file, text] of files) {
    if (file === WRITE || STRING_ALLOWLIST.some((a) => a.match(file))) continue;
    for (const s of WRITE_STRINGS) if (text.includes(s)) problems.push(`${file} contains "${s}"; only ${WRITE} may`);
  }

  for (const [file, deps] of graph) {
    if (deps.includes(HER_TAP) && !HER_TAP_IMPORTERS.includes(file) && !/\.test\.tsx?$/.test(file)) {
      problems.push(`${file} imports ${HER_TAP}; only ${HER_TAP_IMPORTERS.join(" and ")} may`);
    }
  }

  // Unattended code must not reach write.ts or her-tap.ts, directly or through other files.
  for (const start of files.keys()) {
    if (!UNATTENDED.some((d) => start.startsWith(d))) continue;
    const from = new Map<string, string>([[start, ""]]);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift()!;
      for (const dep of graph.get(at) ?? []) {
        if (from.has(dep)) continue;
        from.set(dep, at);
        if (dep === WRITE || dep === HER_TAP) {
          const chain = [dep];
          for (let p = at; p; p = from.get(p)!) chain.unshift(p);
          problems.push(`${start} runs without her but imports ${dep}: ${chain.join(" -> ")}`);
        } else {
          queue.push(dep);
        }
      }
    }
  }
  return problems;
}

function readSrc(): Map<string, string> {
  return new Map(walk(SRC).map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
}

describe("write boundary", () => {
  it("keeps Moodle writes in write.ts, and out of sync, jobs and cron", () => {
    const files = readSrc();
    expect(files.has(WRITE)).toBe(true);
    expect(writeBoundaryViolations(files)).toEqual([]);
  });

  it("catches each kind of break", () => {
    const files = readSrc();
    files.set("src/server/sync/pull.ts", 'import { submitForGrading } from "../moodle/write";\n');
    files.set("src/server/jobs/nightly.ts", 'import { herTapFromConfirmCode } from "@/server/moodle/her-tap";\n');
    files.set("src/app/api/cron/tick/route.ts", 'import { go } from "../../../../server/helper";\n');
    files.set("src/server/helper.ts", 'export const go = () => import("./moodle/write");\n');
    files.set("src/server/other.ts", 'const fn = "mod_assign_submit_for_grading";\n');
    const found = writeBoundaryViolations(files).join("\n");
    expect(found).toContain("src/server/sync/pull.ts runs without her but imports src/server/moodle/write.ts");
    expect(found).toContain("src/server/jobs/nightly.ts runs without her but imports src/server/moodle/her-tap.ts");
    expect(found).toContain(
      "src/app/api/cron/tick/route.ts -> src/server/helper.ts -> src/server/moodle/write.ts",
    );
    expect(found).toContain('src/server/other.ts contains "mod_assign_submit_for_grading"');
    expect(found).toContain("src/server/jobs/nightly.ts imports src/server/moodle/her-tap.ts; only");
  });
});
