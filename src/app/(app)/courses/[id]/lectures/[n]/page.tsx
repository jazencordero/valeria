/**
 * One lecture (M9-15): `/courses/<courseId>/lectures/<n>`. The client part is
 * `LecturePage`; this page reads her data (`getLecturePage`). Another user's
 * course, a hidden one, an unknown id, a malformed one or a lecture number
 * the course does not have is a 404.
 *
 * Everything here depends on the cookie and the params, so it streams inside
 * Suspense (cacheComponents). The client part is keyed by the lecture, so
 * "Next: Lecture n" starts the next one fresh (Read view, progress 0).
 */
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { LecturePage } from "@/components/lecture/lecture-page";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getLecturePage } from "@/server/data/lecture";

type Params = Promise<{ id: string; n: string }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function Lecture({ params }: { params: Params }) {
  const { id, n } = await params;
  await connection();
  const user = await signedInUser();
  const lecture = await getLecturePage(user.id, id, n, { now: new Date() });
  if (!lecture) notFound();
  return <LecturePage key={lecture.lectureId} lecture={lecture} lmsName={lmsNameOf(user)} />;
}

export default function LectureRoute({ params }: { params: Params }) {
  return (
    // An element, not null: after a client navigation Next scrolls to the page's first element once
    // it exists. With nothing in the fallback that scroll waits, and the mark-read action's refresh
    // then pulled her from the end of the page back to the top.
    <Suspense fallback={<div aria-hidden="true" />}>
      <Lecture params={params} />
    </Suspense>
  );
}
