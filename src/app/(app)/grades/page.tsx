/**
 * Grades tab (M6-08): the overall number and one row per course, each a link
 * to that course's grade page. The body is `GradesListView`; this page reads
 * her data.
 *
 * The heading ships in the static shell; the rest depends on the cookie, so
 * it streams inside Suspense (cacheComponents).
 */
import { connection } from "next/server";
import { Suspense } from "react";
import { GradesListView } from "@/components/grades/grades-list";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getGradesList } from "@/server/data/grades";

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function GradesBody() {
  await connection();
  const user = await signedInUser();
  const list = await getGradesList(user.id);
  return <GradesListView {...list} lmsName={lmsNameOf(user)} />;
}

export default function GradesPage() {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <h1 className="type-h30" tabIndex={-1}>
        Grades
      </h1>
      <Suspense fallback={null}>
        <GradesBody />
      </Suspense>
    </div>
  );
}
