/**
 * The front door: no Moodle connection goes to /connect, otherwise /home.
 * The old v0 app (typed-in exams, weekly hours) lived here; it is gone.
 *
 * The user comes from the session cookie, so the check runs per request
 * inside Suspense (cacheComponents), the same way the app pages do.
 */
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";

async function hasConnection(): Promise<boolean> {
  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (err) {
    // A first visit has no user row yet, so nothing is connected.
    if (err instanceof NotSignedIn) return false;
    throw err;
  }
  const [row] = await db
    .select({ userId: moodleConnections.userId })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  return Boolean(row);
}

async function FrontDoor(): Promise<null> {
  await connection();
  redirect((await hasConnection()) ? "/home" : "/connect");
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <FrontDoor />
    </Suspense>
  );
}
