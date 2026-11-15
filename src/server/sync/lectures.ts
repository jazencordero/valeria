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
 * - `lecturesFrom` numbers the lectures 1..k in page order (M9-04). When two
 *   files share a number (the PDF and the PowerPoint of one deck), the
 *   lecture takes the first PDF, else the first in `lecturesFrom`'s order,
 *   for its file and title.
 * - Matching (M9-24): a lecture belongs to the row that has its file
 *   (`file_id`), whatever number that row had. A lecture whose file no row
 *   has (or that has no file yet) takes a row with no `file_id` and the same
 *   number: an imported or hand-made lecture that Moodle now has the file
 *   for. A row that has a file never matches by number. Otherwise it is a
 *   new row. A file the teacher replaces with a new upload under a new name
 *   is a new file row, so a new lecture: we do not guess two files are one
 *   deck.
 * - A matched row gets `n`, `title`, `file_id` and `opens_at` set, and only
 *   when one of them differs. `read_at`, `last_opened_at`, the lecture page,
 *   notes, highlights and cards hang off the row id and are never touched:
 *   what she has read moves with the file when its number changes.
 * - Rows this run did not produce are kept (counted in `kept`), never
 *   deleted:
 *   - A row with no file keeps its number when no lecture of this run has
 *     it (hand-made rows usually sit after Moodle's, or were taken over
 *     above). If a lecture matched by file needs that number, the row moves
 *     after the live lectures like a gone file.
 *   - A row whose file no longer gives a lecture (renamed into something
 *     that is not a lecture, or its file row deleted) is placed after the
 *     live lectures: in its old order, on the lowest numbers above k that a
 *     kept row with no file does not hold. A second sync gives the same
 *     numbers.
 * - Renumbering runs in this one transaction without ever tripping
 *   `unique(user_id, course_id, n)`: every row whose number changes is first
 *   moved to a number below all of the course's numbers (negative), then to
 *   its final number; new rows are inserted last, on numbers that are free
 *   by then.
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
 * - No "gone from Moodle" flag: `syncFiles` never deletes a file row, so a
 *   deck the teacher removed stays a lecture with its number until its file
 *   row goes. A row whose file row was deleted has `file_id` null (the
 *   foreign key sets it), and then reads like a hand-made row: it keeps its
 *   number, and a new lecture with no row of its own on that number takes
 *   it over.
 *
 * Lecture pages (M9-05). Last, per course, one `lecture-page` job is queued
 * (`queueLecturePages`) for every lecture whose file has extracted text
 * (`text_status = 'done'`) and that has no `lecture_content` row yet, with
 * dedupe key `lecture:<id>`, so a lecture never has two live jobs. Only in a
 * course whose files may go to an AI model (`mayUseFiles`): elsewhere the job
 * would end without asking anything, every sync. The job
 * (src/server/ai/jobs/lecture-page.ts) asks again itself. A file whose text
 * is extracted after this sync gets its job on the next sync. This file stays
 * free of the AI router: it only writes rows to the job queue.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { mayUseFiles } from "@/server/ai/consent";
import { enqueue } from "@/server/jobs/queue";
import { lecturesFrom, type CourseModule, type CourseSection, type Lecture } from "@/lib/courses/lectures";

/** The job kind of a lecture page (M9-05); /api/cron/lecture-page drains it. */
export const LECTURE_PAGE_KIND = "lecture-page";

export type SyncLecturesResult = {
  /** New lecture rows. */
  added: number;
  /** Existing rows this run produced whose number, title, file or opening date changed. */
  updated: number;
  /** Existing rows this run did not produce: kept, possibly on a new number after the live ones. */
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

/** What one lecture of this run is written as. */
type Wanted = { n: number; title: string; fileId: string | null; opensAt: Date | null };

/** The stored lecture fields matching reads. */
type Existing = { id: string; n: number; title: string; fileId: string | null; opensAt: Date | null };

export type LecturePlan = {
  /**
   * Existing rows that end up with other values; `values.n` is the final
   * number. `produced` is false for a kept row that only moves.
   */
  updates: { id: string; from: number; values: Wanted; produced: boolean }[];
  /** Lectures no row matched. */
  inserts: Wanted[];
  /** Existing rows this run did not produce. */
  kept: number;
};

/**
 * Pure: which existing row each lecture of this run belongs to, and every
 * row's final number. See the rules at the top of this file.
 */
export function planLectures(existing: readonly Existing[], wanted: readonly Wanted[]): LecturePlan {
  const byN = [...existing].sort((a, b) => a.n - b.n);
  const rowOfFile = new Map<string, Existing>();
  const filelessOfN = new Map<number, Existing>();
  for (const r of byN) {
    if (r.fileId === null) filelessOfN.set(r.n, r);
    // Two rows with one file (left by the old by-number sync): the lower number wins, the other is kept.
    else if (!rowOfFile.has(r.fileId)) rowOfFile.set(r.fileId, r);
  }

  const matched = new Map<string, Wanted>();
  const inserts: Wanted[] = [];
  // By file first, so a row with no file is only taken over when no file match needs it.
  const rest: Wanted[] = [];
  for (const w of wanted) {
    const row = w.fileId !== null ? rowOfFile.get(w.fileId) : undefined;
    if (row) matched.set(row.id, w);
    else rest.push(w);
  }
  for (const w of rest) {
    const row = filelessOfN.get(w.n);
    if (row && !matched.has(row.id)) matched.set(row.id, w);
    else inserts.push(w);
  }

  // Kept rows: no file and a number no lecture of this run has stays put; the rest go after the live ones.
  const live = new Set(wanted.map((w) => w.n));
  const finalN = new Map<string, number>();
  const taken = new Set(live);
  const unmatched = byN.filter((r) => !matched.has(r.id));
  for (const r of unmatched) {
    if (r.fileId === null && !live.has(r.n)) {
      finalN.set(r.id, r.n);
      taken.add(r.n);
    }
  }
  let next = wanted.length + 1;
  for (const r of unmatched) {
    if (finalN.has(r.id)) continue;
    while (taken.has(next)) next += 1;
    finalN.set(r.id, next);
    taken.add(next);
  }

  const updates: LecturePlan["updates"] = [];
  for (const r of byN) {
    const w = matched.get(r.id);
    if (w) {
      if (r.n !== w.n || r.title !== w.title || r.fileId !== w.fileId || !sameTime(r.opensAt, w.opensAt)) {
        updates.push({ id: r.id, from: r.n, values: w, produced: true });
      }
    } else {
      const n = finalN.get(r.id)!;
      if (n !== r.n) {
        updates.push({ id: r.id, from: r.n, values: { n, title: r.title, fileId: r.fileId, opensAt: r.opensAt }, produced: false });
      }
    }
  }

  return { updates, inserts, kept: unmatched.length };
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
      const wanted: Wanted[] = onePerNumber(lecturesFrom(sections)).map((l) => ({
        n: l.n,
        title: l.title,
        fileId: l.fileRef ? (fileIdOf.get(l.fileRef) ?? null) : null,
        opensAt: l.opensAt ? new Date(l.opensAt) : null,
      }));

      const existing = await tx
        .select({ id: lectures.id, n: lectures.n, title: lectures.title, fileId: lectures.fileId, opensAt: lectures.opensAt })
        .from(lectures)
        .where(and(eq(lectures.userId, userId), eq(lectures.courseId, course.id)));

      const plan = planLectures(existing, wanted);

      // Phase 1: every row whose number changes steps aside, below all of this course's numbers.
      const moving = plan.updates.filter((u) => u.from !== u.values.n);
      const floor = Math.min(0, ...existing.map((r) => r.n));
      for (const [i, u] of moving.entries()) {
        await tx.update(lectures).set({ n: floor - 1 - i }).where(eq(lectures.id, u.id));
      }
      // Phase 2: final numbers and values.
      for (const u of plan.updates) {
        await tx.update(lectures).set(u.values).where(eq(lectures.id, u.id));
      }
      // New rows last, on numbers that are free now.
      for (const w of plan.inserts) {
        // A parallel sync may have added the same number; then this is an update of theirs.
        const { title, fileId, opensAt } = w;
        await tx
          .insert(lectures)
          .values({ userId, courseId: course.id, ...w })
          .onConflictDoUpdate({ target: [lectures.userId, lectures.courseId, lectures.n], set: { title, fileId, opensAt } });
      }

      added += plan.inserts.length;
      updated += plan.updates.filter((u) => u.produced).length;
      kept += plan.kept;

      await queueLecturePages(userId, course.id, tx);
    }

    return { added, updated, kept };
  });
}

/**
 * Queues one `lecture-page` job per lecture of the course whose file has
 * extracted text and that has no page yet, when the course's files may go to
 * an AI model. Returns how many jobs were added (an already live job for the
 * same lecture is not added again).
 */
export async function queueLecturePages(userId: string, courseId: string, database: Db = defaultDb): Promise<number> {
  const waiting = await database
    .select({ id: lectures.id })
    .from(lectures)
    .innerJoin(courseFiles, eq(courseFiles.id, lectures.fileId))
    .leftJoin(lectureContent, eq(lectureContent.lectureId, lectures.id))
    .where(
      and(
        eq(lectures.userId, userId),
        eq(lectures.courseId, courseId),
        eq(courseFiles.textStatus, "done"),
        isNull(lectureContent.id),
      ),
    );
  if (waiting.length === 0) return 0;
  if (!(await mayUseFiles(userId, courseId, database))) return 0;

  let created = 0;
  for (const { id } of waiting) {
    const job = await enqueue(LECTURE_PAGE_KIND, { lectureId: id }, { userId, dedupeKey: `lecture:${id}`, db: database });
    if (job.created) created += 1;
  }
  return created;
}
