/*
 * Mock exams into her account: the `mock-exams/` folder of a course folder of her bundle.
 *
 *   const { exams, problems } = await loadMockExams(courseDir);     // read + check, no database
 *   const counts = await applyMockExams(db, userId, courseId, exams, lecturePagesOf(seed.lectures));
 *
 * Each `*.json` in the folder except `index.json` is one exam (src/lib/mock-exams/types.ts). A
 * file that is not one is left out and reported; the others still go in. An exam is found again
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
/** The folder's list of its exams: not an exam itself (each exam file carries its own order). */
const INDEX_FILE = "index.json";

export type MockExamFile = { file: string; exam: MockExam };
export type MockExamProblem = { file: string; reason: string };
export type MockExamCount = { created: number; skipped: number; updated: number };

/**
 * Checks exam files as read (or as a request carried them). Pure. An exam whose id an earlier
 * file already has is left out too.
 */
export function checkMockExamFiles(raw: readonly { file: string; exam: unknown }[]): { exams: MockExamFile[]; problems: MockExamProblem[] } {
  const exams: MockExamFile[] = [];
  const problems: MockExamProblem[] = [];
  for (const { file, exam } of raw) {
    const checked = checkMockExam(exam);
    if (!checked.ok) {
      const more = checked.problems.length > 3 ? ` (and ${checked.problems.length - 3} more)` : "";
      problems.push({ file, reason: `is not a mock exam, left out: ${checked.problems.slice(0, 3).join(" ")}${more}` });
    } else if (exams.some((e) => e.exam.id === checked.exam.id)) {
      problems.push({ file, reason: "has the id of another mock exam of this folder, left out." });
    } else exams.push({ file, exam: checked.exam });
  }
  return { exams, problems };
}

/** The exams of `<courseDir>/mock-exams/`, in paper order, and the files that could not be used. */
export async function loadMockExams(courseDir: string): Promise<{ exams: MockExamFile[]; problems: MockExamProblem[] }> {
  const dir = path.join(courseDir, MOCK_EXAMS_FOLDER);
  const names = await readdir(dir).then(
    (list) => list.filter((n) => n.toLowerCase().endsWith(".json") && n !== INDEX_FILE && !n.startsWith(".")).sort(),
    () => [] as string[],
  );
  const raw: { file: string; exam: unknown }[] = [];
  const unreadable: MockExamProblem[] = [];
  for (const name of names) {
    const file = `${MOCK_EXAMS_FOLDER}/${name}`;
    try {
      raw.push({ file, exam: JSON.parse(await readFile(path.join(dir, name), "utf8")) as unknown });
    } catch {
      unreadable.push({ file, reason: "cannot be read or is not valid JSON, left out." });
    }
  }
  const { exams, problems } = checkMockExamFiles(raw);
  exams.sort((a, b) => a.exam.order - b.exam.order || a.exam.id.localeCompare(b.exam.id));
  return { exams, problems: [...unreadable, ...problems] };
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
  for (const { exam } of exams) {
    const position = Math.round(exam.order);
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
