// Reads the courses she is enrolled in (core_enrol_get_users_courses).
// Cut: no course images, no categories.

import { z } from "zod";
import { callMoodle, type MoodleConn } from "../client";
import { parseAnswer } from "./site";

const FN = "core_enrol_get_users_courses";

const CoursesAnswer = z.array(
  z.object({
    id: z.number().int(),
    shortname: z.string(),
    fullname: z.string(),
  }),
);

export type Course = {
  moodleId: number;
  /** Course code such as "ISM-E1005", "CS-A1110" or "37E00200"; null when the names carry none. */
  code: string | null;
  name: string;
  shortName: string;
};

// Aalto-style codes: a 2-5 letter prefix, a dash, a letter and 3-5 digits (ISM-E1005, CS-A1110,
// ELEC-C7420), or two digits, a letter and five digits (37E00200, 31E00100).
const CODE = /(?<![A-Za-z0-9-])(?:[A-Z]{2,5}-[A-Z]\d{3,5}|\d{2}[A-Z]\d{5})(?![A-Za-z0-9])/;

/** The first course code in `text`, or null. */
export function extractCode(text: string): string | null {
  return CODE.exec(text)?.[0] ?? null;
}

/**
 * The course name without a leading "<code> - ". MyCourses starts every full name with the code
 * ("ISM-E1005 - Forecasting Methods, Contact teaching, 31.8.2026-12.10.2026"); the code is kept
 * apart in `code`, so the name does not repeat it. Anything else is left as Moodle sent it.
 */
export function nameWithoutCode(fullname: string, code: string | null): string {
  if (!code || !fullname.startsWith(code)) return fullname;
  const rest = /^\s*[-\u2013\u2014:]\s*(\S[\s\S]*)$/.exec(fullname.slice(code.length));
  return rest ? rest[1] : fullname;
}

export async function getCourses(conn: MoodleConn, userId: number): Promise<Course[]> {
  const raw = await callMoodle(conn, FN, { userid: userId });
  return parseAnswer(FN, CoursesAnswer, raw).map((c) => {
    // MyCourses short names are "<code>_aalto-cur-P-<uuid>"; the code is the part before "_".
    const code = extractCode(c.shortname) ?? extractCode(c.fullname);
    return {
      moodleId: c.id,
      code,
      name: nameWithoutCode(c.fullname, code),
      shortName: c.shortname,
    };
  });
}
