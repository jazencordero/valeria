/*
 * Copies her Moodle course list into our `courses` table.
 *
 *   const { added, updated, hidden } = await syncCourses(userId);
 *
 * Rules:
 * - One row per (user_id, moodle_id). A row is never deleted: cards and grades
 *   hang off it. A course Moodle no longer returns is marked `hidden`.
 * - A new course gets the colour her visible courses use least; ties go to the
 *   earlier colour in butter, mint, sky, blush. So the first four courses get
 *   the four colours in order, and when all four are taken the cycle starts
 *   again with the least used one (a fifth course gets butter).
 * - A hidden course that Moodle returns again is shown again and keeps the
 *   colour it had. It counts as `updated`.
 * - `updated` counts rows that already existed and changed (name, short name,
 *   code, or shown again). `hidden` counts rows hidden by this run only.
 *
 * - Take-over (M3-57): a course Moodle returns that we do not store by its id, whose code
 *   matches exactly one of her seeded courses (negative `moodle_id`, made by
 *   src/server/study/seed-account.ts before she connected), is that row: it gets the real
 *   `moodle_id`, name and short name and keeps its colour, so there is no second row and
 *   everything hanging off it stays. It counts as `updated`.
 *
 * Cut: no past-semester filtering; every course Moodle returns is shown.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { COURSE_COLORS, courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { getConnection } from "@/server/moodle/connect";
import { getCourses, type Course } from "@/server/moodle/read/courses";

export type CourseColor = (typeof COURSE_COLORS)[number];

export type SyncCoursesResult = { added: number; updated: number; hidden: number };

/** What the sync reads Moodle with. Tests pass their own `getCourses`. */
export type SyncCoursesDeps = { getCourses: typeof getCourses };

/** She has no stored Moodle key, so there is nothing to sync from. */
export class NotConnected extends Error {
  constructor() {
    super("syncCourses: this user has no Moodle connection.");
    this.name = "NotConnected";
  }
}

/** The colour `used` holds least often; ties go to the earlier colour in COURSE_COLORS. */
export function nextColor(used: readonly CourseColor[]): CourseColor {
  let best: CourseColor = COURSE_COLORS[0];
  let bestCount = Infinity;
  for (const color of COURSE_COLORS) {
    const count = used.filter((c) => c === color).length;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

export async function syncCourses(
  userId: string,
  database: Db = defaultDb,
  deps: SyncCoursesDeps = { getCourses },
): Promise<SyncCoursesResult> {
  const conn = await getConnection(userId, database);
  const [link] = await database
    .select({ moodleUserId: moodleConnections.moodleUserId })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  if (!conn || !link) throw new NotConnected();

  // Moodle is read before the transaction opens; a failed read changes nothing.
  const seen = new Map<number, Course>();
  for (const course of await deps.getCourses(conn, link.moodleUserId)) {
    if (!seen.has(course.moodleId)) seen.set(course.moodleId, course);
  }

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx.select().from(courses).where(eq(courses.userId, userId));
    const byMoodleId = new Map(existing.map((row) => [row.moodleId, row]));

    // M3-57: courses seeded from files before she connected have a negative moodle_id.
    const norm = (code: string) => code.trim().toUpperCase();
    const seededByCode = new Map<string, (typeof existing)[number][]>();
    for (const row of existing) {
      if (row.moodleId >= 0 || !row.code) continue;
      seededByCode.set(norm(row.code), [...(seededByCode.get(norm(row.code)) ?? []), row]);
    }

    let updated = 0;
    const fresh: Course[] = [];
    for (const course of seen.values()) {
      const row = byMoodleId.get(course.moodleId);
      if (!row) {
        const seeded = course.code ? seededByCode.get(norm(course.code)) : undefined;
        if (seeded?.length === 1) {
          // Take the seeded row over: same row, the real id, so her assignments, exams and cards stay.
          seededByCode.delete(norm(course.code!));
          await tx
            .update(courses)
            .set({ moodleId: course.moodleId, name: course.name, shortName: course.shortName, code: course.code, hidden: false })
            .where(eq(courses.id, seeded[0].id));
          seeded[0].moodleId = course.moodleId;
          updated += 1;
          continue;
        }
        fresh.push(course);
        continue;
      }
      const same =
        !row.hidden && row.name === course.name && row.shortName === course.shortName && row.code === course.code;
      if (same) continue;
      await tx
        .update(courses)
        .set({ name: course.name, shortName: course.shortName, code: course.code, hidden: false })
        .where(eq(courses.id, row.id));
      updated += 1;
    }

    // Colours in use by what she will see after this run: every course Moodle returned.
    const used: CourseColor[] = existing.filter((row) => seen.has(row.moodleId)).map((row) => row.color);
    let added = 0;
    for (const course of fresh) {
      const color = nextColor(used);
      const inserted = await tx
        .insert(courses)
        .values({
          userId,
          moodleId: course.moodleId,
          code: course.code,
          name: course.name,
          shortName: course.shortName,
          color,
        })
        .onConflictDoNothing({ target: [courses.userId, courses.moodleId] })
        .returning({ id: courses.id });
      // No row back means a parallel sync added it first; it is not ours to count.
      if (inserted.length === 0) continue;
      used.push(color);
      added += 1;
    }

    const gone = existing.filter((row) => !row.hidden && !seen.has(row.moodleId)).map((row) => row.id);
    if (gone.length > 0) {
      await tx
        .update(courses)
        .set({ hidden: true })
        .where(and(eq(courses.userId, userId), inArray(courses.id, gone)));
    }

    return { added, updated, hidden: gone.length };
  });
}
