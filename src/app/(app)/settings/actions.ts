/*
 * Settings actions (M1-38): disconnect MyCourses, delete everything.
 *
 * The real work sits in plain functions that take a `Db` and a user id, so the
 * tests run them against `createTestDb()` with no request. The two Server
 * Actions are thin wrappers: find the signed-in user, call the plain function,
 * then touch the cookie and navigate.
 *
 * There is no file-level "use server" on purpose: that would turn every export
 * here (including `deleteAccountFor`, which takes any user id) into a callable
 * endpoint. Only the two `...Action` functions carry the directive.
 */
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  currentUser,
  NotSignedIn,
  SESSION_COOKIE,
  sessionCookieOptions,
  type User,
} from "@/server/auth/session";
import { db as defaultDb, type Db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";
import { disconnect } from "@/server/moodle/connect";

/** What she types to confirm "delete everything". Shown in the UI. */
export const DELETE_PHRASE = "delete";

/** Trimmed and case-insensitive, so a phone's auto-capital "Delete" still counts. */
export function matchesDeletePhrase(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_PHRASE;
}

/** Forgets her MyCourses key (M1-13's `disconnect`). Courses, deadlines and progress stay. */
export async function disconnectFor(database: Db, userId: string): Promise<void> {
  await disconnect(userId, database);
}

export type DeleteResult = { ok: true } | { ok: false; reason: "confirmation" };

/**
 * Deletes her user row when `typed` matches `DELETE_PHRASE`; every table that
 * belongs to her goes with it through `on delete cascade`. Provider metrics in
 * `ai_calls` stay with `user_id` set to null (schema decision in M1-05).
 * A wrong confirmation deletes nothing.
 */
export async function deleteAccountFor(
  database: Db,
  userId: string,
  typed: string,
): Promise<DeleteResult> {
  if (!matchesDeletePhrase(typed)) return { ok: false, reason: "confirmation" };
  await database.delete(users).where(eq(users.id, userId));
  return { ok: true };
}

async function signedInUser(): Promise<User | null> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

/** Form action for "Disconnect". */
export async function disconnectAction(): Promise<void> {
  "use server";
  const user = await signedInUser();
  if (!user) redirect("/");
  await disconnectFor(defaultDb, user.id);
  revalidatePath("/settings");
}

/**
 * Form action for "Delete my account and everything in it". Takes the typed
 * text directly, or the form's `confirm` field. A mismatch goes back to the
 * settings page with a note; a match deletes everything, clears the session
 * cookie and goes to `/`, where the proxy hands her a fresh, empty session.
 */
export async function deleteAccountAction(typedConfirmation: string | FormData): Promise<void> {
  "use server";
  const typed =
    typeof typedConfirmation === "string"
      ? typedConfirmation
      : String(typedConfirmation.get("confirm") ?? "");
  const user = await signedInUser();
  if (!user) redirect("/");

  const result = await deleteAccountFor(defaultDb, user.id, typed);
  if (!result.ok) redirect("/settings?confirm=wrong#your-data");

  // Same name, path and flags as when it was set, so the browser drops it.
  (await cookies()).set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  redirect("/");
}
