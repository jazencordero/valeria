/*
 * M7-04: Never miss one on Home. "Turn on" makes her private calendar link (M7-02's
 * `createFeed`) and saves what she chose in `users.settings.neverMiss`; turning it off
 * revokes the link and forgets the choice (for M8-03's "Manage" in Settings).
 *
 * - Who she is comes from the session cookie only. The browser sends only her choice,
 *   checked with zod before anything is written.
 * - The link is returned once, as the calendar app's subscribe page (`subscribeLinks`),
 *   and never stored or logged: only its hash is kept, by `createFeed`.
 * - Reminders are not offered on Home yet: Home passes `reminders: "none"`, so a choice
 *   with reminders on is refused. Push reminders need the phone subscribed from the
 *   browser (M7-06's Settings switch does that); email waits for M7-08.
 * - `settings.neverMiss` is written with `jsonb_set`, so every other settings key stays.
 *   Shape: `{ calendar: "google" | "apple" | "outlook" | null, reminders: null, at }`.
 *
 * "Not now": M7-03's card hides itself for 30 days with a timestamp in this browser's
 * localStorage. That is read only after hydration, so on its own the card would render
 * and then fade out on every visit. `dismissNeverMiss` also saves `neverMiss.notNowAt`,
 * and Home leaves the card out for the same 30 days (`getHomeView`'s `neverMiss.dismissed`).
 *
 * The real work sits in plain functions that take a `Db` and a user id, so the tests run
 * them against `createTestDb()`. There is no file-level "use server" on purpose (that
 * would make `turnOnNeverMissFor`, which takes any user id, a public endpoint); only the
 * actions carry the directive.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { createFeed, FEED_PROVIDERS, revokeFeed, subscribeLinks } from "@/server/calendar/feed";
import { db as defaultDb, type Db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";

/** What the card sends: a calendar app, and reminders off (Home does not offer them yet). */
export const NeverMissInput = z
  .object({
    calendar: z.enum(FEED_PROVIDERS),
    reminders: z.null(),
  });

export type NeverMissInputType = z.infer<typeof NeverMissInput>;

export class InvalidChoice extends Error {
  name = "InvalidChoice";
}

/**
 * Makes her a new calendar link for `input.calendar` (replacing any she had), saves the
 * choice and returns that app's subscribe page. Throws `InvalidChoice` for anything else.
 */
export async function turnOnNeverMissFor(
  database: Db,
  userId: string,
  input: unknown,
  origin?: string,
): Promise<{ subscribeUrl: string }> {
  const parsed = NeverMissInput.safeParse(input);
  if (!parsed.success) throw new InvalidChoice();
  const { calendar } = parsed.data;

  const { link } = await createFeed(userId, calendar, { origin, db: database });
  const saved = JSON.stringify({ calendar, reminders: null, at: new Date().toISOString() });
  await database
    .update(users)
    .set({ settings: sql`jsonb_set(${users.settings}, '{neverMiss}', ${saved}::jsonb, true)` })
    .where(eq(users.id, userId));

  return { subscribeUrl: subscribeLinks(link)[calendar] };
}

/** Stops her calendar link working and forgets the choice. Other settings keys stay. */
export async function turnOffNeverMissFor(database: Db, userId: string): Promise<void> {
  await revokeFeed(userId, database);
  await database
    .update(users)
    .set({ settings: sql`${users.settings} - 'neverMiss'` })
    .where(eq(users.id, userId));
}

/** "Not now": saves when, under `neverMiss.notNowAt`. Other keys stay. */
export async function dismissNeverMissFor(database: Db, userId: string, now: Date = new Date()): Promise<void> {
  await database
    .update(users)
    .set({
      settings: sql`jsonb_set(${users.settings}, '{neverMiss}',
        (case when jsonb_typeof(${users.settings} -> 'neverMiss') = 'object'
          then ${users.settings} -> 'neverMiss' else '{}'::jsonb end)
        || jsonb_build_object('notNowAt', ${now.toISOString()}::text), true)`,
    })
    .where(eq(users.id, userId));
}

/** The origin of the request she made, so a preview deployment hands out links to itself. */
export function originOf(h: { get(name: string): string | null }): string | undefined {
  const raw = h.get("origin");
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

async function signedInId(): Promise<string> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) throw new Error("Signed out");
    throw err;
  }
}

/**
 * The card's `onTurnOn`. Resolves with the subscribe page; rejects (the card says
 * "That did not work. Try again.") when she is signed out or the choice is not one
 * Home offers.
 */
export async function turnOnNeverMiss(choice: unknown): Promise<{ subscribeUrl: string }> {
  "use server";
  const userId = await signedInId();
  return turnOnNeverMissFor(defaultDb, userId, choice, originOf(await headers()));
}

/** The card's `onDismiss` ("Not now"). */
export async function dismissNeverMiss(): Promise<void> {
  "use server";
  const userId = await signedInId();
  await dismissNeverMissFor(defaultDb, userId);
}

/** Turns it off: revokes the link. For Settings' "Manage" (M8-03). */
export async function turnOffNeverMiss(): Promise<void> {
  "use server";
  const userId = await signedInId();
  await turnOffNeverMissFor(defaultDb, userId);
  revalidatePath("/home");
}
