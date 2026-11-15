/*
 * The schools Ready knows (M5-01). The one place that names a school's LMS:
 * screens take `lmsName` as a prop and get it from `lmsNameOf(user)`, so no
 * screen says "MyCourses" to a LUT student (tests/arch/no-hardcoded-lms.test.ts).
 *
 * A school can connect only when it is `enabled` and has a `siteUrl`;
 * `allowedSiteUrls()` is the list `src/server/moodle/connect.ts` accepts keys for.
 * LUT is listed but cannot connect until M8-18.
 *
 * `users.school` holds a key of `SCHOOLS`. When it is empty or not a key we
 * know (older rows, a school removed later), `schoolOf` answers Aalto
 * (`DEFAULT_SCHOOL`): every user so far is an Aalto student, and Aalto is the
 * only school that can connect.
 *
 * Test flag (M5-08): `READY_FORCE_SCHOOL=lut` (any key of `SCHOOLS`) makes
 * `schoolIdOf` answer that school for every user, so per-school copy can be
 * checked without a school picked ("Connect Moodle", not "MyCourses", for
 * LUT). Honoured only with the fake Moodle on (`MOODLE_FAKE=1`) or under
 * tests (`NODE_ENV=test`), and never on a Vercel production deploy
 * (`VERCEL_ENV=production`). See `forcedSchool`.
 */

export type School = {
  /** Short name, as in "Aalto". */
  name: string;
  /** Full name, as in "Aalto University". */
  full: string;
  /** Where it is. */
  where: string;
  /** What students call its Moodle, as in "MyCourses". */
  lms: string;
  /** "a" or "an", for "an Aalto student". */
  article: "a" | "an";
  /** The line the sorting scene says when she picks it. */
  quip: string;
  /** The Moodle site, https and no trailing slash. Null until we know it. */
  siteUrl: string | null;
  /** Whether she can connect to it now. */
  enabled: boolean;
};

export const SCHOOLS = {
  aalto: {
    name: "Aalto",
    full: "Aalto University",
    where: "Espoo",
    lms: "MyCourses",
    article: "an",
    quip: "Aalto. Ambitious. I respect it.",
    siteUrl: "https://mycourses.aalto.fi",
    enabled: true,
  },
  lut: {
    name: "LUT",
    full: "LUT University",
    where: "Lappeenranta and Lahti",
    lms: "Moodle",
    article: "a",
    quip: "LUT. Lakes, saunas and group work. Nice.",
    siteUrl: null,
    enabled: false,
  },
} as const satisfies Record<string, School>;

export type SchoolId = keyof typeof SCHOOLS;

/** The school a user with no (or an unknown) school belongs to. */
export const DEFAULT_SCHOOL: SchoolId = "aalto";

/** Every school id, in list order. */
export const SCHOOL_IDS = Object.keys(SCHOOLS) as SchoolId[];

export function isSchoolId(value: unknown): value is SchoolId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SCHOOLS, value);
}

/** Just the part of a user row this file reads. */
export type WithSchool = { school?: string | null } | null | undefined;

type Env = Partial<Record<string, string | undefined>>;

function serverEnv(): Env {
  // In the browser `process` may be missing; the flag is a server thing anyway.
  return typeof process === "undefined" ? {} : process.env;
}

/**
 * The school `READY_FORCE_SCHOOL` forces, or null. Null on a Vercel
 * production deploy, and unless the fake Moodle is on or tests are running.
 * An unknown value is ignored.
 */
export function forcedSchool(env: Env = serverEnv()): SchoolId | null {
  if (env.VERCEL_ENV === "production") return null;
  if (env.MOODLE_FAKE !== "1" && env.NODE_ENV !== "test") return null;
  const id = env.READY_FORCE_SCHOOL?.trim().toLowerCase();
  return isSchoolId(id) ? id : null;
}

/** Her school's id; `DEFAULT_SCHOOL` when the row has none or one we do not know. `forcedSchool` wins when set. */
export function schoolIdOf(user: WithSchool): SchoolId {
  const forced = forcedSchool();
  if (forced) return forced;
  const id = user?.school;
  return isSchoolId(id) ? id : DEFAULT_SCHOOL;
}

/** Her school, with its id; Aalto when the row has none or one we do not know. */
export function schoolOf(user: WithSchool): School & { id: SchoolId } {
  const id = schoolIdOf(user);
  return { id, ...SCHOOLS[id] };
}

/** What her school calls its Moodle ("MyCourses" at Aalto, "Moodle" at LUT). */
export function lmsNameOf(user: WithSchool): string {
  return schoolOf(user).lms;
}

/** Whether the school can be connected to now: enabled and with a known site. */
export function canConnect(id: SchoolId): boolean {
  const school: School = SCHOOLS[id];
  return school.enabled && school.siteUrl !== null;
}

/** The Moodle sites a key may be connected to: those of schools that can connect, in list order. */
export function allowedSiteUrls(): string[] {
  return SCHOOL_IDS.filter(canConnect).map((id) => SCHOOLS[id].siteUrl as string);
}

