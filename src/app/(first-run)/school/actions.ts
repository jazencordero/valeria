/*
 * Choose your school (M5-04): stores her pick in `users.school`.
 *
 * Same shape as connect/actions.ts: no file-level "use server", so only
 * `chooseSchoolAction` is a callable endpoint. It works for the visitor's own
 * cookie only and never takes a user id.
 *
 * Only a school she can connect to now (`canConnect`) is stored: LUT is listed
 * but not enabled, and storing it would leave Connect with no site. The screen
 * never sends it (its button says "Tell me when LUT is ready" instead), and
 * the action refuses it anyway.
 *
 * It answers `{ ok }` instead of redirecting, so the screen can play its
 * slide out before it goes to /connect.
 */
import { eq } from "drizzle-orm";
import { canConnect, isSchoolId } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";

export type ChooseSchoolResult = { ok: boolean };

async function visitor(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First request with a fresh cookie: no user row yet. A Server Action may set the cookie.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

/** Stores `schoolId` on the visitor when it is a school she can connect to now. */
export async function chooseSchoolAction(schoolId: string): Promise<ChooseSchoolResult> {
  "use server";
  if (!isSchoolId(schoolId) || !canConnect(schoolId)) return { ok: false };
  try {
    const user = await visitor();
    await db.update(users).set({ school: schoolId }).where(eq(users.id, user.id));
    return { ok: true };
  } catch (err) {
    console.error("Choose school failed:", err instanceof Error ? err.name : typeof err);
    return { ok: false };
  }
}
