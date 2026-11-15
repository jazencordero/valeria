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
/** Keep in step with `FLASH_COOKIE` in `src/server/data/flash.ts`. */
const FLASH_COOKIE = "ready_flash";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
/** 32 random bytes as base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The one-time Home greeting (M4-15). After a hand-in or a session, the client
 * navigates to Home and Home reads `ready_flash`. A navigation fetches Home in
 * more than one RSC request (the page segment can come after the layout), so
 * the cookie is not touched there. A full page load of Home (a reload, or
 * typing the address) drops it from both the request and the response, so a
 * reload no longer shows the greeting. It also expires by itself after 60 s.
 */
function isHomeDocument(request: NextRequest): boolean {
  if (request.method !== "GET" || request.nextUrl.pathname !== "/home") return false;
  const h = request.headers;
  // Prefetches (the router's, or the browser's own speculative ones) must not use it up unseen.
  if (h.has("next-router-prefetch") || h.get("purpose") === "prefetch" || (h.get("sec-purpose") ?? "").includes("prefetch")) {
    return false;
  }
  // Next strips its RSC markers before the proxy runs, so tell a page load apart
  // from a client navigation by what the browser says it is fetching.
  const dest = h.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return !h.has("next-url") && (h.get("accept") ?? "").includes("text/html");
}

export function proxy(request: NextRequest) {
  const dropFlash = request.cookies.has(FLASH_COOKIE) && isHomeDocument(request);
  if (dropFlash) request.cookies.delete(FLASH_COOKIE);
  const response = withSession(request, dropFlash);
  if (dropFlash) response.cookies.delete(FLASH_COOKIE);
  return response;
}

function withSession(request: NextRequest, requestChanged: boolean): NextResponse {
  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && TOKEN_PATTERN.test(existing)) {
    // Pass an edited cookie header on to the render when the flash was dropped.
    return requestChanged ? NextResponse.next({ request: { headers: request.headers } }) : NextResponse.next();
  }

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
