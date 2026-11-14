/*
 * Gives every visitor a `ready_session` cookie before anything renders.
 *
 * This file only mints the random token; it never touches the database.
 * Proxy runs in the Node.js runtime, but it is bundled and invoked apart from
 * the render code (the docs say not to rely on shared modules or globals, and
 * not to use Proxy for session management). Opening the DB here would mean a
 * second PGlite on the same data folder in dev. So the user and session rows
 * are created lazily by `ensureSession()` in `src/server/auth/session.ts`,
 * the first time server code asks for them.
 *
 * Server Components cannot set cookies, which is why the cookie is set here:
 * by the time a page calls `ensureSession()`, the browser already holds the
 * token, and this same request carries it too (it is copied onto the request).
 *
 * Keep the name and options in step with `session.ts` (a test checks).
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "ready_session";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
/** 32 random bytes as base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function proxy(request: NextRequest) {
  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && TOKEN_PATTERN.test(existing)) return NextResponse.next();

  const token = mintToken();
  // Let this request's render see the token as if the browser had sent it.
  request.cookies.set(SESSION_COOKIE, token);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure everywhere except `next dev` on plain http (Safari drops Secure
    // cookies on http://localhost). Vercel previews and production are https.
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
  return response;
}

export const config = {
  matcher: [
    // Every page, route handler and server function, but not build assets,
    // image optimisation, or files with an extension (favicon.ico, *.png ...).
    "/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
