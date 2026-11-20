/*
 * GET /study/new?exam=<id>&kind=<bite|tile|concept|extra|long>[&arg=<type or concept id>][&return=<path>]
 * GET /study/new?lecture=<id>[&return=<path>]
 * (M3-43, M9-15): starts a study session and sends her to it,
 * `/study/<sessionId>` (with `?return=<path>` when one was given).
 *
 * - `exam`: `beginSession` (M3-18). `kind=long` is today's remaining plan in
 *   one go ("Do them in one go").
 * - `lecture` (M9-15, "Practise this lecture"): every card tied to the
 *   lecture's concepts, through `beginLectureSession`
 *   (src/server/study/lecture-session.ts). A lecture with no cards, a
 *   malformed id or someone else's lecture: back to `return`, else Courses.
 * - `return`: where the done screen's back button, Stop and "nothing to
 *   study" go instead of the exam page. Only a same-site path counts
 *   (`safeReturn`: starts with "/", not "//", no backslash, no scheme);
 *   anything else is dropped as if it were not there.
 * - Nothing to study (today's bites are done, or no card fits): back to the
 *   exam page (or `return`), where the bite block already says so. No
 *   session row is made.
 * - A kind that is not one of the five, or a tile / concept session without
 *   its `arg`: back to the exam page as well; nothing is written.
 * - An exam whose day is over (`ExamOver`, whatever the kind): to its page,
 *   `/exams/<id>`, which says "This exam is over."; `return` is not used and
 *   no session row is made.
 * - No exam id, a malformed one, or an exam that does not exist or is
 *   someone else's: to the Exams tab, `/exams`.
 * - Not signed in: to `/`.
 *
 * Screens start sessions with `router.push`, never a <Link> to this URL, so
 * no prefetch ever runs this handler.
 */
import { redirect } from "next/navigation";
import { connection, type NextRequest } from "next/server";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { SESSION_MODES } from "@/server/db/schema/study";
import { beginSession } from "@/server/study/actions";
import { beginLectureSession, safeReturn } from "@/server/study/lecture-session";
import { ExamOver } from "@/server/study/start-date";
import { StudyNotFound } from "@/server/study/store";
import type { SessionKind } from "@/lib/study/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessionUrl = (id: string, ret: string | null) =>
  ret ? `/study/${id}?return=${encodeURIComponent(ret)}` : `/study/${id}`;

async function lectureSession(lecture: string, ret: string | null): Promise<never> {
  const back = ret ?? "/courses";
  if (!UUID.test(lecture)) redirect(back);
  let sessionId: string | null;
  try {
    const user = await currentUser();
    sessionId = (await beginLectureSession(user.id, lecture))?.sessionId ?? null;
  } catch (err) {
    if (err instanceof NotSignedIn) redirect("/");
    if (err instanceof StudyNotFound) sessionId = null;
    else throw err;
  }
  if (!sessionId) redirect(back);
  redirect(sessionUrl(sessionId, ret));
}

export async function GET(request: NextRequest) {
  await connection();
  const q = request.nextUrl.searchParams;
  const ret = safeReturn(q.get("return"));
  const lecture = q.get("lecture");
  if (lecture !== null) return lectureSession(lecture, ret);

  const exam = q.get("exam") ?? "";
  const kind = q.get("kind") ?? "bite";
  const arg = q.get("arg") ?? undefined;
  if (!UUID.test(exam)) redirect("/exams");

  const back = ret ?? `/exams/${exam}`;
  const known = kind === "long" || (SESSION_MODES as readonly string[]).includes(kind);
  if (!known || ((kind === "tile" || kind === "concept") && !arg)) redirect(back);

  let sessionId: string | null;
  try {
    const begun = await beginSession(exam, kind as SessionKind, arg);
    sessionId = begun?.sessionId ?? null;
  } catch (err) {
    if (err instanceof ExamOver) sessionId = "over";
    else if (err instanceof StudyNotFound) sessionId = "not-found";
    else if (err instanceof NotSignedIn) sessionId = "signed-out";
    // An unknown card type or a concept outside this exam: nothing to start.
    else if (err instanceof Error && err.message.startsWith("beginSession:")) sessionId = null;
    else throw err;
  }
  if (sessionId === "over") redirect(`/exams/${exam}`);
  if (sessionId === "not-found") redirect("/exams");
  if (sessionId === "signed-out") redirect("/");
  if (!sessionId) redirect(back);
  redirect(sessionUrl(sessionId, ret));
}
