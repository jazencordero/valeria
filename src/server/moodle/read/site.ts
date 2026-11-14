// Reads who she is and what her Moodle key may do (core_webservice_get_site_info).
// Also home of the shared answer check every reader uses: `parseAnswer`.

import { z } from "zod";
import { callMoodle, MoodleError, type MoodleConn } from "../client";

/**
 * Moodle answered, but not in the shape we expect. The message names the
 * function and the failing path (for example `courses[2].shortname`), never
 * the data, so it is safe to log.
 */
export class UnexpectedAnswer extends MoodleError {
  readonly fn: string;
  readonly path: string;
  constructor(fn: string, path: string) {
    super(`Moodle answered ${fn} in an unexpected shape at ${path}`, { errorcode: "unexpectedanswer" });
    this.name = "UnexpectedAnswer";
    this.fn = fn;
    this.path = path;
  }
}

/** `["courses", 2, "shortname"]` becomes `courses[2].shortname`; an empty path is `(root)`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out ? `.${String(key)}` : String(key);
  }
  return out || "(root)";
}

/**
 * Check a raw Moodle answer against `schema`. Unknown fields are dropped
 * (zod objects strip by default). On a mismatch throws UnexpectedAnswer with
 * the first failing path.
 */
export function parseAnswer<S extends z.ZodType>(fn: string, schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new UnexpectedAnswer(fn, formatPath(first?.path ?? []));
}

const FN = "core_webservice_get_site_info";

// Moodle sends some flags as 0/1 and some as booleans, depending on version.
const flag = z.union([z.boolean(), z.number()]);

const SiteInfoAnswer = z.object({
  userid: z.number().int(),
  fullname: z.string(),
  sitename: z.string(),
  release: z.string().optional(),
  functions: z.array(z.object({ name: z.string() })),
  uploadfiles: flag.optional(),
  usermaxuploadfilesize: z.number().optional(),
});

export type SiteInfo = {
  userId: number;
  fullName: string;
  siteName: string;
  /** Moodle release text, for example "4.5.1 (Build: 20241209)"; null when Moodle leaves it out. */
  release: string | null;
  /** Names of the web service functions her key may call. */
  functions: string[];
  /** Whether her key may upload files to her draft area (needed to hand in files). */
  canUpload: boolean;
  /** Largest file she may upload, in bytes; null when there is no limit or Moodle does not say. */
  maxUploadBytes: number | null;
};

export async function getSiteInfo(conn: MoodleConn): Promise<SiteInfo> {
  const raw = await callMoodle(conn, FN);
  const a = parseAnswer(FN, SiteInfoAnswer, raw);
  return {
    userId: a.userid,
    fullName: a.fullname,
    siteName: a.sitename,
    release: a.release ?? null,
    functions: a.functions.map((f) => f.name),
    canUpload: Boolean(a.uploadfiles),
    // Moodle uses -1 for "may ignore size limits" and 0 for "no limit set": both become null (no known cap).
    maxUploadBytes: a.usermaxuploadfilesize !== undefined && a.usermaxuploadfilesize > 0 ? a.usermaxuploadfilesize : null,
  };
}
