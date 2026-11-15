/*
 * Demo lectures and notes (M9-20): the prototype's four courses of lectures,
 * their pages and the three seed notes, for the demo account.
 *
 *   await seedLearn(userId, now, db);   // called by seedDemo after seedStudy
 *
 * Data: `tests/fixtures/study/demo-lectures.json`, copied from the prototype's
 * COURSE_DATA, LEC_DATA, LEC_SHORT and NOTE_SEED (merged.html JS 5089 to
 * 5255). Demo content only: invented courses, lectures and notes.
 *
 * - Courses: matched by name on the synced demo courses, as seedStudy does
 *   (the sample's four courses). A course that is missing stops the seed.
 * - Lectures: no file (the demo has no lecture decks), numbered as the
 *   prototype. State comes from the dates, the way `courseView` reads them:
 *   `opens_at` is `opensDays` from today at 08:00 Helsinki (past for the
 *   posted ones, a week apart; ahead for "soon"), `read_at` is `readDays` at
 *   19:00 for the read ones. So the first unread posted lecture is the
 *   current one ("You are here"), as in the prototype.
 * - Pages: the two written ones (Strategic IT Management 3 and 5) with their
 *   blocks, key terms and slide ranges; the short ones as a summary and
 *   three one-paragraph sections. The prototype's figure is left out (M9 has
 *   no figures). Minutes: the prototype's for the written two, else counted
 *   from the words (`readingMinutes`, as a made page is). Lectures not posted
 *   yet have no page. `source_hash` is "demo:" plus a hash of the page.
 * - Concepts: a lecture is linked only to the demo deck's concepts the
 *   prototype ties it to (its `pr.con`), looked up by exam title and concept
 *   name on the exams seedStudy just wrote. Every one of those concepts has
 *   cards in the deck, so a card count on the path or "Practise this
 *   lecture" never claims a card that is not there. The read lectures whose
 *   prototype stop shows a card count but no concept get no link (no cards),
 *   rather than invented ones.
 * - Notes: the three seed notes, attached as in the prototype (a lecture, a
 *   course, an assignment), dated on the prototype's days before today.
 *
 * Idempotent, in one transaction: lectures are upserted on (user, course, n)
 * so their ids stay; pages are upserted; a lecture's concept links are
 * replaced (seedStudy deletes and rewrites the exams, which takes the old
 * links with them); seed notes with the same title are deleted and written
 * again. A second run leaves the same rows.
 */
import { createHash } from "node:crypto";
import { and, eq, ilike, inArray } from "drizzle-orm";
import lecturesJson from "../../../tests/fixtures/study/demo-lectures.json";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures, notes } from "@/server/db/schema/learn";
import { concepts, exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { readingMinutes, type PageSection } from "@/server/ai/jobs/lecture-page";
import { DEMO_DECK, helsinkiAt } from "./seed-study";

// ---------------------------------------------------------------------------
// The fixture

export type DemoLecturePage = {
  breath: string;
  minutes: number | null;
  slideTitles: string[];
  sections: PageSection[];
};
export type DemoLecture = {
  n: number;
  title: string;
  /** The prototype's state; the dates below give the same one. */
  state: "done" | "cur" | "up" | "soon";
  opensDays: number;
  readDays?: number;
  /** Deck concepts by exam key ("exam", "quiz") and concept id. */
  concepts: { exam: string; concept: string }[];
  page?: DemoLecturePage;
};
export type DemoCourse = { key: string; name: string; lectures: DemoLecture[] };
export type DemoNote = {
  key: string;
  title: string;
  body: string;
  highlighted: boolean;
  attach:
    | { kind: "lecture"; course: string; n: number }
    | { kind: "course"; course: string }
    | { kind: "assignment"; course: string; name: string };
  days: number;
};
export type DemoLectures = { courses: DemoCourse[]; notes: DemoNote[] };

export const DEMO_LECTURES = lecturesJson as unknown as DemoLectures;

/** Wall-clock hours (Helsinki) of the seeded dates. */
const OPENS_HOUR = 8;
const READ_HOUR = 19;
const NOTE_HOUR = 18;

/** The page as stored: minutes from the fixture, else counted from the words. */
export function pageOf(page: DemoLecturePage): { breath: string; minutes: number; sections: PageSection[]; slideTitles: string[] } {
  return {
    breath: page.breath,
    minutes: page.minutes ?? readingMinutes(page),
    sections: page.sections,
    slideTitles: page.slideTitles,
  };
}

function hashOf(page: unknown): string {
  return `demo:${createHash("sha256").update(JSON.stringify(page)).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Writing it

export type SeedLearnResult = { lectures: number; pages: number; links: number; notes: number };

async function courseFor(tx: Db, userId: string, name: string): Promise<string> {
  const [row] = await tx
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.userId, userId), ilike(courses.name, `%${name}%`)))
    .orderBy(courses.name)
    .limit(1);
  if (!row) throw new Error(`seedLearn: no course named like "${name}" for this user; run the demo sync first.`);
  return row.id;
}

/** The deck concept's row id, on the exam seedStudy wrote for this user. */
async function conceptFor(tx: Db, userId: string, courseId: string, examKey: string, conceptKey: string): Promise<string> {
  const exam = DEMO_DECK.exams.find((e) => e.key === examKey);
  const concept = exam?.concepts.find((c) => c.id === conceptKey);
  if (!exam || !concept) throw new Error(`seedLearn: no deck concept ${examKey}/${conceptKey}.`);
  const [row] = await tx
    .select({ id: concepts.id })
    .from(concepts)
    .innerJoin(exams, eq(exams.id, concepts.examId))
    .where(
      and(
        eq(exams.userId, userId),
        eq(exams.courseId, courseId),
        eq(exams.title, exam.title),
        eq(concepts.name, concept.name),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`seedLearn: concept "${concept.name}" of "${exam.title}" is missing; run seedStudy first.`);
  return row.id;
}

/**
 * Writes the demo lectures, their pages and concept links, and the seed
 * notes for `userId` (see the header), dated from `now`. Needs the demo's
 * courses (the sync) and exams (seedStudy).
 */
export async function seedLearn(userId: string, now: Date = new Date(), database: Db = defaultDb): Promise<SeedLearnResult> {
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const out: SeedLearnResult = { lectures: 0, pages: 0, links: 0, notes: 0 };
    const courseIds = new Map<string, string>();
    const lectureIds = new Map<string, string>();

    for (const course of DEMO_LECTURES.courses) {
      const courseId = await courseFor(tx, userId, course.name);
      courseIds.set(course.key, courseId);

      for (const l of course.lectures) {
        const values = {
          title: l.title,
          opensAt: helsinkiAt(now, l.opensDays, OPENS_HOUR),
          readAt: l.readDays === undefined ? null : helsinkiAt(now, l.readDays, READ_HOUR),
          lastOpenedAt: l.readDays === undefined ? null : helsinkiAt(now, l.readDays, READ_HOUR),
        };
        const [row] = await tx
          .insert(lectures)
          .values({ userId, courseId, n: l.n, ...values })
          .onConflictDoUpdate({ target: [lectures.userId, lectures.courseId, lectures.n], set: values })
          .returning({ id: lectures.id });
        lectureIds.set(`${course.key}-${l.n}`, row.id);
        out.lectures++;

        if (l.page) {
          const page = pageOf(l.page);
          const content = { ...page, sourceHash: hashOf(page) };
          await tx
            .insert(lectureContent)
            .values({ lectureId: row.id, ...content })
            .onConflictDoUpdate({ target: lectureContent.lectureId, set: content });
          out.pages++;
        }

        await tx.delete(lectureConcepts).where(eq(lectureConcepts.lectureId, row.id));
        const linked = new Set<string>();
        for (const c of l.concepts) linked.add(await conceptFor(tx, userId, courseId, c.exam, c.concept));
        if (linked.size > 0) {
          await tx.insert(lectureConcepts).values([...linked].map((conceptId) => ({ lectureId: row.id, conceptId })));
          out.links += linked.size;
        }
      }
    }

    // The seed notes: the same titles go first, then all three are written again.
    const titles = DEMO_LECTURES.notes.map((n) => n.title);
    await tx.delete(notes).where(and(eq(notes.userId, userId), inArray(notes.title, titles)));
    for (const note of DEMO_LECTURES.notes) {
      const courseId = courseIds.get(note.attach.course);
      if (!courseId) throw new Error(`seedLearn: note ${note.key} names an unknown course.`);
      const at = helsinkiAt(now, note.days, NOTE_HOUR);
      const base = {
        userId,
        title: note.title,
        body: note.body,
        highlighted: note.highlighted,
        courseId,
        createdAt: at,
        updatedAt: at,
      };
      const a = note.attach;
      if (a.kind === "lecture") {
        const lectureId = lectureIds.get(`${a.course}-${a.n}`);
        if (!lectureId) throw new Error(`seedLearn: note ${note.key} names an unknown lecture.`);
        await tx.insert(notes).values({ ...base, attachKind: "lecture", lectureId });
      } else if (a.kind === "assignment") {
        const [row] = await tx
          .select({ id: assignments.id })
          .from(assignments)
          .where(and(eq(assignments.userId, userId), eq(assignments.courseId, courseId), eq(assignments.name, a.name)))
          .limit(1);
        if (!row) throw new Error(`seedLearn: note ${note.key} names an unknown assignment "${a.name}".`);
        await tx.insert(notes).values({ ...base, attachKind: "assignment", assignmentId: row.id });
      } else {
        await tx.insert(notes).values({ ...base, attachKind: "course" });
      }
      out.notes++;
    }
    return out;
  });
}
