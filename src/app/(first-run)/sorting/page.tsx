/**
 * Sorting (M5-11): after /connect. The sorting scene (M5-10) plays while her
 * first sync runs, then confetti and the wipe take her to /home?arrive=1,
 * where Home builds itself. Skip goes straight there; the sync carries on.
 *
 * Her school (so the LMS name and the first hat line) and her programme come
 * from the database and depend on her cookie, so the body streams inside
 * Suspense (cacheComponents is on) after `connection()`. Not signed in: the
 * front door. Not connected: /connect.
 */
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SortingFlow } from "@/components/first-run/wipe";
import { lmsNameOf, schoolIdOf } from "@/lib/schools";
import { guessProgramme } from "@/lib/sorting/script";
import { currentUser, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";

export const metadata: Metadata = { title: "Sorting · Ready" };

async function signedInUser(): Promise<User | null> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

async function SortingBody() {
  await connection();
  const user = await signedInUser();
  if (!user) redirect("/");
  const [conn] = await db
    .select({ userId: moodleConnections.userId })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, user.id))
    .limit(1);
  if (!conn) redirect("/connect");
  // Courses the sync has already stored (often none yet on a first run).
  const codes = await db.select({ code: courses.code }).from(courses).where(eq(courses.userId, user.id));
  return <SortingFlow lmsName={lmsNameOf(user)} school={schoolIdOf(user)} programme={guessProgramme(codes)} />;
}

export default function SortingPage() {
  return (
    <main>
      <Suspense fallback={null}>
        <SortingBody />
      </Suspense>
    </main>
  );
}
