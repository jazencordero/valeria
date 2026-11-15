/*
 * Runs before anything renders: decides who may see an app page, and drops
 * the one-time Home greeting cookie on a full load of Home.
 *
 * Signed in or not (M5-14). This file never touches the database (Proxy is
 * bundled and invoked apart from the render code, and opening the DB here
 * would mean a second PGlite on the same data folder in dev), so it decides
 * by the `ready_session` cookie alone: a well-formed one goes on; none (or a
 * malformed one) on any page that is not public goes to the welcome screen,
 * and the first-run start (/school) to sign up. The pages and the server
 * code still check the session row themselves.
 *
 * It no longer mints a cookie for every visitor. A device session is made by
 * sign up and log in (their Server Actions), by /demo and by an /open link
 * (route handlers), each of which sets the cookie itself, as `session.ts`
 * does. A browser that already holds a cookie from before keeps its device
 * user, so nobody who used Ready before accounts loses their data.
 *
 * Public, with or without a cookie: the front door (/, which sends a
 * cookie-less visitor to Welcome itself), /welcome, /login, /signup,
 * /privacy, /demo, /open, /logout, /api/... (each route checks on its own)
 * and /dev/... (preview pages).
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "ready_session";
/** Keep in step with `FLASH_COOKIE` in `src/server/data/flash.ts`. */
const FLASH_COOKIE = "ready_flash";
/** 32 random bytes as base64url, no padding. Same shape `session.ts` checks. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const PUBLIC_PAGES = new Set(["/", "/welcome", "/login", "/signup", "/privacy", "/demo", "/open", "/logout"]);
const PUBLIC_PREFIXES = ["/api/", "/dev/"];

/** Whether `pathname` may be seen without a session cookie. */
function isPublicPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (PUBLIC_PAGES.has(path) || path === "/api" || path === "/dev") return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
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
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const signedIn = session !== undefined && TOKEN_PATTERN.test(session);
  const { pathname } = request.nextUrl;
  if (!signedIn && !isPublicPath(pathname)) {
    // Starting the first run without an account means making one first.
    const to = pathname === "/school" ? "/signup" : "/welcome";
    return NextResponse.redirect(new URL(to, request.url), 303);
  }

  const dropFlash = request.cookies.has(FLASH_COOKIE) && isHomeDocument(request);
  if (!dropFlash) return NextResponse.next();
  request.cookies.delete(FLASH_COOKIE);
  // Pass the edited cookie header on to the render.
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.delete(FLASH_COOKIE);
  return response;
}

export const config = {
  matcher: [
    // Every page, route handler and server function, but not build assets,
    // image optimisation, or files with an extension (favicon.ico, *.png ...).
    "/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
