/*
 * Settings, "Log in" (M5-15): an account without a login gives itself a username and a password;
 * an account with one changes its password.
 *
 * - Who she is comes from the session cookie only (`currentUser`). The form sends a name and
 *   passwords, never a user id; a field named like one is ignored.
 * - Setting a login is `setLogin(..., { firstOnly: true })` (src/server/auth/accounts.ts): the
 *   sign-up rules for the name and the password, the same hashing and the same sentence for a
 *   taken name; only for a user with neither a name nor a password, never a demo. No name change
 *   once set.
 * - Changing the password is `changePassword`: the current one is checked behind the log-in brake
 *   (a wrong one counts as a failed try for her name, and the address the host reports, exactly
 *   like a wrong log in; the right one clears her name's count). No new password without the
 *   current one.
 * - After a save, /settings is revalidated, so the Account section shows "Logged in as" and Log
 *   out, and this section turns into the change-password form.
 *
 * The real work sits in plain functions that take a `Db` and a user id, so the tests run them
 * against `createTestDb()`. There is no file-level "use server" on purpose (that would make
 * `setLoginFor`, which takes any user id, a public endpoint); only the two actions carry the
 * directive. Nothing here logs a name, a password or an address; the state sent back holds a
 * sentence and the name she typed, never a password.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { changePassword, setLogin } from "@/server/auth/accounts";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db as defaultDb, type Db } from "@/server/db/client";

export type SetLoginState = {
  error: string | null;
  /** What she typed, kept after a refusal so she need not type it again. */
  username: string;
  /** The stored name after a save: "You can now log in as <savedAs>." */
  savedAs: string | null;
};

export type ChangePasswordState = { error: string | null; changed: boolean };

const SIGNED_OUT = "You are not logged in any more. Open Ready again.";
const OUR_SIDE = "Something went wrong on our side. Try again in a minute.";

const field = (formData: FormData, name: string, max: number) => {
  const v = formData.get(name);
  return typeof v === "string" ? v.slice(0, max) : "";
};

/** Gives `userId` the typed username and password, when it has neither. */
export async function setLoginFor(database: Db, userId: string, formData: FormData): Promise<SetLoginState> {
  const username = field(formData, "username", 200);
  // Longer than any allowed password: cut, so a huge body costs no more than a long password.
  const password = field(formData, "password", 1000);
  if (!username.trim()) return { error: "Pick a username.", username, savedAs: null };
  if (!password) return { error: "Pick a password.", username, savedAs: null };
  const result = await setLogin(database, userId, { username, password }, { firstOnly: true });
  if (!result.ok) return { error: result.error, username, savedAs: null };
  return { error: null, username: "", savedAs: username.trim().toLowerCase() };
}

/** Changes `userId`'s password, once the current one is right and the brake is off. */
export async function changePasswordFor(
  database: Db,
  userId: string,
  formData: FormData,
  opts: { address?: string | null; now?: Date } = {},
): Promise<ChangePasswordState> {
  const current = field(formData, "current", 1000);
  const next = field(formData, "next", 1000);
  if (!current) return { error: "Type your current password.", changed: false };
  if (!next) return { error: "Type a new password.", changed: false };
  const result = await changePassword(database, userId, current, next, opts);
  return result.ok ? { error: null, changed: true } : { error: result.error, changed: false };
}

/** The address the host reports (Vercel sets both headers itself), as the log-in screen reads it. */
function clientAddress(h: Headers): string | null {
  const direct = h.get("x-real-ip")?.trim();
  if (direct) return direct;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

async function signedInId(): Promise<string | null> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

/** The "Save" of an account without a login. */
export async function setLoginAction(_prev: SetLoginState, formData: FormData): Promise<SetLoginState> {
  "use server";
  const typed = field(formData, "username", 200);
  try {
    const userId = await signedInId();
    if (!userId) return { error: SIGNED_OUT, username: typed, savedAs: null };
    const state = await setLoginFor(defaultDb, userId, formData);
    if (state.savedAs) {
      revalidatePath("/settings");
      revalidatePath("/home");
    }
    return state;
  } catch (err) {
    console.error("Setting a login failed:", err instanceof Error ? err.name : typeof err);
    return { error: OUR_SIDE, username: typed, savedAs: null };
  }
}

/** "Change password" of an account with a login. */
export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  "use server";
  try {
    const userId = await signedInId();
    if (!userId) return { error: SIGNED_OUT, changed: false };
    return await changePasswordFor(defaultDb, userId, formData, { address: clientAddress(await headers()) });
  } catch (err) {
    console.error("Changing a password failed:", err instanceof Error ? err.name : typeof err);
    return { error: OUR_SIDE, changed: false };
  }
}
