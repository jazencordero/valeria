/*
 * Copies the list of files on her Moodle course pages into `course_files`, and
 * asks for the text of the ones we can read. The list, not the bytes: nothing
 * is downloaded here.
 *
 *   const { added, updated, queued } = await syncFiles(userId);
 *
 * Run it after `syncCourses` and `syncAssignments`: it reads the courses we
 * store and the attachment rows `syncAssignments` wrote. It runs in the
 * background, as the `sync-files` job a finished `syncNow` adds (one per user).
 *
 * Rules:
 * - Only her visible courses (`courses.hidden = false`) are asked for, one
 *   `getCourseContents` call per course, one after another.
 * - One row per (user_id, moodle_ref). A file on a course page gets
 *   `moodle_ref = cm:<course module id>:<file name>` (`sectionFileRef`); the
 *   name keeps a folder's subfolder ("templates/a.xlsx"). Brief attachments
 *   are `assign:<id>:intro:<name>` (./assignments), so the two never collide.
 *   `section` is the section's name as Moodle shows it; `assignment_id` stays
 *   null.
 * - A row is never deleted: lecture pages and extracted text hang off it. A
 *   file Moodle no longer lists is left as it is.
 * - Which files get text (`isExtractable`): the name ends in .pdf, .txt, .md
 *   or .csv (any case) and the file is under 20 MB. Everything else (slides
 *   as PowerPoint, spreadsheets, pictures, big files) is listed with
 *   `text_status 'none'` and never queued. The name decides, not the mime
 *   type: Moodle derives the mime type from the name anyway.
 * - "Changed" means the file's content may be different: its size, its
 *   modified time (Moodle's `timemodified`) or its URL is not what we stored.
 *   The URL counts because a replaced file gets a new revision number in it
 *   even when the size happens to match. A new section name or mime type
 *   alone is saved but is not a change.
 * - A readable file is queued when it is new, when it changed, or when its
 *   `text_status` is still 'none' (nobody asked for its text yet). Queued
 *   means: `text_status 'queued'` and one `extract` job with payload
 *   `{ fileId }` and `dedupeKey` the file id, both in the same transaction, so
 *   there is never one without the other. A file that is 'queued', 'done' or
 *   'failed' and did not change is left alone: a second sync queues nothing,
 *   and a failed file is tried again only when the teacher replaces it.
 * - A file that changed and can no longer be read (it grew past 20 MB) goes
 *   back to 'none'. Its old pages are not deleted here.
 * - Brief attachments (rows with `assignment_id`, written by
 *   `syncAssignments` with 'none') are queued by the same rule: readable and
 *   still 'none'. The assignment chat needs the brief's text, and this is the
 *   one place that queues extraction. Nothing else about those rows is
 *   touched here.
 * - `added` and `updated` count course-page file rows: new ones, and existing
 *   ones where a stored value changed. `queued` counts `extract` jobs this run
 *   added, attachments included.
 * - Moodle is read in full before anything is written: a failed read (one
 *   course is enough) changes nothing and throws. All writes are one
 *   transaction.
 * - Last, inside that same transaction, `syncLectures` (./lectures, M9-03)
 *   turns the stored files into her lectures, so files and lectures always
 *   land together. Its counts are not part of the result.
 *
 * Cut: a replaced brief attachment keeps its old text (./assignments does not
 * record a change). Files in hidden courses are not looked at. Text is only
 * ever taken from PDF, TXT, MD and CSV.
 */
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { enqueue } from "@/server/jobs/queue";
import { getConnection } from "@/server/moodle/connect";
import { getCourseContents } from "@/server/moodle/read/contents";
import { NotConnected } from "./courses";
import { syncLectures } from "./lectures";

/** The job kind that runs `syncFiles` for one user. Drained by /api/cron/sync-files. */
export const SYNC_FILES_KIND = "sync-files";
/** The job kind that pulls one file's text. Payload `{ fileId }`. Drained by /api/cron/extract. */
export const EXTRACT_KIND = "extract";
/** Files this big or bigger are listed but never read. */
export const MAX_EXTRACT_BYTES = 20 * 1024 * 1024;
/** File name endings we take text from. */
export const EXTRACT_EXTENSIONS = ["pdf", "txt", "md", "csv"] as const;

/** The largest value the `size` column (a 32-bit integer) holds. */
const INT_MAX = 2_147_483_647;

export type SyncFilesResult = { added: number; updated: number; queued: number };

/** What the sync reads Moodle with. Tests pass their own. */
export type SyncFilesDeps = { getCourseContents: typeof getCourseContents };

/** The `course_files.moodle_ref` of one file on a course page. `moduleRef` is `cm:<id>`. */
export function sectionFileRef(moduleRef: string, fileName: string): string {
  return `${moduleRef}:${fileName}`;
}

/** True for a PDF, TXT, MD or CSV under 20 MB: a file whose text we pull. */
export function isExtractable(file: { name: string; size: number | null }): boolean {
  const ext = /\.([^./]+)$/.exec(file.name)?.[1].toLowerCase();
  if (!ext || !(EXTRACT_EXTENSIONS as readonly string[]).includes(ext)) return false;
  return file.size !== null && file.size < MAX_EXTRACT_BYTES;
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

type Listed = {
  moodleRef: string;
  courseId: string;
  section: string;
  name: string;
  mime: string | null;
  size: number;
  url: string;
  modifiedAt: Date | null;
};

export async function syncFiles(
  userId: string,
  database: Db = defaultDb,
  deps: SyncFilesDeps = { getCourseContents },
): Promise<SyncFilesResult> {
  const conn = await getConnection(userId, database);
  if (!conn) throw new NotConnected();

  const visible = await database
    .select({ id: courses.id, moodleId: courses.moodleId })
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)));

  // Moodle is read before the transaction opens; a failed read changes nothing.
  const listed = new Map<string, Listed>();
  for (const course of visible) {
    for (const section of await deps.getCourseContents(conn, course.moodleId)) {
      for (const mod of section.modules) {
        for (const file of mod.files) {
          const moodleRef = sectionFileRef(mod.moodleRef, file.name);
          if (listed.has(moodleRef)) continue;
          listed.set(moodleRef, {
            moodleRef,
            courseId: course.id,
            section: section.section,
            name: file.name,
            mime: file.mime || null,
            size: Math.min(file.size, INT_MAX),
            url: file.url,
            modifiedAt: file.modifiedAt,
          });
        }
      }
    }
  }
  const visibleIds = new Set(visible.map((c) => c.id));

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx.select().from(courseFiles).where(eq(courseFiles.userId, userId));
    const rowOf = new Map(existing.map((row) => [row.moodleRef, row]));

    let added = 0;
    let updated = 0;
    let queued = 0;
    // The job is added inside this transaction: status and job land together.
    const queue = async (fileId: string) => {
      const { created } = await enqueue(EXTRACT_KIND, { fileId }, { userId, dedupeKey: fileId, db: tx });
      if (created) queued += 1;
    };

    for (const file of listed.values()) {
      const { moodleRef, ...fromMoodle } = file;
      const readable = isExtractable(file);
      const row = rowOf.get(moodleRef);

      if (!row) {
        const inserted = await tx
          .insert(courseFiles)
          .values({ userId, moodleRef, ...fromMoodle, textStatus: readable ? "queued" : "none" })
          .onConflictDoNothing({ target: [courseFiles.userId, courseFiles.moodleRef] })
          .returning({ id: courseFiles.id });
        // No row back means a parallel sync added it first; it is theirs to queue.
        if (inserted.length === 0) continue;
        added += 1;
        if (readable) await queue(inserted[0].id);
        continue;
      }

      const changed =
        row.size !== fromMoodle.size || !sameTime(row.modifiedAt, fromMoodle.modifiedAt) || row.url !== fromMoodle.url;
      const sameRow =
        !changed &&
        row.courseId === fromMoodle.courseId &&
        row.section === fromMoodle.section &&
        row.name === fromMoodle.name &&
        row.mime === fromMoodle.mime;
      const toQueue = readable && (changed || row.textStatus === "none");
      const textStatus = toQueue ? "queued" : changed ? "none" : row.textStatus;

      if (!sameRow || textStatus !== row.textStatus) {
        await tx
          .update(courseFiles)
          .set({ ...fromMoodle, textStatus })
          .where(eq(courseFiles.id, row.id));
      }
      if (!sameRow) updated += 1;
      if (toQueue) await queue(row.id);
    }

    // Brief attachments nobody has asked the text of yet.
    for (const row of existing) {
      if (row.assignmentId === null || row.textStatus !== "none") continue;
      if (listed.has(row.moodleRef) || !visibleIds.has(row.courseId) || !isExtractable(row)) continue;
      await tx.update(courseFiles).set({ textStatus: "queued" }).where(eq(courseFiles.id, row.id));
      await queue(row.id);
    }

    await syncLectures(userId, tx);
    return { added, updated, queued };
  });
}
