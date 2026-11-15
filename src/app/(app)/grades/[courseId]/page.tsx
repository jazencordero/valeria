/**
 * One course's grade page (M6-08). The client part is `GradePage` (target,
 * what-ifs, tabs); this page reads her data. Another user's course, a hidden
 * one, an unknown id or a malformed one is a 404.
 *
 * `saveTargetAction` is an inline Server Action: it finds the signed-in user
 * itself, so a caller can only change her own course. The weights card uses
 * M6-04's `saveWeightsAction`.
 *
 * Everything here depends on the cookie and the id, so it streams inside
 * Suspense (cacheComponents).
 */
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { GradePage } from "@/components/grades/grade-page";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { getCourseGrades, saveTargetFor, type SaveTargetResult } from "@/server/data/grades";
import { saveWeightsAction } from "../actions";

type Params = Promise<{ courseId: string }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

/** Saves the grade she aims for in one course. */
async function saveTargetAction(courseId: string, target: number): Promise<SaveTargetResult> {
  "use server";
  let user: User;
  try {
    user = await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return { ok: false, message: "You are signed out. Reload the page and try again." };
    throw err;
  }
  const result = await saveTargetFor(db, user.id, courseId, target);
  if (result.ok) revalidatePath("/grades", "layout");
  return result;
}

async function CourseGrades({ params }: { params: Params }) {
  const { courseId } = await params;
  await connection();
  const user = await signedInUser();
  const page = await getCourseGrades(user.id, courseId);
  if (!page) notFound();
  return (
    <GradePage
      key={page.course.id}
      course={page.course}
      items={page.items}
      needsWeights={page.needsWeights}
      lmsName={lmsNameOf(user)}
      saveTarget={saveTargetAction}
      saveWeights={saveWeightsAction}
    />
  );
}

export default function CourseGradesRoute({ params }: { params: Params }) {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(8px,env(safe-area-inset-top,0px))] pb-10">
      <Suspense fallback={null}>
        <CourseGrades params={params} />
      </Suspense>
    </div>
  );
}
