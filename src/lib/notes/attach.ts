/**
 * What a note is attached to, as words and from a page (ticket M9-11). Pure.
 *
 * `attachLabel(note, lookups)` is the chip and pill text:
 * - general (or a link whose thing is gone): "General"
 * - lecture: "Lecture 5 · Sourcing and vendors"
 * - assignment: the assignment name
 * - exam: "Exam · Strategic IT Management" (the course name); a quiz uses its
 *   own title instead of "Exam", e.g. "Quiz 4 · Forecasting Methods"
 * - course: the course name
 * The caller builds `lookups` from rows it already has; a missing entry falls
 * back to "General" (notes outlive what they are attached to).
 *
 * `attachFromPath(pathname)` says what a new note made on that page attaches
 * to. Routes (the `(app)` group in the ticket files):
 * - `/courses/<courseId>/lectures/<n>` -> lecture, as `{ courseId, n }`:
 *   the URL has the lecture number, not its id, so the caller (the notes
 *   server action) resolves it to the lecture id before saving
 * - `/courses/<courseId>` (and any other page under it) and
 *   `/grades/<courseId>` -> that course
 * - `/assignments/<id>` -> that assignment
 * - `/exams/<id>` -> that exam
 * - anything else (Home, the lists, Notes, Calendar, Settings, a study
 *   session, an id that is not a uuid, a lecture number that is not a
 *   positive whole number) -> general
 * A query string, hash or trailing slash is ignored.
 */

export type NoteAttachKind = "general" | "lecture" | "course" | "assignment" | "exam";

/** A stored note's link. `id` is null for general, and when the thing it pointed at was deleted. */
export type NoteAttach = { kind: NoteAttachKind; id: string | null };

export type AttachLookups = {
  courses?: Readonly<Record<string, { name: string }>>;
  lectures?: Readonly<Record<string, { n: number; title: string }>>;
  assignments?: Readonly<Record<string, { name: string }>>;
  exams?: Readonly<Record<string, { kind: "exam" | "quiz"; title: string; courseName: string }>>;
};

export const GENERAL = "General";

export function attachLabel(note: { attach: NoteAttach }, lookups: AttachLookups): string {
  const { kind, id } = note.attach;
  if (kind === "general" || id === null) return GENERAL;
  switch (kind) {
    case "lecture": {
      const l = lookups.lectures?.[id];
      return l ? `Lecture ${l.n} · ${l.title}` : GENERAL;
    }
    case "assignment":
      return lookups.assignments?.[id]?.name ?? GENERAL;
    case "exam": {
      const e = lookups.exams?.[id];
      if (!e) return GENERAL;
      return `${e.kind === "quiz" ? e.title : "Exam"} · ${e.courseName}`;
    }
    case "course":
      return lookups.courses?.[id]?.name ?? GENERAL;
  }
}

/** What a new note attaches to, from the page. Lectures come as course + number (see above). */
export type PathAttach =
  | { kind: "general" }
  | { kind: "course"; id: string }
  | { kind: "lecture"; courseId: string; n: number }
  | { kind: "assignment"; id: string }
  | { kind: "exam"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function attachFromPath(pathname: string): PathAttach {
  const path = pathname.split(/[?#]/, 1)[0];
  const parts = path.split("/").filter(Boolean);
  const [section, id, sub, n, ...rest] = parts;
  if (!id || !UUID.test(id)) return { kind: "general" };
  switch (section) {
    case "courses":
      if (sub === undefined) return { kind: "course", id };
      if (sub === "lectures" && n !== undefined && /^[1-9]\d*$/.test(n) && rest.length === 0) {
        return { kind: "lecture", courseId: id, n: Number(n) };
      }
      return { kind: "course", id };
    case "grades":
      return { kind: "course", id };
    case "assignments":
      return { kind: "assignment", id };
    case "exams":
      return { kind: "exam", id };
    default:
      return { kind: "general" };
  }
}
