"use server";
/*
 * Sign up (M5-14). `signUpAction` is the only export, so the only endpoint.
 *
 * She picks a username and a password and ticks the yes (M8-33; the time goes in
 * `users.settings.agreedAt`, as the connect screen stores it). `signUp`
 * (src/server/auth/accounts.ts) makes a new user with them and a device session; this browser's
 * old device session is ended and the `ready_session` cookie set to the new one, with the
 * options `session.ts` uses. Then the first run: the school screen.
 *
 * A new user, not the device user this browser may already have: that one can be a demo or
 * hold someone's half-done first run, and none of it belongs in a fresh account.
 *
 * Nothing here logs a name or a password; the state sent back holds a sentence and the name she
 * typed, never the password.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { endDeviceSession, signUp } from "@/server/auth/accounts";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { db } from "@/server/db/client";

export type SignUpState = { error: string | null; username: string };

const field = (formData: FormData, name: string, max: number) => {
  const v = formData.get(name);
  return typeof v === "string" ? v.slice(0, max) : "";
};

export async function signUpAction(_prev: SignUpState, formData: FormData): Promise<SignUpState> {
  const username = field(formData, "username", 200);
  const password = field(formData, "password", 1000);
  if (!username.trim()) return { error: "Pick a username.", username };
  if (!password) return { error: "Pick a password.", username };
  if (formData.get("agree") !== "yes") return { error: "Tick the box to say yes first.", username };

  try {
    const now = new Date();
    const h = await headers();
    const result = await signUp(username, password, {
      db,
      now,
      userAgent: h.get("user-agent"),
      settings: { agreedAt: now.toISOString() },
    });
    if (!result.ok) return { error: result.error, username };
    const store = await cookies();
    await endDeviceSession(db, store.get(SESSION_COOKIE)?.value);
    store.set(SESSION_COOKIE, result.token, sessionCookieOptions());
  } catch (err) {
    console.error("Sign up failed:", err instanceof Error ? err.name : typeof err);
    return { error: "Something went wrong on our side. Try again in a minute.", username };
  }
  redirect("/school");
}
