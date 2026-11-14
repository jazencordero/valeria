// Reads what is coming up on her Moodle calendar (core_calendar_get_action_events_by_timesort)
// and the open and close times of her quizzes (mod_quiz_get_quizzes_by_courses).
// Cut: no site-wide or personal calendar entries, only events that belong to a course.

import { z } from "zod";
import { callMoodle, NotAllowed, type MoodleConn } from "../client";
import { parseAnswer } from "./site";

const FN_EVENTS = "core_calendar_get_action_events_by_timesort";
const FN_QUIZZES = "mod_quiz_get_quizzes_by_courses";

// Moodle sends times as Unix seconds and 0 for "not set".
const seconds = z.number().int().nonnegative();

function toDate(s: number | null | undefined): Date | null {
  return s ? new Date(s * 1000) : null;
}

function toSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Upcoming events

/** Moodle's largest page for this function; it cuts any larger limit to 50. */
export const EVENTS_PAGE = 50;
/** Pages read at most per call (200 events), so a busy calendar cannot eat the daily request budget. */
export const MAX_EVENT_PAGES = 4;

const EventsAnswer = z.object({
  events: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      // Null or missing for events that are not about an activity.
      modulename: z.string().nullish(),
      instance: z.number().int().nullish(),
      eventtype: z.string(),
      // 0 for site and personal events. Older Moodle versions send only one of the two.
      courseid: z.number().int().nullish(),
      course: z.object({ id: z.number().int() }).nullish(),
      timestart: seconds,
      timesort: seconds.optional(),
      url: z.string().nullish(),
      action: z.object({ url: z.string().nullish() }).nullish(),
    }),
  ),
  firstid: z.number().int().nullish(),
  lastid: z.number().int().nullish(),
});

// Event types that never belong to a course, even if Moodle fills in a course id.
const NOT_COURSE_EVENTS = new Set(["site", "user", "category"]);

export type CalendarModule = "assign" | "quiz" | "other";

export type CalendarEvent = {
  /** `event:<Moodle event id>`. */
  moodleRef: string;
  courseMoodleId: number;
  title: string;
  /** When it is due or closes: Moodle's sort time (the date the calendar files it under). */
  startsAt: Date;
  module: CalendarModule;
  /** Link to the activity on Moodle, or to the action on it; null when Moodle gives neither. */
  url: string | null;
};

type RawEvent = z.output<typeof EventsAnswer>["events"][number];

function toEvent(e: RawEvent): CalendarEvent | null {
  const courseMoodleId = e.course?.id || e.courseid || 0;
  if (!courseMoodleId || NOT_COURSE_EVENTS.has(e.eventtype)) return null;
  const kind: CalendarModule = e.modulename === "assign" || e.modulename === "quiz" ? e.modulename : "other";
  return {
    moodleRef: `event:${e.id}`,
    courseMoodleId,
    title: e.name,
    startsAt: new Date((e.timesort || e.timestart) * 1000),
    module: kind,
    url: e.url || e.action?.url || null,
  };
}

/**
 * Course events whose date falls between `from` and `to`, oldest first.
 * Moodle answers at most 50 a time; when a page comes back full we ask for the
 * next one after its last event, up to MAX_EVENT_PAGES pages.
 */
export async function getUpcoming(conn: MoodleConn, range: { from: Date; to: Date }): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let afterEventId: number | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const raw = await callMoodle(conn, FN_EVENTS, {
      timesortfrom: toSeconds(range.from),
      timesortto: toSeconds(range.to),
      limitnum: EVENTS_PAGE,
      aftereventid: afterEventId,
    });
    const answer = parseAnswer(FN_EVENTS, EventsAnswer, raw);
    for (const e of answer.events) {
      const event = toEvent(e);
      if (event) out.push(event);
    }
    const lastId = answer.lastid ?? answer.events.at(-1)?.id;
    if (answer.events.length < EVENTS_PAGE || !lastId) break;
    afterEventId = lastId;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quizzes

const QuizzesAnswer = z.object({
  quizzes: z.array(
    z.object({
      id: z.number().int(),
      course: z.number().int(),
      name: z.string(),
      // Moodle leaves these out when she may not see the quiz's settings.
      timeopen: seconds.optional(),
      timeclose: seconds.optional(),
    }),
  ),
});

export type Quiz = {
  /** `quiz:<Moodle quiz id>`. */
  moodleRef: string;
  courseMoodleId: number;
  name: string;
  /** null when the quiz is open from the start. */
  opensAt: Date | null;
  /** null when the quiz never closes. */
  closesAt: Date | null;
};

/**
 * Every quiz in these courses. An empty list returns [] without asking Moodle,
 * because Moodle reads no course ids as "all her courses". If her key may not
 * call the quiz function (NotAllowed), this is an empty list too; any other
 * error is thrown.
 */
export async function getQuizzes(conn: MoodleConn, courseIds: number[]): Promise<Quiz[]> {
  if (courseIds.length === 0) return [];
  let raw: unknown;
  try {
    raw = await callMoodle(conn, FN_QUIZZES, { courseids: courseIds });
  } catch (err) {
    if (err instanceof NotAllowed) return [];
    throw err;
  }
  const answer = parseAnswer(FN_QUIZZES, QuizzesAnswer, raw);
  return answer.quizzes.map((q) => ({
    moodleRef: `quiz:${q.id}`,
    courseMoodleId: q.course,
    name: q.name,
    opensAt: toDate(q.timeopen),
    closesAt: toDate(q.timeclose),
  }));
}
