/*
 * Phone notifications (M7-06): send one notification to every device a user
 * turned "Notifications on this phone" on for.
 *
 *   const result = await sendPush(user.id, { title, body, url: "/exams/abc" });
 *   // { status: "not_configured" } or { status: "sent", sent, removed, failed }
 *
 * Keys come from the environment only, never from code or the database:
 * - VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: made once with
 *   `npx web-push generate-vapid-keys` and stored in Vercel.
 * - VAPID_SUBJECT: a `mailto:` or `https:` address push services may contact.
 *   When unset, the production site address Vercel provides is used.
 * Without both keys and a subject, sending is a no-op that answers
 * `not_configured`, so local dev and tests never need keys.
 *
 * A subscription the push service answers 404 or 410 for is gone (she turned
 * notifications off, removed the app, or the browser rotated it), so its row
 * is deleted. Other failures are counted and left for the next try. Nothing
 * here logs a key, an endpoint or a payload.
 */
import { and, eq } from "drizzle-orm";
import webpush from "web-push";
import { db as defaultDb, type Db } from "@/server/db/client";
import { pushSubscriptions } from "@/server/db/schema/calendar";

export type PushMessage = {
  title: string;
  body: string;
  /** A path in this app, e.g. "/exams/abc". Anything else opens Home. */
  url: string;
};

export type SendPushResult =
  | { status: "not_configured" }
  | { status: "sent"; sent: number; removed: number; failed: number };

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

/** The subscription shape web-push takes; matches `PushSubscription.toJSON()`. */
export type StoredSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** Sends one encrypted payload. Defaults to web-push; tests pass a fake. */
export type PushSender = (
  subscription: StoredSubscription,
  payload: string,
  options: { vapidDetails: VapidConfig; TTL: number; urgency: "normal" },
) => Promise<unknown>;

export type SendPushDeps = {
  db?: Db;
  send?: PushSender;
  env?: Record<string, string | undefined>;
};

/** How long a push service keeps an undelivered notification (one day). */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Hosts of the browsers' own push services. The subscribe route accepts only
 * these, so the server never posts to an address a visitor made up.
 */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome, Edge on Android, most Chromium browsers
  "android.googleapis.com",
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari and home-screen apps on iPhone (web.push.apple.com)
  "notify.windows.com", // Edge on Windows
];

/** Whether `endpoint` is an https address on a known push service. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** The VAPID keys and subject from the environment, or null when any is missing. */
export function vapidConfig(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || (productionHost ? `https://${productionHost}` : "");
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** The public key for the browser, or null when push is not set up. Never the private key. */
export function vapidPublicKey(env: Record<string, string | undefined> = process.env): string | null {
  return vapidConfig(env)?.publicKey ?? null;
}

/** A same-site path, or "/" for anything that is not one (no other sites, no `//host`). */
export function safePath(url: string): string {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("\\")) {
    return "/";
  }
  return url;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code = (error as { statusCode: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

const webPushSender: PushSender = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options);

/** Sends `message` to every stored subscription of `userId`. */
export async function sendPush(
  userId: string,
  message: PushMessage,
  deps: SendPushDeps = {},
): Promise<SendPushResult> {
  const vapid = vapidConfig(deps.env ?? process.env);
  if (!vapid) return { status: "not_configured" };

  const database = deps.db ?? defaultDb;
  const send = deps.send ?? webPushSender;

  const rows = await database
    .select({ endpoint: pushSubscriptions.endpoint, keys: pushSubscriptions.keys })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    url: safePath(message.url),
  });

  let sent = 0;
  let removed = 0;
  let failed = 0;

  await Promise.all(
    rows.map(async (row) => {
      if (!isPushEndpoint(row.endpoint)) {
        failed += 1;
        return;
      }
      try {
        await send({ endpoint: row.endpoint, keys: row.keys }, payload, {
          vapidDetails: vapid,
          TTL: TTL_SECONDS,
          urgency: "normal",
        });
        sent += 1;
      } catch (error) {
        const code = statusOf(error);
        if (code === 404 || code === 410) {
          await database
            .delete(pushSubscriptions)
            .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, row.endpoint)));
          removed += 1;
        } else {
          failed += 1;
          console.warn(`sendPush: push service answered ${code ?? "no status"}`);
        }
      }
    }),
  );

  return { status: "sent", sent, removed, failed };
}
