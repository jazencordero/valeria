/*
 * POST /api/seed: fill your own account from files, one part of a seed per request (M3-58).
 *
 * The seed tool (scripts/study/seed-account.ts) cannot reach the hosted database, so it sends
 * what it read from the files here instead. The parts, their validation and what is done with
 * them live in src/server/study/seed-account.ts ("Upload"): this file is only the door.
 *
 *   { "part": "account", ... }                    courses, assignments, calendar, weights, exams, AI rules
 *   { "part": "bundle", "kind": "exam", ... }     one course folder, or one batch of it
 *   { "part": "bundle", "kind": "studyOnly", ... }
 *   -> 200 { part, counts, ... }                  the counts a direct run prints (`SeedAnswer`)
 *
 * Whose account: the signed-in caller's, from the session cookie, never from the body. A body
 * that names a user (or a seed key) is refused; the parts have no field for one.
 *
 * Refusals, all JSON `{ error, message }`, never cached:
 *   415 wrong_type      Content-Type is not application/json
 *   403 cross_site      the request came from another site (see below), or the account is a demo
 *   401 not_signed_in   no valid session
 *   413 too_large       over 4 MB, by Content-Length or by the bytes actually read
 *   429 too_many        over 30 requests in an hour for this user; Retry-After says how long
 *   400 invalid         not JSON, or the part does not fit: `problems` names each path, never a value
 *   409 refused         the account part, once the account has a Moodle connection (the sync owns it then)
 *
 * Cross-site requests. The session cookie is SameSite=Lax, so a browser does not send it with a
 * POST from another site. On top of that this route only takes `application/json` (a form on
 * another site cannot send it, and a script there would need a CORS preflight that nothing here
 * answers), and it refuses a request whose `Sec-Fetch-Site` is not same-origin / none or whose
 * `Origin` names another host than this one (`x-forwarded-host`, else `host`: the comparison
 * Next.js makes for Server Actions). The tool is not a browser and sends neither header.
 *
 * Limits. The body is read as a stream and dropped as soon as it passes 4 MB, whatever
 * Content-Length said. The hourly count is `allow()` (src/server/throttle.ts): one UPDATE on
 * `users.settings.throttle`, so no new table and no lost counts between server instances. It is
 * taken before the body is read, so refused and invalid parts count too.
 *
 * Nothing of a part is logged: not on a refusal, and not when the database throws (a failed
 * query's message carries its values, so only the error's name is written).
 *
 * A POST handler is never prerendered (Cache Components prerenders GET only), and this one
 * reads the request's cookies and body, so it runs per request with no config.
 * maxDuration: set as node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says;
 * a full batch of cards is a few hundred rows.
 */
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { currentUserFor, NotSignedIn, SESSION_COOKIE, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";
import { isDemo } from "@/server/demo/seed";
import { applyAccountPart, applyBundlePart, readSeedPart, SeedInvalid, SeedRefused, UPLOAD_MAX_BYTES, type SeedPart } from "@/server/study/seed-account";
import { allow } from "@/server/throttle";

export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const THROTTLE_KEY = "seed-upload";
const LIMIT = { max: 30, perSeconds: 60 * 60 };
const MB = UPLOAD_MAX_BYTES / (1024 * 1024);
const TOO_LARGE = `This part is over ${MB} MB. Send it as several smaller parts: a bundle's cards and pages can be split into batches.`;

function refuse(status: number, error: string, message: string, more: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return Response.json({ error, message, ...more }, { status, headers: { ...NO_STORE, ...headers } });
}

/** True when a browser says this request was made by another site. */
function fromAnotherSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const here = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host).split(",")[0].trim();
  try {
    return new URL(origin).host !== here;
  } catch {
    return true; // "null", or not a URL
  }
}

/** The body's bytes, or null as soon as there are more than `max`. */
async function readUpTo(request: Request, max: number): Promise<Buffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Seconds until this user's hour starts over. */
async function retryAfter(userId: string, now: number): Promise<number> {
  const [row] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  const throttle = row?.settings?.throttle as Record<string, { start?: unknown }> | undefined;
  const start = Number(throttle?.[THROTTLE_KEY]?.start);
  const left = Number.isFinite(start) ? Math.ceil((start + LIMIT.perSeconds * 1000 - now) / 1000) : LIMIT.perSeconds;
  return Math.min(LIMIT.perSeconds, Math.max(1, left));
}

export async function POST(request: NextRequest) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "wrong_type", "Send the part as JSON (Content-Type: application/json).");
  if (fromAnotherSite(request)) return refuse(403, "cross_site", "This request came from another site.");

  let user: User;
  try {
    user = await currentUserFor(db, request.cookies.get(SESSION_COOKIE)?.value);
  } catch (err) {
    if (err instanceof NotSignedIn) return refuse(401, "not_signed_in", "Sign in first.");
    throw err;
  }
  if (isDemo(user)) return refuse(403, "demo", "A demo account cannot be filled from files.");

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) return refuse(413, "too_large", TOO_LARGE);

  const now = Date.now();
  if (!(await allow(THROTTLE_KEY, LIMIT, { userId: user.id, db, now }))) {
    const seconds = await retryAfter(user.id, now);
    return refuse(429, "too_many", `Over ${LIMIT.max} parts in an hour. Try again in ${Math.ceil(seconds / 60)} minutes.`, {}, { "Retry-After": String(seconds) });
  }

  const bytes = await readUpTo(request, UPLOAD_MAX_BYTES);
  if (bytes === null) return refuse(413, "too_large", TOO_LARGE);

  let part: SeedPart;
  try {
    part = readSeedPart(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (err) {
    if (err instanceof SeedInvalid) return refuse(400, "invalid", "The part does not fit; nothing was written.", { problems: err.problems });
    return refuse(400, "invalid", "The body is not valid JSON; nothing was written.", { problems: [] });
  }

  try {
    const answer = part.part === "account" ? await applyAccountPart(db, user.id, part) : await applyBundlePart(db, user.id, part);
    return Response.json(answer, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SeedInvalid) return refuse(400, "invalid", "The part does not fit; nothing was written.", { problems: err.problems });
    if (err instanceof SeedRefused) return refuse(409, "refused", err.message);
    // A failed query's message holds its values (card text, assignment names): never log it.
    console.error("POST /api/seed failed:", err instanceof Error ? err.name : "unknown error");
    return refuse(500, "failed", "The part could not be written. Nothing of it was kept; send it again.");
  }
}
