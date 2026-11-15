/**
 * A short-lived "what she just did" note for Home's greeting (M4-10).
 *
 * The hand-in and end-session actions each set one, in one line:
 *
 *   await setFlash("handedIn");
 *   await setFlash("studied", { examId: done.examId, forecast: done.forecastAfterShown });
 *
 * and Home reads it (`readFlash`) to start the greeting with "Handed in, ..."
 * or "Nice. Friday's exam forecast is up to 68%.".
 *
 * The cookie:
 * - `ready_flash`, httpOnly, SameSite=Lax, path=/, max-age 60 s, Secure in
 *   production. The value is JSON with the kind, the time it was set and the
 *   kind's few fields. It carries ids and numbers only, never a title: Home
 *   looks the rest up in our database for the signed-in user, so a forged
 *   cookie can at most change her own greeting.
 * - Not cleared on read: a cookie can only be written or deleted in a server action or
 *   route handler, never while a server component renders, so Home cannot
 *   clear it as it reads it. It expires on its own after 60 s instead, and
 *   `parseFlash` also refuses one older than that (a clock that drifts, a
 *   browser that keeps it). A Home reload inside that minute says "Handed
 *   in" again, which is still true. The next `setFlash` replaces it.
 * - Best effort: setting it never throws. A hand-in that worked must not
 *   fail because the note about it could not be written (outside a request,
 *   in tests, after streaming started).
 *
 * `encodeFlash` and `parseFlash` are pure, for tests.
 */
import { cookies } from "next/headers";
import { z } from "zod";

export const FLASH_COOKIE = "ready_flash";
/** Seconds the note lives: long enough to get back to Home, short enough not to linger. */
export const FLASH_MAX_AGE_S = 60;

/** What the session flash carries: the exam it was for and its forecast on the done screen (a whole percent). */
export type StudiedPayload = { examId: string; forecast: number };

export type Flash =
  /** Home names her newest hand-in (`lastDone`), which the hand-in has just written. */
  | { kind: "handedIn"; at: Date }
  | ({ kind: "studied"; at: Date } & StudiedPayload);

export type FlashKind = Flash["kind"];

const Stored = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("handedIn"), at: z.number() }),
  z.object({
    kind: z.literal("studied"),
    at: z.number(),
    examId: z.string().min(1).max(64),
    forecast: z.number().min(0).max(100),
  }),
]);

/** The cookie value for a note set at `at`. */
export function encodeFlash(kind: FlashKind, payload: StudiedPayload | null, at: Date): string {
  return JSON.stringify({ ...payload, kind, at: at.getTime() });
}

/** The note in a cookie value, or null when missing, malformed, from the future or older than the max age. */
export function parseFlash(raw: string | null | undefined, now: Date): Flash | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = Stored.safeParse(json);
  if (!parsed.success) return null;
  const age = now.getTime() - parsed.data.at;
  // A few seconds of leeway for a server clock slightly ahead of the one that set it.
  if (age < -5_000 || age > FLASH_MAX_AGE_S * 1000) return null;
  const at = new Date(parsed.data.at);
  if (parsed.data.kind === "handedIn") return { kind: "handedIn", at };
  return { kind: "studied", at, examId: parsed.data.examId, forecast: parsed.data.forecast };
}

/** Sets the note. Call from a server action or route handler only. Never throws. */
export async function setFlash(kind: "handedIn"): Promise<void>;
export async function setFlash(kind: "studied", payload: StudiedPayload): Promise<void>;
export async function setFlash(kind: FlashKind, payload: StudiedPayload | null = null): Promise<void> {
  try {
    const store = await cookies();
    store.set(FLASH_COOKIE, encodeFlash(kind, payload, new Date()), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: FLASH_MAX_AGE_S,
      secure: process.env.NODE_ENV === "production",
    });
  } catch (err) {
    console.warn("setFlash: could not set the flash cookie", err);
  }
}

/** The note on this request, or null. Safe in a server component (it only reads). */
export async function readFlash(now: Date): Promise<Flash | null> {
  const store = await cookies();
  return parseFlash(store.get(FLASH_COOKIE)?.value, now);
}
