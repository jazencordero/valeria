/*
 * Turns the course files we store into her lectures (M9-03).
 *
 *   const { added, updated, kept } = await syncLectures(userId);
 *
 * `syncFiles` calls it at the end, inside its own transaction, so the files
 * and the lectures they make always land together. It reads only our
 * database: Moodle is not asked anything here.
 *
 * Rules:
 * - Only her visible courses (`courses.hidden = false`), as in `syncFiles`.
 * - Per course, the course-page files (`assignment_id` null, `moodle_ref`
 *   `cm:<id>:<file name>`) are rebuilt into the section shape `lecturesFrom`
 *   (src/lib/courses/lectures.ts) reads; see `sectionsFromStored`. Brief
 *   attachments are never lectures.
 * - One `lectures` row per (user_id, course_id, n). When two files share a
 *   number (the PDF and the PowerPoint of lecture 1, or two parts of lecture
 *   3), the row takes the first PDF, else the first in `lecturesFrom`'s
 *   order, for its file and title.
 * - A new number is inserted; an existing one gets `title`, `file_id` and
 *   `opens_at` set, and only when one of them differs. `read_at` and
 *   `last_opened_at` are never written here: what she has read survives
 *   every sync.
 * - A lecture whose number `lecturesFrom` no longer gives is kept as it is
 *   (counted in `kept`), never deleted: her read mark, highlights and lecture
 *   page hang off the row. Stored files are never deleted either (M2-08), so
 *   this only happens when the lecture rules change or a file is renamed
 *   into a different number.
 *
 * Gaps (what the stored rows do not have, and what that costs):
 * - No module name and no module kind are stored. A module with one file is
 *   read as a `resource` whose name is the file name (dashes and underscores
 *   read as spaces), so titles come from the file name, not from the name the
 *   teacher gave the module. A module with more than one file is read as a
 *   `folder` with no name of its own. Keeping the real names needs a column
 *   on `course_files` (a schema change, not in this ticket).
 * - No section position is stored. Sections are ordered by the smallest
 *   course-module id in them (Moodle hands out ids as modules are created,
 *   which is usually page order). It only matters for lectures without a
 *   number in their name.
 * - No restricted modules are stored: `getCourseContents` (M2-07) drops the
 *   files of a module she cannot open and does not pass `uservisible` or
 *   `availabilityinfo` on, and a module with no files never gets a row. So
 *   `opens_at` is always null today and no lecture is ever `soon`. Fixing
 *   it needs the reader to pass those fields on and a place to store a
 *   module that has no file yet.
 * - Numbers are tied to the row, not to the file: if a new unnumbered file
 *   shifts the numbers `lecturesFrom` fills in, a read mark stays on its
 *   number. Numbered files (the usual case) never shift.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { lecturesFrom, type CourseModule, type CourseSection, type Lecture } from "@/lib/courses/lectures";

export type SyncLecturesResult = {
  /** New lecture rows. */
  added: number;
  /** Existing rows whose title, file or opening date changed. */
  updated: number;
  /** Existing rows this run did not produce, left as they were. */
  kept: number;
};

/** The stored file fields the rebuild needs. */
export type StoredFile = {
  id: string;
  moodleRef: string;
  section: string | null;
  name: string;
  mime: string | null;
  size: number | null;
  url: string;
  modifiedAt: Date | null;
};

const CM_REF = /^(cm:(\d+)):(.+)$/;

/** File name without extension, dashes and underscores as spaces: a stand-in for the module name. */
function nameFromFile(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  return base
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stored course-page files of one course as `lecturesFrom` input, plus the
 * map from `lecturesFrom`'s `fileRef` (`<moduleRef>/<file name>`) back to the
 * row id. Rows that are not course-page files (`cm:` refs) are skipped.
 */
export function sectionsFromStored(rows: readonly StoredFile[]): {
  sections: CourseSection[];
  fileIdOf: Map<string, string>;
} {
  type Mod = { ref: string; cmId: number; files: StoredFile[] };
  const bySection = new Map<string, Map<string, Mod>>();
  const fileIdOf = new Map<string, string>();

  for (const row of rows) {
    const m = CM_REF.exec(row.moodleRef);
    if (!m) continue;
    const [, ref, cmId, fileName] = m;
    const sectionName = row.section ?? "";
    let mods = bySection.get(sectionName);
    if (!mods) bySection.set(sectionName, (mods = new Map()));
    let mod = mods.get(ref);
    if (!mod) mods.set(ref, (mod = { ref, cmId: Number(cmId), files: [] }));
    mod.files.push({ ...row, name: fileName });
    fileIdOf.set(`${ref}/${fileName}`, row.id);
  }

  const sections = [...bySection.entries()]
    .map(([section, mods]) => {
      const list = [...mods.values()].sort((a, b) => a.cmId - b.cmId);
      return { section, first: list[0]?.cmId ?? 0, list };
    })
    .sort((a, b) => a.first - b.first || (a.section < b.section ? -1 : a.section > b.section ? 1 : 0))
    .map(({ section, list }, position): CourseSection => ({
      section,
      position,
      modules: list.map((mod): CourseModule => {
        const files = [...mod.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const folder = files.length > 1;
        return {
          moodleRef: mod.ref,
          name: folder ? "" : nameFromFile(files[0].name),
          kind: folder ? "folder" : "resource",
          files: files.map((f) => ({
            name: f.name,
            url: f.url,
            mime: f.mime,
            size: f.size,
            modifiedAt: f.modifiedAt,
          })),
        };
      }),
    }));

  return { sections, fileIdOf };
}

const isPdf = (l: Lecture) => /\.pdf$/i.test(l.fileRef ?? "");

/**
 * One lecture per number: a PDF first (its text is what the lecture page is
 * written from; ./files extracts PDFs, not slide decks), else the first in
 * `lecturesFrom`'s order. Output stays in number order.
 */
function onePerNumber(list: readonly Lecture[]): Lecture[] {
  const pick = new Map<number, Lecture>();
  for (const l of list) {
    const had = pick.get(l.n);
    if (!had || (isPdf(l) && !isPdf(had))) pick.set(l.n, l);
  }
  return [...pick.values()].sort((a, b) => a.n - b.n);
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

export async function syncLectures(userId: string, database: Db = defaultDb): Promise<SyncLecturesResult> {
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const visible = await tx
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.userId, userId), eq(courses.hidden, false)));

    let added = 0;
    let updated = 0;
    let kept = 0;

    for (const course of visible) {
      const rows = await tx
        .select({
          id: courseFiles.id,
          moodleRef: courseFiles.moodleRef,
          section: courseFiles.section,
          name: courseFiles.name,
          mime: courseFiles.mime,
          size: courseFiles.size,
          url: courseFiles.url,
          modifiedAt: courseFiles.modifiedAt,
        })
        .from(courseFiles)
        .where(
          and(eq(courseFiles.userId, userId), eq(courseFiles.courseId, course.id), isNull(courseFiles.assignmentId)),
        );

      const { sections, fileIdOf } = sectionsFromStored(rows);
      const found = onePerNumber(lecturesFrom(sections));

      const existing = await tx
        .select()
        .from(lectures)
        .where(and(eq(lectures.userId, userId), eq(lectures.courseId, course.id)));
      const rowOf = new Map(existing.map((r) => [r.n, r]));

      for (const l of found) {
        const fileId = l.fileRef ? (fileIdOf.get(l.fileRef) ?? null) : null;
        const opensAt = l.opensAt ? new Date(l.opensAt) : null;
        const values = { title: l.title, fileId, opensAt };
        const row = rowOf.get(l.n);

        if (!row) {
          // A parallel sync may have added the same number; then this is an update of theirs.
          await tx
            .insert(lectures)
            .values({ userId, courseId: course.id, n: l.n, ...values })
            .onConflictDoUpdate({ target: [lectures.userId, lectures.courseId, lectures.n], set: values });
          added += 1;
          continue;
        }
        if (row.title === values.title && row.fileId === values.fileId && sameTime(row.opensAt, values.opensAt)) {
          continue;
        }
        await tx.update(lectures).set(values).where(eq(lectures.id, row.id));
        updated += 1;
      }

      const produced = new Set(found.map((l) => l.n));
      kept += existing.filter((r) => !produced.has(r.n)).length;
    }

    return { added, updated, kept };
  });
}
