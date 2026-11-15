/*
 * Connecting her Moodle with the QR code on her MyCourses profile (M5-05).
 *
 * The QR text is `moodlemobile://https://site?qrlogin=KEY&userid=ID`
 * (context/moodle/findings.md: proven at the real sitting). `connectWithQr`
 * reads it, checks the site is one we connect (`allowedSite`, from
 * `@/lib/schools`), swaps the key for a web service token with
 * `tool_mobile_get_tokens_for_qr_login`, then hands the token to
 * `connectWithKey`, which checks it, seals it and stores it. The private token
 * Moodle also sends is dropped (cut: no token refresh).
 *
 * The exchange, as the M0 tool does it (scripts/moodle/lib/keys.mjs) and as
 * Moodle's tool_mobile external.php reads it: a JSON POST to
 * `{site}/lib/ajax/service-nologin.php?info=<fn>` with
 * `[{ index: 0, methodname, args: { qrloginkey, userid } }]`. Moodle answers
 * `[{ error: false, data: { token, privatetoken } }]` or
 * `[{ error: true, exception: { errorcode, message } }]`. The key works once
 * and for a few minutes; it throws `apprequired` unless the User-Agent contains
 * "MoodleMobile".
 *
 * Why this file sends the request itself and not through `./client`: client.ts
 * always says `User-Agent: Ready/0.1 (student study tool)` and posts form
 * bodies to the REST server, and its throttle (`politely`) is not exported.
 * This one call needs a JSON body and "MoodleMobile" in the User-Agent, so it
 * uses `QR_USER_AGENT` (the client's `USER_AGENT` plus " MoodleMobile") and
 * the client's timeout. Its politeness is the per-visitor brake of M1-43
 * (`allow` in `@/server/throttle`): `QR_TRIES_PER_MINUTE` a minute and
 * `QR_TRIES_PER_DAY` a day, counted before Moodle is called, under keys of
 * its own (`qr:minute`, `qr:day`) so the `connectWithKey` call that follows a
 * good exchange does not eat the QR tries. It is one request per try and is
 * not retried (a spent key cannot be retried anyway). It does not count
 * toward the client's 2,000-a-day limit.
 *
 * MOODLE_FAKE=1 (M5-08): with `options.exchangeSite` the exchange goes to that
 * fake server (tests do this with `startFakeMoodle`); without it the
 * in-process fake answers it (`fakeQrLogin` in ./fake-inline, which accepts
 * the sample QR), so `next start` with the fake on never reaches a real
 * Moodle. Without MOODLE_FAKE nothing changes: the real exchange, and never a
 * redirect followed.
 *
 * Her yes (M8-33, for the QR way in since M5-08): `connectWithQr` refuses with
 * `not_agreed`, before Moodle is called or a try counted, unless
 * `options.agreed` is true. After a good connection it stores when she agreed
 * in `users.settings.agreedAt` on the surviving user (connecting can merge
 * two users), with the same statement as the paste-key action.
 *
 * Never logged or returned: the QR key, the token, the private token.
 */
import { eq, sql } from "drizzle-orm";
import { SCHOOLS, SCHOOL_IDS } from "@/lib/schools";
import { db as defaultDb, type Db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";
import { allow } from "@/server/throttle";
import { MOODLE_TIMEOUT_MS, MoodleDown, MoodleError, USER_AGENT } from "./client";
import {
  CONNECT_TRIES_PER_DAY,
  CONNECT_TRIES_PER_MINUTE,
  TOO_MANY_TRIES,
  allowedSite,
  connectWithKey,
  type ConnectResult,
} from "./connect";
import { fakeQrLogin } from "./fake-inline";

export const QR_LOGIN_FN = "tool_mobile_get_tokens_for_qr_login";
/** Moodle answers this function only to the Moodle app, which it knows by "MoodleMobile" in the User-Agent. */
export const QR_USER_AGENT = `${USER_AGENT} MoodleMobile`;
/** QR tries per visitor, the same limits as pasted keys (M1-43). */
export const QR_TRIES_PER_MINUTE = CONNECT_TRIES_PER_MINUTE;
export const QR_TRIES_PER_DAY = CONNECT_TRIES_PER_DAY;

/** What she sees when the key was used, ran out or is not Moodle's. `lms` is the school's name for Moodle. */
export function qrExpiredMessage(lms: string): string {
  return `That code ran out. Show it again in ${lms}.`;
}

export type ParsedQr = { site: string; key: string; userid: number };

/**
 * Reads `moodlemobile://https://site?qrlogin=KEY&userid=ID` into its site
 * (origin and path, no trailing slash), key and Moodle user id; null when the
 * text is not such a link.
 */
export function parseQr(text: string): ParsedQr | null {
  const raw = String(text ?? "").trim().replace(/^moodlemobile:\/\//i, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const key = u.searchParams.get("qrlogin") ?? "";
  const useridText = u.searchParams.get("userid") ?? "";
  const userid = Number(useridText);
  // Moodle reads the key as PARAM_ALPHANUMEXT and the user id as PARAM_INT.
  if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^\d+$/.test(useridText) || !Number.isSafeInteger(userid) || userid <= 0) {
    return null;
  }
  const site = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  return { site, key, userid };
}

export type QrResult =
  | ConnectResult
  | { ok: false; status: "not_a_qr" }
  | { ok: false; status: "not_agreed" }
  | { ok: false; status: "site_not_allowed" }
  | { ok: false; status: "expired"; message: string };

export type QrOptions = {
  /** She ticked the box (M8-33). Without it nothing is called or stored. */
  agreed?: boolean;
  /**
   * Send the exchange to this site instead of the QR's own (tests and fake
   * mode: a `startFakeMoodle` url). The site check and the stored connection
   * still use the QR's site.
   */
  exchangeSite?: string;
  /** Defaults to the client's 15 seconds. */
  timeoutMs?: number;
};

// Moodle error codes that mean "this key will not work": not found, used (Moodle
// deletes a used key, so it is then not found), or out of time.
const KEY_GONE = new Set(["invalidkey", "expiredkey"]);

/**
 * Connects `userId` with the text of a MyCourses QR code. Garbage text is
 * `not_a_qr`, no `options.agreed` is `not_agreed`, and a site we do not connect is `site_not_allowed`, both without
 * a Moodle call or a counted try. Over the try limits it is `too_many` (as
 * from `connectWithKey`) and Moodle is not called. A used, expired or unknown
 * key is `expired` with the sentence to show. Otherwise it is whatever
 * `connectWithKey` returns for the token. Moodle being down, and errors that
 * mean our request is wrong (`apprequired`, `qrcodedisabled`, ...), throw.
 */
export async function connectWithQr(
  userId: string,
  text: string,
  database: Db = defaultDb,
  options: QrOptions = {},
): Promise<QrResult> {
  const qr = parseQr(text);
  if (!qr) return { ok: false, status: "not_a_qr" };
  if (options.agreed !== true) return { ok: false, status: "not_agreed" };
  const site = allowedSite(qr.site);
  if (!site) return { ok: false, status: "site_not_allowed" };

  const counted = { userId, db: database };
  const ok =
    (await allow("qr:minute", { max: QR_TRIES_PER_MINUTE, perSeconds: 60 }, counted)) &&
    (await allow("qr:day", { max: QR_TRIES_PER_DAY, perSeconds: 24 * 60 * 60 }, counted));
  if (!ok) return { ok: false, reason: "too_many", message: TOO_MANY_TRIES };

  const inProcessFake = process.env.MOODLE_FAKE === "1" && !options.exchangeSite;

  let token: string;
  try {
    token = inProcessFake
      ? fakeQrLogin(qr.key, qr.userid)
      : await exchangeQrKey(options.exchangeSite ?? site, qr.key, qr.userid, options.timeoutMs ?? MOODLE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof MoodleError && !(err instanceof MoodleDown) && err.errorcode && KEY_GONE.has(err.errorcode)) {
      return { ok: false, status: "expired", message: qrExpiredMessage(lmsOf(site)) };
    }
    throw err;
  }
  const result = await connectWithKey(userId, site, token, database);
  if (result.ok) {
    // When she agreed (M8-33). On the surviving user. Keeps other settings keys.
    await database
      .update(users)
      .set({ settings: sql`jsonb_set(${users.settings}, '{agreedAt}', to_jsonb(now()::text), true)` })
      .where(eq(users.id, result.userId));
  }
  return result;
}

function lmsOf(site: string): string {
  const id = SCHOOL_IDS.find((s) => SCHOOLS[s].siteUrl === site);
  return id ? SCHOOLS[id].lms : "Moodle";
}

/**
 * Swaps a QR key for a web service token. Errors never carry the key or the
 * token. Stores nothing and counts no tries: callers brake it themselves
 * (`connectWithQr` above; the dev-only sign-in test, which throws the token
 * away after one check). Throws `MoodleDown` when Moodle cannot be reached and
 * `MoodleError` with Moodle's own `errorcode` (`invalidkey`, `ipmismatch`, ...).
 */
export async function exchangeQrKey(site: string, key: string, userid: number, timeoutMs: number): Promise<string> {
  const url = `${site.replace(/\/+$/, "")}/lib/ajax/service-nologin.php?info=${QR_LOGIN_FN}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": QR_USER_AGENT },
      body: JSON.stringify([{ index: 0, methodname: QR_LOGIN_FN, args: { qrloginkey: key, userid } }]),
      // Never follow a redirect: it would send her QR key wherever it points.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new MoodleDown(`Moodle did not answer within ${Math.round(timeoutMs / 1000)} s`, { errorcode: "timeout" });
    }
    throw new MoodleDown("Could not reach Moodle", { errorcode: "network" });
  }
  if (res.status >= 500 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new MoodleDown(`Moodle answered HTTP ${res.status}`, { errorcode: `http_${res.status}`, status: res.status });
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new MoodleError(`QR login answered HTTP ${res.status} with something that is not JSON`, {
      errorcode: "invalidresponse",
      status: res.status,
    });
  }
  type Entry = { error?: unknown; data?: { token?: unknown }; exception?: unknown; errorcode?: unknown; message?: unknown };
  // An array of { error, data | exception }, or a bare error object.
  const first = (Array.isArray(body) ? body[0] : body) as Entry | null | undefined;
  if (!first || typeof first !== "object" || first.error || first.exception || first.errorcode) {
    const ex = (first?.exception && typeof first.exception === "object" ? first.exception : first ?? {}) as {
      errorcode?: unknown;
      message?: unknown;
      exception?: unknown;
    };
    const errorcode = typeof ex.errorcode === "string" ? ex.errorcode : null;
    throw new MoodleError(typeof ex.message === "string" && ex.message ? ex.message : errorcode ?? "QR login failed", {
      errorcode,
      exception: typeof ex.exception === "string" ? ex.exception : null,
      status: res.status,
    });
  }
  const token = first.data?.token;
  if (typeof token !== "string" || !token) {
    throw new MoodleError("QR login answer had no token", { errorcode: "invalidresponse", status: res.status });
  }
  return token;
}
