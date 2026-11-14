/*
 * Connect action (M1-35): she pastes her Moodle key, we check it, store it
 * sealed (M1-13's `connectWithKey`, which also brakes key guessing, M1-43),
 * run the first sync (M1-16's `syncNow`) and send her to /home.
 *
 * A Server Action, not an /api route: under `next dev`, route handlers and
 * pages run in separate PGlite instances, so a connection written by a route
 * would not be seen by /home.
 *
 * Same shape as settings/actions.ts and exams/actions.ts: no file-level
 * "use server", so only `connectAction` is a callable endpoint. It works for
 * the visitor's own cookie only; it never takes a user id or a site from the
 * form. The site is her school's (`schoolOf(user).siteUrl`).
 *
 * The key is never logged, never returned, never put in an error message.
 * The state sent back to the form holds only a sentence.
 *
 * When the key's Moodle user already belongs to another of our users (she
 * connected on another device first), `connectWithKey` merges this user into
 * that one. `mergeUsers` moves her `sessions` rows too, so the cookie in this
 * browser keeps working and now points at the survivor; nothing to re-point.
 *
 * The first sync is not forced and is capped at ~8 s by `syncNow`. When
 * Moodle is slow it answers `more: true`; we go to /home anyway and Home syncs
 * again. A failed first sync never blocks the redirect: the key is stored.
 */
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ConnectState } from "@/components/first-run/paste-key";
import { lmsNameOf, schoolOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { KeyRejected, MoodleError, NotAllowed } from "@/server/moodle/client";
import { connectWithKey, type ConnectResult } from "@/server/moodle/connect";
import { syncNow } from "@/server/sync/run";

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

/** `useActionState` action for the paste-key form. Redirects to /home on success. */
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

  const siteUrl = schoolOf(user).siteUrl;
  if (!siteUrl) return { error: m.notAllowed };

  let ownerId: string;
  try {
    const result = await connectWithKey(user.id, siteUrl, parsed.data);
    if (!result.ok) return { error: refusal(result, lms) };
    ownerId = result.userId;
  } catch (err) {
    // Only the error's class name is logged: never the key, never Moodle's message.
    if (err instanceof KeyRejected) return { error: m.rejected };
    if (err instanceof NotAllowed) return { error: m.wrongService };
    if (err instanceof MoodleError) return { error: m.down };
    console.error("Connect failed:", err instanceof Error ? err.name : typeof err);
    return { error: m.ourFault };
  }

  try {
    await syncNow(ownerId, { force: false });
  } catch (err) {
    // The key is stored; Home syncs again on arrival.
    console.error("First sync failed:", err instanceof Error ? err.name : typeof err);
  }
  redirect("/home");
}
