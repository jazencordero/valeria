/*
 * POST /api/login: log in without a browser (M3-58).
 *
 * The seed tool (scripts/study/seed-account.ts --upload) has a username and a password and
 * needs a session cookie; the log-in screen's Server Action cannot be called from a script. This
 * is the same check behind a plain door:
 *
 *   { "username": "...", "password": "..." }   Content-Type: application/json
 *   -> 200 { ok: true }   and Set-Cookie: ready_session=<token>, with the options session.ts uses
 *
 * The check is `logIn` (src/server/auth/accounts.ts), the one the screen's action calls, with
 * the same name and address: so the same single answer for a wrong name and a wrong password,
 * and the SAME counters. A failed try here counts against the 5 per name and 20 per address the
 * screen has, and the other way round; the two doors cannot be used to double the tries. The
 * screen's action (src/app/(first-run)/login/actions.ts) is not touched by this file.
 *
 * The token is only ever in the cookie, never in the body. An earlier session of the caller is
 * left alone (the tool has none).
 *
 * Refusals, all JSON `{ error, message }`, never cached:
 *   415 wrong_type   Content-Type is not application/json
 *   403 cross_site   a browser says the request came from another site (as POST /api/seed checks)
 *   413 too_large    over 4 kB, by Content-Length or by the bytes actually read
 *   400 invalid      not JSON, or no username and password as text
 *   401 no_match     the one answer for a wrong name and a wrong password
 *   429 too_many     the brake is on; Retry-After: 900 (it lifts within 15 minutes)
 *
 * Nothing here logs a name, a password, a token or an address.
 */
import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_WINDOW_MS, logIn, NO_MATCH, TOO_MANY } from "@/server/auth/accounts";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { db } from "@/server/db/client";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BYTES = 4096;

function refuse(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return Response.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
}

/** True when a browser says this request was made by another site. Keep in step with POST /api/seed. */
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

/** The address the host reports, as the log-in screen's action reads it (the same key for the brake). */
function clientAddress(h: Headers): string | null {
  const direct = h.get("x-real-ip")?.trim();
  if (direct) return direct;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

export async function POST(request: NextRequest) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "wrong_type", "Send the username and password as JSON (Content-Type: application/json).");
  if (fromAnotherSite(request)) return refuse(403, "cross_site", "This request came from another site.");

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return refuse(413, "too_large", "The request is too large.");
  const bytes = await readUpTo(request, MAX_BYTES);
  if (bytes === null) return refuse(413, "too_large", "The request is too large.");

  let username: unknown;
  let password: unknown;
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    ({ username, password } = body as Record<string, unknown>);
  } catch {
    return refuse(400, "invalid", 'Send {"username": "...", "password": "..."}.');
  }
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    return refuse(400, "invalid", 'Send {"username": "...", "password": "..."}.');
  }

  try {
    // Cut as the screen's action cuts them, so both doors hand `logIn` the same name.
    const result = await logIn(username.slice(0, 200), password.slice(0, 1000), {
      db,
      address: clientAddress(request.headers),
      userAgent: request.headers.get("user-agent"),
    });
    if (!result.ok) {
      if (result.error === TOO_MANY) return refuse(429, "too_many", TOO_MANY, { "Retry-After": String(LOGIN_WINDOW_MS / 1000) });
      return refuse(401, "no_match", NO_MATCH);
    }
    const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions());
    return response;
  } catch (err) {
    console.error("POST /api/login failed:", err instanceof Error ? err.name : typeof err);
    return refuse(500, "failed", "Something went wrong on our side. Try again in a minute.");
  }
}
