/*
 * Mock exams into her account: the `mock-exams/` folder of a course folder of her bundle.
 *
 *   const { exams, problems } = await loadMockExams(courseDir);     // read + check, no database
 *   const counts = await applyMockExams(db, userId, courseId, exams, lecturePagesOf(seed.lectures));
 *
 * `index.json`, when the folder has one, says which files are sets and in which order; without
 * it every `*.json` is one (src/lib/mock-exams/types.ts). A set may be a full exam or a shorter
 * set of written problems: nothing here counts questions or points. A file that is not a set is
 * left out and reported; the others still go in. An exam is found again
 * by its own `id` (`mock_exams.import_id`), so a new upload updates it in place: the row, and
 * with it every attempt she made, stays. Nothing is ever deleted here, also not an exam the
 * folder no longer holds.
 *
 * The seed tool and POST /api/seed call these through src/server/study/seed-account.ts.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { MockExam } from "@/lib/mock-exams/types";
import { checkMockExam } from "@/lib/mock-exams/validate";
import type { Db } from "@/server/db/client";
import { mockExams } from "@/server/db/schema/study";

export const MOCK_EXAMS_FOLDER = "mock-exams";
/** The folder's list of its sets: which files, and in which order. Not a set itself. */
const INDEX_FILE = "index.json";

/** `position`: the set's place in the folder's index.json, when that lists it; else the file's own `order` is used. */
export type MockExamFile = { file: string; exam: MockExam; position?: number };
export type MockExamProblem = { file: string; reason: string };
export type MockExamCount = { created: number; skipped: number; updated: number };

/**
 * Checks exam files as read (or as a request carried them). Pure. An exam whose id an earlier
 * file already has is left out too.
 */
export function checkMockExamFiles(raw: readonly { file: string; exam: unknown; position?: number }[]): { exams: MockExamFile[]; problems: MockExamProblem[] } {
  const exams: MockExamFile[] = [];
  const problems: MockExamProblem[] = [];
  for (const { file, exam, position } of raw) {
    const checked = checkMockExam(exam);
    if (!checked.ok) {
      const more = checked.problems.length > 3 ? ` (and ${checked.problems.length - 3} more)` : "";
      problems.push({ file, reason: `is not a mock exam, left out: ${checked.problems.slice(0, 3).join(" ")}${more}` });
    } else if (exams.some((e) => e.exam.id === checked.exam.id)) {
      problems.push({ file, reason: "has the id of another mock exam of this folder, left out." });
    } else exams.push({ file, exam: checked.exam, ...(typeof position === "number" && Number.isInteger(position) ? { position } : {}) });
  }
  return { exams, problems };
}

type IndexEntry = { name: string; id: string | null; order: number | null };

/**
 * The folder's index.json as a list of file names, or null when it cannot be used (then the
 * folder is scanned instead). Takes `{ exams: [...] }` or a bare list; an entry is
 * `{ file, id?, order? }` or just a file name. Pure.
 */
export function readMockExamIndex(raw: unknown): { entries: IndexEntry[]; problems: string[] } | null {
  const list = Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null && Array.isArray((raw as { exams?: unknown }).exams) ? (raw as { exams: unknown[] }).exams : null;
  if (!list) return null;
  const entries: IndexEntry[] = [];
  const problems: string[] = [];
  list.forEach((item, i) => {
    const o = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const name = typeof item === "string" ? item : o.file;
    // A plain file name of this folder: no path, nothing hidden, a .json, and not the index itself.
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(name) || name === INDEX_FILE) {
      problems.push(`entry ${i + 1} names no .json file of this folder, left out.`);
    } else if (entries.some((e) => e.name === name)) {
      problems.push(`entry ${i + 1} names a file an earlier entry already names, left out.`);
    } else {
      entries.push({ name, id: typeof o.id === "string" ? o.id : null, order: typeof o.order === "number" && Number.isFinite(o.order) ? o.order : null });
    }
  });
  return { entries, problems };
}

/**
 * The sets of `<courseDir>/mock-exams/` and the files that could not be used.
 *
 * With an index.json: exactly the files it lists, in its order (an entry's `order`, else its
 * place in the list). A listed file that is missing, is not an exam, or carries another id than
 * the index gives it is left out and reported. A .json file the index does not list is not
 * imported, and reported too, so a forgotten index entry is seen.
 * Without one (or with one that is not a list): every .json file of the folder, in the order
 * the files themselves give.
 */
export async function loadMockExams(courseDir: string): Promise<{ exams: MockExamFile[]; problems: MockExamProblem[] }> {
  const dir = path.join(courseDir, MOCK_EXAMS_FOLDER);
  const onDisk = await readdir(dir).then(
    (list) => list.filter((n) => n.toLowerCase().endsWith(".json") && n !== INDEX_FILE && !n.startsWith(".")).sort(),
    () => null,
  );
  if (!onDisk) return { exams: [], problems: [] };
  const fileOf = (name: string) => `${MOCK_EXAMS_FOLDER}/${name}`;
  const early: MockExamProblem[] = [];

  let index: ReturnType<typeof readMockExamIndex> = null;
  const indexText = await readFile(path.join(dir, INDEX_FILE), "utf8").catch(() => null);
  if (indexText !== null) {
    try {
      index = readMockExamIndex(JSON.parse(indexText));
    } catch {
      index = null;
    }
    if (!index) early.push({ file: fileOf(INDEX_FILE), reason: "is not a list of files; every .json file of the folder was read instead." });
    else for (const p of index.problems) early.push({ file: fileOf(INDEX_FILE), reason: p });
  }

  const wanted: IndexEntry[] = index ? index.entries : onDisk.map((name) => ({ name, id: null, order: null }));
  const raw: { file: string; exam: unknown; position?: number }[] = [];
  for (const [i, entry] of wanted.entries()) {
    const file = fileOf(entry.name);
    let exam: unknown;
    try {
      exam = JSON.parse(await readFile(path.join(dir, entry.name), "utf8")) as unknown;
    } catch {
      const missing = !onDisk.includes(entry.name);
      early.push({ file, reason: missing ? "is listed in index.json but is not in the folder, left out." : "cannot be read or is not valid JSON, left out." });
      continue;
    }
    const itsId = typeof exam === "object" && exam !== null ? (exam as { id?: unknown }).id : undefined;
    if (entry.id !== null && typeof itsId === "string" && itsId !== entry.id) {
      early.push({ file, reason: "carries another id than index.json gives it, left out." });
      continue;
    }
    raw.push({ file, exam, ...(index ? { position: Math.round(entry.order ?? i + 1) } : {}) });
  }
  if (index) {
    const listed = new Set(index.entries.map((e) => e.name));
    for (const name of onDisk) if (!listed.has(name)) early.push({ file: fileOf(name), reason: "is not listed in index.json, not imported." });
  }

  const { exams, problems } = checkMockExamFiles(raw);
  const placeOf = (e: MockExamFile) => e.position ?? e.exam.order;
  exams.sort((a, b) => placeOf(a) - placeOf(b) || a.exam.id.localeCompare(b.exam.id));
  return { exams, problems: [...early, ...problems] };
}

/**
 * Lecture page slug -> lecture number, from the seed's lectures: the slug is the page's file
 * name without its folder and `.json`, which is what an exam's `lectures[].page` names.
 */
export function lecturePagesOf(seedLectures: readonly { n: number; page?: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of seedLectures) {
    if (!l.page) continue;
    const slug = l.page.split(/[\\/]/).pop()!.replace(/\.json$/i, "");
    if (slug && !(slug in out)) out[slug] = l.n;
  }
  return out;
}

/** JSON with keys sorted at every level: the same content gives the same text, whatever order the database returns. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Writes the exams into `userId`'s course: new ones are added, changed ones updated in place. */
export async function applyMockExams(
  database: Db,
  userId: string,
  courseId: string,
  exams: readonly MockExamFile[],
  lecturePages: Record<string, number>,
): Promise<MockExamCount> {
  const counts: MockExamCount = { created: 0, skipped: 0, updated: 0 };
  if (!exams.length) return counts;
  const ids = exams.map((e) => e.exam.id);
  const existing = await database
    .select()
    .from(mockExams)
    .where(and(eq(mockExams.userId, userId), inArray(mockExams.importId, ids)));
  const rowOf = new Map(existing.map((r) => [r.importId, r]));
  for (const { exam, position: place } of exams) {
    const position = place ?? Math.round(exam.order);
    const row = rowOf.get(exam.id);
    if (!row) {
      await database.insert(mockExams).values({ userId, courseId, importId: exam.id, position, content: exam, lecturePages });
      counts.created += 1;
    } else if (
      row.courseId === courseId &&
      row.position === position &&
      stable(row.content) === stable(exam) &&
      stable(row.lecturePages) === stable(lecturePages)
    ) {
      counts.skipped += 1;
    } else {
      await database
        .update(mockExams)
        .set({ courseId, position, content: exam, lecturePages })
        .where(and(eq(mockExams.id, row.id), eq(mockExams.userId, userId)));
      counts.updated += 1;
    }
  }
  return counts;
}
