/*
 * POST /logout (M5-14): ends this device's session and goes to the welcome screen.
 *
 * Only this browser's session row is deleted (other devices stay signed in) and the
 * `ready_session` cookie is cleared, so the proxy sends any app page to Welcome from now on.
 * The account and its data stay. POST only: a GET (a link, a prefetch) gets 405 from Next, so
 * nothing can log her out by being looked at. The cookie is SameSite=Lax, so a form posted from
 * another site carries no cookie and ends nothing. 303 so the browser follows with a GET.
 */
import { NextResponse, type NextRequest } from "next/server";
import { endDeviceSession } from "@/server/auth/accounts";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { db } from "@/server/db/client";

export async function POST(request: NextRequest) {
  await endDeviceSession(db, request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.redirect(new URL("/welcome", request.url), {
    status: 303,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
