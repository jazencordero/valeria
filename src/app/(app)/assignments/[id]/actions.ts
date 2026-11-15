"use server";

/**
 * M1-32: the two hand-in actions the hand-in sheet calls.
 *
 *   prepareHandinAction(assignmentId, form) -> the review, with a one-time code
 *   confirmHandinAction(code, form)         -> her tap: the hand-in itself
 *
 * `form` is a FormData with the picked file under `file`; the confirm call
 * sends the same file again, so the server can check it is the one she
 * reviewed (sha-256), without ever keeping the bytes.
 *
 * Who she is comes from the session cookie (`currentUser`), never from the
 * browser. Every export of a "use server" file is a public endpoint, so only
 * these two are exported; the work is in `src/server/handin/*`, which takes a
 * user id and must never be reachable with an id the caller chose.
 *
 * Besides the reasons from `prepareHandin` and `confirmHandin`, both answer
 * `signed_out` (no session) and `invalid` (arguments that are not a uuid and
 * a form with a file). After a hand-in Moodle shows, the current route is
 * refreshed so the screens read the new state. Any failed confirm means the
 * sheet starts a new review (`prepareHandinAction` again) to try again; see
 * `src/server/handin/confirm.ts` for why a used code is never re-armed.
 *
 * Note: Next caps an action's request body at 1 MB unless
 * `serverActions.bodySizeLimit` is raised in next.config.ts; files up to our
 * 4 MB cap need that raised (outside this ticket's files).
 */
import { refresh } from "next/cache";
import { z } from "zod";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { setFlash } from "@/server/data/flash";
import { confirmHandin, type ConfirmResult } from "@/server/handin/confirm";
import { MAX_HANDIN_BYTES, prepareHandin, type HandinFile, type PrepareResult } from "@/server/handin/prepare";

type ActionRefusal = { ok: false; reason: "signed_out" | "invalid" };

export type PrepareHandinActionResult = PrepareResult | ActionRefusal;
export type ConfirmHandinActionResult = ConfirmResult | ActionRefusal;

const Id = z.uuid();

async function signedInId(): Promise<string | null> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

type ReadFile = { ok: true; file: HandinFile } | { ok: false; reason: "invalid" | "too_big" };

async function fileFrom(form: unknown): Promise<ReadFile> {
  if (!(form instanceof FormData)) return { ok: false, reason: "invalid" };
  const f = form.get("file");
  if (!(f instanceof Blob)) return { ok: false, reason: "invalid" };
  // Refuse before reading the bytes into memory.
  if (f.size > MAX_HANDIN_BYTES) return { ok: false, reason: "too_big" };
  const name = f instanceof File ? f.name : "";
  return { ok: true, file: { name, bytes: new Uint8Array(await f.arrayBuffer()) } };
}

export async function prepareHandinAction(assignmentId: unknown, form: unknown): Promise<PrepareHandinActionResult> {
  const id = Id.safeParse(assignmentId);
  if (!id.success) return { ok: false, reason: "invalid" };
  const userId = await signedInId();
  if (!userId) return { ok: false, reason: "signed_out" };
  const read = await fileFrom(form);
  if (!read.ok) return { ok: false, reason: read.reason };
  return prepareHandin(userId, id.data, read.file);
}

export async function confirmHandinAction(code: unknown, form: unknown): Promise<ConfirmHandinActionResult> {
  const parsed = Id.safeParse(code);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const userId = await signedInId();
  if (!userId) return { ok: false, reason: "signed_out" };
  const read = await fileFrom(form);
  // A file over the cap cannot be the one she reviewed.
  if (!read.ok) return read.reason === "too_big" ? { ok: false, reason: "changed" } : { ok: false, reason: "invalid" };
  const result = await confirmHandin(userId, parsed.data, read.file);
  if (result.ok) {
    // Home greets her once with "Handed in, ..." (M4-15).
    await setFlash("handedIn");
    refresh();
  }
  return result;
}
