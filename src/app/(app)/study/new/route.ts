/*
 * GET /study/new?exam=<id>&kind=<bite|tile|concept|extra>[&arg=<type or concept id>]
 * (M3-43): starts a study session with `beginSession` (M3-18) and sends her to
 * it, `/study/<sessionId>`.
 *
 * - Nothing to study (today's bites are done, or no card fits): back to the
 *   exam page, where the bite block already says so. No session row is made.
 * - A kind that is not one of the four, or a tile / concept session without
 *   its `arg`: back to the exam page as well; nothing is written.
 * - No exam id, a malformed one, or an exam that does not exist or is
 *   someone else's: to the Exams tab, `/exams`.
 * - Not signed in: to `/`.
 *
 * The exam page starts sessions with `router.push`, never a <Link>, so no
 * prefetch ever runs this handler.
 */
import { redirect } from "next/navigation";
import { connection, type NextRequest } from "next/server";
import { NotSignedIn } from "@/server/auth/session";
import { SESSION_MODES } from "@/server/db/schema/study";
import { beginSession } from "@/server/study/actions";
import { StudyNotFound } from "@/server/study/store";
import type { SessionMode } from "@/lib/study/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  await connection();
  const q = request.nextUrl.searchParams;
  const exam = q.get("exam") ?? "";
  const kind = q.get("kind") ?? "bite";
  const arg = q.get("arg") ?? undefined;
  if (!UUID.test(exam)) redirect("/exams");

  const back = `/exams/${exam}`;
  const known = (SESSION_MODES as readonly string[]).includes(kind);
  if (!known || ((kind === "tile" || kind === "concept") && !arg)) redirect(back);

  let sessionId: string | null;
  try {
    const begun = await beginSession(exam, kind as SessionMode, arg);
    sessionId = begun?.sessionId ?? null;
  } catch (err) {
    if (err instanceof StudyNotFound) sessionId = "not-found";
    else if (err instanceof NotSignedIn) sessionId = "signed-out";
    // An unknown card type or a concept outside this exam: nothing to start.
    else if (err instanceof Error && err.message.startsWith("beginSession:")) sessionId = null;
    else throw err;
  }
  if (sessionId === "not-found") redirect("/exams");
  if (sessionId === "signed-out") redirect("/");
  if (!sessionId) redirect(back);
  redirect(`/study/${sessionId}`);
}
