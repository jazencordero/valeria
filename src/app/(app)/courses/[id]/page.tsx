/**
 * One course (M9-08): its code, name, stat chips and lecture path. The client
 * part is `CoursePage`; this page reads her data. Another user's course, a
 * hidden one, an unknown id or a malformed one is a 404.
 *
 * Everything here depends on the cookie and the id, so it streams inside
 * Suspense (cacheComponents).
 */
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { CoursePage } from "@/components/courses/course-page";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getCoursePage } from "@/server/data/courses";

type Params = Promise<{ id: string }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function Course({ params }: { params: Params }) {
  const { id } = await params;
  await connection();
  const user = await signedInUser();
  const page = await getCoursePage(user.id, id, { now: new Date() });
  if (!page) notFound();
  return <CoursePage course={page} lmsName={lmsNameOf(user)} />;
}

export default function CourseRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <Course params={params} />
    </Suspense>
  );
}
