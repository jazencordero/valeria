"use server";
/*
 * Log in (M5-14). `logInAction` is the only export, so the only endpoint.
 *
 * It checks the name and password with `logIn` (src/server/auth/accounts.ts: one answer for a
 * wrong name and a wrong password, the 5-per-name and 20-per-address brake), then ends the
 * device session this browser had (if any) and sets the `ready_session` cookie to the new one,
 * with the options `session.ts` uses. The account lands on Home, or on the first run when it
 * never started one (`landingFor`); never on /connect just for having no Moodle connection.
 *
 * The address for the brake is the one the host reports (Vercel sets `x-real-ip` and
 * `x-forwarded-for` itself). Nothing here logs a name, a password or an address; the state sent
 * back holds a sentence and the name she typed, never the password.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { endDeviceSession, landingFor, logIn } from "@/server/auth/accounts";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { db } from "@/server/db/client";

export type LogInState = { error: string | null; username: string };

const field = (formData: FormData, name: string, max: number) => {
  const v = formData.get(name);
  return typeof v === "string" ? v.slice(0, max) : "";
};

function clientAddress(h: Headers): string | null {
  const direct = h.get("x-real-ip")?.trim();
  if (direct) return direct;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

export async function logInAction(_prev: LogInState, formData: FormData): Promise<LogInState> {
  const username = field(formData, "username", 200);
  // Longer than any allowed password: cut, so a huge body costs no more than a long password.
  const password = field(formData, "password", 1000);
  if (!username.trim() || !password) return { error: "Type your username and your password.", username };

  const h = await headers();
  let landing: "/home" | "/school";
  try {
    const result = await logIn(username, password, {
      db,
      address: clientAddress(h),
      userAgent: h.get("user-agent"),
    });
    if (!result.ok) return { error: result.error, username };
    const store = await cookies();
    await endDeviceSession(db, store.get(SESSION_COOKIE)?.value);
    store.set(SESSION_COOKIE, result.token, sessionCookieOptions());
    landing = await landingFor(db, result.userId);
  } catch (err) {
    console.error("Log in failed:", err instanceof Error ? err.name : typeof err);
    return { error: "Something went wrong on our side. Try again in a minute.", username };
  }
  redirect(landing);
}
