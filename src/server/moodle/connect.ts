/*
 * Connecting MyCourses with a key she pastes (M1-13).
 *
 * `connectWithKey` checks the key with `getSiteInfo`, seals it, and stores one
 * `moodle_connections` row per user plus the identity
 * `('moodle', siteUrl, <Moodle user id>)`. When that identity already belongs
 * to another of our users (she connected on another device first), the current
 * user is merged into that one and the survivor is returned, so the caller can
 * re-point the session cookie.
 *
 * The key is never logged and never leaves this file unsealed except through
 * `getConnection`, which is for server use only.
 *
 * Every function takes the `Db` last (default: the app database) so tests can
 * run against `createTestDb()`.
 */
import { and, eq, ne } from "drizzle-orm";
import { mergeUsers } from "@/server/auth/session";
import { seal, unseal } from "@/server/crypto/seal";
import { db as defaultDb, type Db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";
import { identities } from "@/server/db/schema/users";
import { KeyRejected, type MoodleConn } from "./client";
import { getSiteInfo } from "./read/site";

/** The only Moodle sites a key may be connected to, for now. */
export const ALLOWED_SITES = ["https://mycourses.aalto.fi"] as const;
export type AllowedSite = (typeof ALLOWED_SITES)[number];

export const MOODLE_IDENTITY_KIND = "moodle";

/** The allowed site `siteUrl` names (a trailing slash is ignored), or null. */
export function allowedSite(siteUrl: string): AllowedSite | null {
  const trimmed = siteUrl.trim().replace(/\/+$/, "");
  return ALLOWED_SITES.find((site) => site === trimmed) ?? null;
}

export type ConnectResult =
  | {
      ok: true;
      /** The user that now owns the connection. Differs from the caller's when `merged`. */
      userId: string;
      /** True when the caller's user was merged into the user that already had this Moodle identity. */
      merged: boolean;
    }
  | {
      ok: false;
      /**
       * `other_account`: the key is good, but for a different Moodle user than
       * the one this account is already tied to. Nothing is stored, so two
       * people's coursework never end up in one account.
       */
      reason: "rejected" | "site_not_allowed" | "other_account";
    };

/**
 * Checks `key` against `siteUrl` and, if Moodle accepts it, stores it sealed
 * for `userId`. A rejected key, a site not in `ALLOWED_SITES`, or a key for a
 * different Moodle user than this account already has, stores nothing. Other Moodle errors (down, unexpected answer) are thrown.
 */
export async function connectWithKey(
  userId: string,
  siteUrl: string,
  key: string,
  database: Db = defaultDb,
): Promise<ConnectResult> {
  const site = allowedSite(siteUrl);
  if (!site) return { ok: false, reason: "site_not_allowed" };

  let info;
  try {
    info = await getSiteInfo({ siteUrl: site, token: key, userId });
  } catch (err) {
    if (err instanceof KeyRejected) return { ok: false, reason: "rejected" };
    throw err;
  }

  const tokenSealed = seal(key);
  const externalId = String(info.userId);

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const findOwner = async () => {
      const [row] = await tx
        .select({ userId: identities.userId })
        .from(identities)
        .where(
          and(
            eq(identities.kind, MOODLE_IDENTITY_KIND),
            eq(identities.siteUrl, site),
            eq(identities.externalId, externalId),
          ),
        )
        .limit(1);
      return row?.userId ?? null;
    };

    // One account, one Moodle user per site. Without this, a friend's key pasted
    // on her device would tie the friend's identity to her account, and the
    // friend's own device would later be merged into it.
    const [other] = await tx
      .select({ id: identities.id })
      .from(identities)
      .where(
        and(
          eq(identities.userId, userId),
          eq(identities.kind, MOODLE_IDENTITY_KIND),
          eq(identities.siteUrl, site),
          ne(identities.externalId, externalId),
        ),
      )
      .limit(1);
    if (other) return { ok: false as const, reason: "other_account" as const };

    let owner = await findOwner();
    if (!owner) {
      const inserted = await tx
        .insert(identities)
        .values({ userId, kind: MOODLE_IDENTITY_KIND, siteUrl: site, externalId })
        .onConflictDoNothing()
        .returning({ userId: identities.userId });
      owner = inserted[0]?.userId ?? (await findOwner());
      if (!owner) throw new Error("connectWithKey: identity vanished right after a parallel insert.");
    }

    const merged = owner !== userId;
    // Runs as a savepoint inside this transaction: all or nothing.
    if (merged) await mergeUsers(userId, owner, tx);

    const now = new Date();
    const values = {
      siteUrl: site,
      moodleUserId: info.userId,
      tokenSealed,
      functions: info.functions,
      status: "ok" as const,
      connectedAt: now,
      lastError: null,
    };
    await tx
      .insert(moodleConnections)
      .values({ userId: owner, ...values })
      .onConflictDoUpdate({ target: moodleConnections.userId, set: values });

    return { ok: true as const, userId: owner, merged };
  });
}

/** Her site and unsealed key, ready for the Moodle client. Server use only. */
export async function getConnection(
  userId: string,
  database: Db = defaultDb,
): Promise<(MoodleConn & { userId: string }) | null> {
  const [row] = await database
    .select({ siteUrl: moodleConnections.siteUrl, tokenSealed: moodleConnections.tokenSealed })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  if (!row) return null;
  return { siteUrl: row.siteUrl, token: unseal(row.tokenSealed), userId };
}

/** Forgets her key: deletes the connection row. Her identity and synced data stay. */
export async function disconnect(userId: string, database: Db = defaultDb): Promise<void> {
  await database.delete(moodleConnections).where(eq(moodleConnections.userId, userId));
}

/** Whether her key may call the Moodle web service function `fn`. False when not connected. */
export async function can(userId: string, fn: string, database: Db = defaultDb): Promise<boolean> {
  const [row] = await database
    .select({ functions: moodleConnections.functions })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  return row?.functions.includes(fn) ?? false;
}
