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

export async function getCourses(conn: MoodleConn, userId: number): Promise<Course[]> {
  const raw = await callMoodle(conn, FN, { userid: userId });
  return parseAnswer(FN, CoursesAnswer, raw).map((c) => ({
    moodleId: c.id,
    code: extractCode(c.shortname) ?? extractCode(c.fullname),
    name: c.fullname,
    shortName: c.shortname,
  }));
}
