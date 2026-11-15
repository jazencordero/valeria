/**
 * One lecture page (M9-15), ready to draw.
 * Source: prototype merged-2.html JS 5497-5536 (notesFor, lecturePageHTML,
 * renderLecNotes).
 *
 *   const page = await getLecturePage(userId, courseId, n, { now });  // null: 404
 *
 * Reads our database only, her rows only. Another user's course or lecture,
 * a hidden course, an unknown or malformed id, or a lecture number the
 * course does not have all give `null`.
 *
 * Choices:
 * - State comes from `courseView` (M9-03), as on the course path: a lecture
 *   still ahead (`soon`) is "not-posted"; a posted one without a
 *   `lecture_content` row yet is "writing"; otherwise "ready". A thin deck
 *   (M9-05: no breath, no sections) is "ready" with only the end block.
 * - Sections: M9-05's `[kind, …]` blocks become the reader's blocks; the
 *   slide range ("slides 2–5") is shown in capitals, "SLIDES 2–5".
 * - "From n slides": the file's page count (`file_pages`), else the number
 *   of slide titles.
 * - Cards: the count `lectureCards` gives (src/server/study/lecture-session.ts),
 *   the same cards "Practise this lecture" starts a session with, so the
 *   button never claims a card the session will not hold. 0: disabled.
 * - Practise goes to `/study/new?lecture=<id>&return=<this page>`.
 * - Next: lecture n + 1 when the course has one, whatever its state.
 * - Notes: the notes attached to this lecture (`notesForLecture`, newest
 *   edit first), as the Notes tab draws them: "Lecture 5 · title" pill,
 *   "TODAY" or "THU 12 NOV".
 */
import { and, count, eq } from "drizzle-orm";
import type { NoteCardData } from "@/components/notes/note-card";
import type { LectureBlock, LectureSection } from "@/components/lecture/reader";
import { sameDay } from "@/lib/dates";
import { attachLabel } from "@/lib/notes/attach";
import { CourseNotFound, courseView } from "@/server/courses/store";
import { shortNameOf } from "@/server/data/courses";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { lectureContent } from "@/server/db/schema/learn";
import { notesForLecture } from "@/server/notes/store";
import { lectureCards } from "@/server/study/lecture-session";

const TIME_ZONE = "Europe/Helsinki";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LecturePageData = {
  courseId: string;
  /** Short course name: the back button's label and the header. */
  course: string;
  lectureId: string;
  n: number;
  title: string;
  status: "ready" | "not-posted" | "writing";
  /** Read already (before this visit). */
  read: boolean;
  file: { id: string; name: string } | null;
  /** Not posted: "Mon 16 Nov". */
  opensOn: string | null;
  minutes: number | null;
  slideCount: number | null;
  breath: string | null;
  sections: LectureSection[];
  slideTitles: string[];
  /** Cards "Practise this lecture" would start with. */
  cards: number;
  /** Where "Practise this lecture" goes; null when there are no cards. */
  practiseHref: string | null;
  next: { n: number; href: string } | null;
  backHref: string;
  /** This page's path, for the session to come back to. */
  href: string;
  notes: NoteCardData[];
};

export const lectureHref = (courseId: string, n: number) => `/courses/${encodeURIComponent(courseId)}/lectures/${n}`;

export function practiseHref(lectureId: string, back: string): string {
  return `/study/new?lecture=${encodeURIComponent(lectureId)}&return=${encodeURIComponent(back)}`;
}

/** M9-05's stored blocks as the reader takes them; anything else is dropped. */
export function blocksOf(raw: unknown): LectureBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: LectureBlock[] = [];
  for (const b of raw) {
    if (!Array.isArray(b)) continue;
    const [kind, value] = b as [unknown, unknown];
    if (kind === "p" && typeof value === "string") out.push({ kind: "p", text: value });
    else if (kind === "ul" && Array.isArray(value)) {
      out.push({ kind: "ul", items: value.filter((x): x is string => typeof x === "string") });
    } else if (kind === "dl" && Array.isArray(value)) {
      const items = value
        .filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string")
        .map(([term, def]) => ({ term, def }));
      out.push({ kind: "dl", items });
    }
  }
  return out;
}

export function sectionsOf(raw: unknown): LectureSection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({
      heading: typeof s.heading === "string" ? s.heading : "",
      blocks: blocksOf(s.blocks),
      terms: Array.isArray(s.terms) ? s.terms.filter((t): t is string => typeof t === "string") : [],
      source: typeof s.slides === "string" ? s.slides.toUpperCase() : "",
    }));
}

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short" });

function parts(at: Date): Record<string, string> {
  return Object.fromEntries(DAY.formatToParts(at).map((x) => [x.type, x.value]));
}

/** "Mon 16 Nov". */
function dayText(at: Date): string {
  const p = parts(at);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "THU 12 NOV", or "TODAY", as the Notes tab dates a card. */
function cardDate(at: Date, now: Date): string {
  return sameDay(at, now) ? "TODAY" : dayText(at).toUpperCase();
}

export async function getLecturePage(
  userId: string,
  courseId: string,
  nParam: string,
  options: { now: Date },
  database: Db = defaultDb,
): Promise<LecturePageData | null> {
  const { now } = options;
  if (!UUID.test(courseId) || !/^[1-9]\d{0,5}$/.test(nParam)) return null;
  const n = Number(nParam);

  const [row] = await database
    .select({ hidden: courses.hidden })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)));
  if (!row || row.hidden) return null;

  let view;
  try {
    view = await courseView(userId, courseId, database, now);
  } catch (err) {
    if (err instanceof CourseNotFound) return null;
    throw err;
  }
  const lecture = view.lectures.find((l) => l.n === n);
  if (!lecture) return null;
  const nextLecture = view.lectures.find((l) => l.n === n + 1) ?? null;

  const [[content], [file], [pages], picked, notes] = await Promise.all([
    database.select().from(lectureContent).where(eq(lectureContent.lectureId, lecture.id)),
    lecture.fileId
      ? database
          .select({ id: courseFiles.id, name: courseFiles.name })
          .from(courseFiles)
          .where(and(eq(courseFiles.id, lecture.fileId), eq(courseFiles.userId, userId)))
      : Promise.resolve([] as { id: string; name: string }[]),
    lecture.fileId
      ? database.select({ n: count() }).from(filePages).where(eq(filePages.fileId, lecture.fileId))
      : Promise.resolve([] as { n: number }[]),
    lectureCards(userId, lecture.id, database),
    notesForLecture(userId, lecture.id, database),
  ]);

  const href = lectureHref(courseId, n);
  const status: LecturePageData["status"] = lecture.state === "soon" ? "not-posted" : content ? "ready" : "writing";
  const slideTitles = content ? (content.slideTitles ?? []).filter((t): t is string => typeof t === "string") : [];
  const pageCount = pages ? Number(pages.n) : 0;
  const cards = picked.cardIds.length;
  const lookups = { lectures: { [lecture.id]: { n: lecture.n, title: lecture.title } } };

  return {
    courseId,
    course: shortNameOf(view.course.name),
    lectureId: lecture.id,
    n,
    title: lecture.title,
    status,
    read: lecture.readAt !== null,
    file: status === "not-posted" ? null : (file ?? null),
    opensOn: lecture.opensAt ? dayText(lecture.opensAt) : null,
    minutes: content?.minutes ?? null,
    slideCount: pageCount || slideTitles.length || null,
    breath: content?.breath ?? null,
    sections: content ? sectionsOf(content.sections) : [],
    slideTitles,
    cards,
    practiseHref: cards > 0 ? practiseHref(lecture.id, href) : null,
    next: nextLecture ? { n: nextLecture.n, href: lectureHref(courseId, nextLecture.n) } : null,
    backHref: `/courses/${encodeURIComponent(courseId)}`,
    href,
    notes: notes.map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      quote: note.quote,
      highlighted: note.highlighted,
      attachLabel: attachLabel(note, lookups),
      date: cardDate(note.updatedAt, now),
    })),
  };
}
