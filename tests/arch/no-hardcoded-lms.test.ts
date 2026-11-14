// @vitest-environment node
// No screen names an LMS itself (M5-01). Screens take `lmsName` as a prop and
// get it from `lmsNameOf(user)` in src/lib/schools.ts, so a LUT student never
// reads "MyCourses". This scans src/components and src/app for the word.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCANNED = ["src/components", "src/app"];
const WORD = /\bMyCourses\b/;
const CODE = /\.(ts|tsx)$/;

/**
 * Files that still say "MyCourses" today, when this test was written. Each is
 * owned by another ticket and must be fixed there (take the name from the
 * `lmsName` prop or `lmsNameOf`); that ticket then removes its line here. The
 * test fails when a listed file no longer has the word, so this list only
 * shrinks. Never add a file to it.
 *
 * Dev pages (src/app/dev/...) pass "MyCourses" as sample prop data; they may
 * stay listed, or switch to `SCHOOLS.aalto.lms`.
 */
const KNOWN_OFFENDERS = [
  "src/app/(app)/settings/actions.ts",
  "src/app/(app)/settings/page.tsx",
  "src/app/api/dev/moodle-ping/route.ts",
  "src/app/api/files/[id]/route.ts",
  "src/app/dev/brief/page.tsx",
  "src/app/dev/file-pick/page.tsx",
  "src/app/dev/handin-sheet/page.tsx",
  "src/app/dev/lecture-reader/page.tsx",
  "src/app/dev/sources/page.tsx",
  "src/components/lecture/reader.tsx",
  "src/components/work/brief.tsx",
  "src/components/work/file-pick.test.tsx",
  "src/components/work/handin-sheet.test.tsx",
  "src/components/work/handin-sheet.tsx",
  "src/components/work/sources.tsx",
];

/** Every .ts/.tsx file under `dir`, as a path relative to the repo with forward slashes. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (CODE.test(e.name)) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

/** The files among `files` (path -> text) that say the word, sorted. */
function offenders(files: Map<string, string>): string[] {
  return [...files].filter(([, text]) => WORD.test(text)).map(([f]) => f).sort();
}

/** What is wrong, compared with the allowlist. Empty means clean. */
function problems(found: string[], known: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of found) {
    if (!known.includes(f)) {
      out.push(`${f} says "MyCourses"; take the name from the lmsName prop or lmsNameOf() in src/lib/schools.ts`);
    }
  }
  for (const f of known) {
    if (!found.includes(f)) out.push(`${f} no longer says "MyCourses"; remove it from KNOWN_OFFENDERS`);
  }
  return out;
}

function readScanned(): Map<string, string> {
  const files = SCANNED.flatMap((d) => walk(join(ROOT, d)));
  return new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
}

describe("no hard-coded LMS name", () => {
  it("finds MyCourses only in the known offenders, and in every one of them", () => {
    expect(problems(offenders(readScanned()), KNOWN_OFFENDERS)).toEqual([]);
  });

  it("keeps the allowlist sorted and without repeats", () => {
    expect([...new Set(KNOWN_OFFENDERS)].sort()).toEqual(KNOWN_OFFENDERS);
  });

  it("catches a new file, and a listed file that was fixed", () => {
    const files = readScanned();
    files.set("src/components/new-screen.tsx", "<p>Open MyCourses</p>\n");
    files.set("src/components/also-new.ts", 'const x = "Open it in MyCourses.";\n');
    files.set(KNOWN_OFFENDERS[0], "// fixed: uses lmsName\n");
    files.set("src/components/fine.tsx", "<p>Open {lmsName}</p> MyCoursesLink\n");
    const found = problems(offenders(files), KNOWN_OFFENDERS).join("\n");
    expect(found).toContain('src/components/new-screen.tsx says "MyCourses"');
    expect(found).toContain('src/components/also-new.ts says "MyCourses"');
    expect(found).toContain(`${KNOWN_OFFENDERS[0]} no longer says "MyCourses"; remove it`);
    expect(found).not.toContain("src/components/fine.tsx");
  });
});
