"use server";
/*
 * QR connect action (M5-06): the scan-or-upload screen (`QrScan`) sends the
 * text it read from her Moodle QR code and whether she ticked the box (M8-33,
 * `agree` is "yes"); we run `connectWithQr` (M5-05) for the visitor's own
 * cookie. Without the tick it is refused before anything is called or stored;
 * `connectWithQr` stores when she agreed. It never takes a user id or a site
 * from the client: the site comes from the QR and must be one `allowedSite`
 * accepts.
 *
 * The first sync is not run here (M5-08): on `{ ok: true }` the screen calls
 * `startFirstSyncAction` (./actions.ts), which starts it after the response
 * (`startFirstSync`) and goes to /sorting, as the paste-key action does.
 *
 * File-level "use server": every export is a callable endpoint, so this file
 * exports only `connectQrAction`. Types live with the component.
 *
 * The answer is `{ ok: true }` or `{ ok: false, message }` with a sentence to
 * show. No redirect: navigation is the caller's job (`onConnected`). Never
 * logged or returned: the QR text, its key, the token.
 */
import { z } from "zod";
import type { QrConnectResult } from "@/components/first-run/qr-scan";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { KeyRejected, MoodleError } from "@/server/moodle/client";
import { connectWithQr, qrExpiredMessage } from "@/server/moodle/qr";
import { connectMessages } from "./actions";

/** Moodle's QR text is ~100 characters; anything far longer is not one. */
const qrTextSchema = z.string().trim().min(1).max(1024);

async function visitor(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First request with a fresh cookie: no user row yet. A Server Action may set the cookie.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

/** Connects the visitor's Moodle with the text of a QR code, once she has ticked the box (`agree` "yes"). */
export async function connectQrAction(text: unknown, agree: unknown): Promise<QrConnectResult> {
  const user = await visitor();
  const lms = lmsNameOf(user);
  const m = connectMessages(lms);
  const notAQr = `That is not the QR code from ${lms}. Show the one on your profile.`;

  const parsed = qrTextSchema.safeParse(text);
  if (!parsed.success) return { ok: false, message: notAQr };

  // M8-33: she agrees to the key being kept before anything is called or stored.
  if (agree !== "yes") return { ok: false, message: m.notAgreed };

  try {
    const result = await connectWithQr(user.id, parsed.data, undefined, { agreed: true });
    if (!result.ok) {
      if ("status" in result) {
        switch (result.status) {
          case "not_a_qr":
            return { ok: false, message: notAQr };
          case "not_agreed":
            return { ok: false, message: m.notAgreed };
          case "site_not_allowed":
            return { ok: false, message: m.notAllowed };
          case "expired":
            return { ok: false, message: result.message };
        }
      }
      switch (result.reason) {
        case "too_many":
          return { ok: false, message: result.message };
        case "other_account":
          return { ok: false, message: m.otherAccount };
        case "site_not_allowed":
          return { ok: false, message: m.notAllowed };
        case "rejected":
          // Moodle handed us a token it then refused: treat it as a spent code.
          return { ok: false, message: qrExpiredMessage(lms) };
      }
    }
  } catch (err) {
    // Only the error's class name is logged: never the QR text, never Moodle's message.
    if (err instanceof KeyRejected) return { ok: false, message: qrExpiredMessage(lms) };
    if (err instanceof MoodleError) return { ok: false, message: m.down };
    console.error("QR connect failed:", err instanceof Error ? err.name : typeof err);
    return { ok: false, message: m.ourFault };
  }

  return { ok: true };
}
