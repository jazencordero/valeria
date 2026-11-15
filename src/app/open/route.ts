/*
 * GET /open?code=...: the one-time link `scripts/study/seed-account.ts` prints (M3-57).
 *
 * The code is checked by `redeemOpenCode` (src/server/study/seed-account.ts): stored only as
 * sha256 in `confirm_codes` with purpose 'open', valid 15 minutes, used up by the first
 * request that brings it (one UPDATE, so two at once cannot both win). Then this browser gets
 * a new device session for that user, made as `session.ts` makes one (a fresh random token,
 * only its hash stored, the same cookie name and options), and lands on /home.
 *
 * Anything else (no code, a malformed, wrong, used or expired code, another purpose) gets the
 * same plain refusal, with nothing about why. The code is never logged here. Responses are
 * not cached and send no Referer onward.
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { redeemOpenCode } from "@/server/study/seed-account";

const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export async function GET(request: NextRequest) {
  const opened = await redeemOpenCode(db, request.nextUrl.searchParams.get("code"), {
    userAgent: request.headers.get("user-agent"),
  });
  if (!opened) {
    return new Response("This link does not work any more. Ask for a new one.", {
      status: 403,
      headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  const response = NextResponse.redirect(new URL("/home", request.url), { status: 303, headers: HEADERS });
  response.cookies.set(SESSION_COOKIE, opened.token, sessionCookieOptions());
  return response;
}
