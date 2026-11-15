/*
 * Connect actions (M1-35, M5-08): she pastes her Moodle key, we check it, store
 * it sealed (M1-13's `connectWithKey`, which also brakes key guessing, M1-43),
 * start the first sync (M5-07's `startFirstSync`) and send her to /sorting,
 * where the sorting scene shows it working. `startFirstSyncAction` does the
 * same two last steps after the QR way in (`connectQrAction`, ./qr-actions.ts)
 * has connected her.
 *
 * A Server Action, not an /api route: under `next dev`, route handlers and
 * pages run in separate PGlite instances, so a connection written by a route
 * would not be seen by the next page.
 *
 * Same shape as settings/actions.ts and exams/actions.ts: no file-level
 * "use server", so only `connectAction` and `startFirstSyncAction` are
 * callable endpoints. They work for the visitor's own cookie only; they never
 * take a user id or a site from the client. The site is her school's
 * (`schoolOf(user).siteUrl`).
 *
 * The key is never logged, never returned, never put in an error message.
 * The state sent back to the form holds only a sentence.
 *
 * When the key's Moodle user already belongs to another of our users (she
 * connected on another device first), `connectWithKey` merges this user into
 * that one. `mergeUsers` moves her `sessions` rows too, so the cookie in this
 * browser keeps working and now points at the survivor; nothing to re-point.
 *
 * The first sync is not waited for: `startFirstSync` runs it after the
 * response (`after`), and the sorting scene polls /api/sync/progress. A sync
 * that already finished is not repeated, so reconnecting is cheap.
 */
import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ConnectState } from "@/components/first-run/paste-key";
import { lmsNameOf, schoolOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { KeyRejected, MoodleError, NotAllowed } from "@/server/moodle/client";
import { db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { connectWithKey, type ConnectResult } from "@/server/moodle/connect";
import { startFirstSync } from "@/server/sync/progress";

/**
 * What a pasted key may look like. Real Moodle keys are 32 hex characters; the
 * fake's is `demo-key`. Anything else (spaces inside, a whole URL, a password)
 * is refused before Moodle is called, with the same sentence as a wrong key.
 */
const keySchema = z
  .string()
  .trim()
  .min(1, "empty")
  .max(128, "bad")
  .regex(/^[A-Za-z0-9_-]+$/, "bad");

/** Every sentence the form can show. `lms` is her school's name for Moodle. */
export function connectMessages(lms: string) {
  return {
    empty: "Paste your key first.",
    // M8-33: the box on the connect screen; the button is disabled until it is ticked.
    notAgreed: "Tick the box first.",
    rejected: `${lms} did not accept that key. Copy it again.`,
    down: `${lms} is not answering. Try again in a minute.`,
    // The key works but its service cannot read site info: she copied another key.
    wrongService: `That key cannot read your courses. Copy the one called "Moodle mobile web service".`,
    otherAccount: `That key is for a different ${lms} account than the one already connected here.`,
    notAllowed: `Ready cannot connect to ${lms} yet.`,
    ourFault: "Something went wrong on our side. Try again in a minute.",
  } as const;
}

/** The sentence for a refused `connectWithKey` answer. */
function refusal(result: Exclude<ConnectResult, { ok: true }>, lms: string): string {
  const m = connectMessages(lms);
  switch (result.reason) {
    case "rejected":
      return m.rejected;
    case "too_many":
      return result.message;
    case "other_account":
      return m.otherAccount;
    case "site_not_allowed":
      return m.notAllowed;
  }
}

async function visitor(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First request with a fresh cookie: no user row yet. A Server Action may set the cookie.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

/** `useActionState` action for the paste-key form. Redirects to /sorting on success. */
export async function connectAction(_prev: ConnectState, formData: FormData): Promise<ConnectState> {
  "use server";
  const user = await visitor();
  const lms = lmsNameOf(user);
  const m = connectMessages(lms);

  const parsed = keySchema.safeParse(formData.get("key") ?? "");
  if (!parsed.success) {
    const empty = parsed.error.issues.some((i) => i.message === "empty");
    return { error: empty ? m.empty : m.rejected };
  }

  // M8-33: she agrees to the key being kept before anything is stored (the button also waits for it).
  if (formData.get("agree") !== "yes") return { error: m.notAgreed };

  const siteUrl = schoolOf(user).siteUrl;
  if (!siteUrl) return { error: m.notAllowed };

  let ownerId: string;
  try {
    const result = await connectWithKey(user.id, siteUrl, parsed.data);
    if (!result.ok) return { error: refusal(result, lms) };
    ownerId = result.userId;
    // When she agreed (M8-33). On the surviving user: connecting can merge two users. Keeps other settings keys.
    await db
      .update(users)
      .set({ settings: sql`jsonb_set(${users.settings}, '{agreedAt}', to_jsonb(now()::text), true)` })
      .where(eq(users.id, ownerId));
  } catch (err) {
    // Only the error's class name is logged: never the key, never Moodle's message.
    if (err instanceof KeyRejected) return { error: m.rejected };
    if (err instanceof NotAllowed) return { error: m.wrongService };
    if (err instanceof MoodleError) return { error: m.down };
    console.error("Connect failed:", err instanceof Error ? err.name : typeof err);
    return { error: m.ourFault };
  }

  startFirstSync(ownerId);
  redirect("/sorting");
}

/**
 * After the QR way in connected her: starts her first sync and goes to
 * /sorting. Her user is read from the cookie again, so after a merge it is
 * the surviving user. Not connected (someone called it directly): back to
 * /connect, nothing started.
 */
export async function startFirstSyncAction(): Promise<void> {
  "use server";
  const user = await visitor();
  const conn = await db
    .select({ id: moodleConnections.userId })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, user.id))
    .limit(1);
  if (conn.length === 0) redirect("/connect");
  startFirstSync(user.id);
  redirect("/sorting");
}
