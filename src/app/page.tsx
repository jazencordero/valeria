/**
 * The front door: a brand-new visitor goes to /welcome (M5-11), one with no
 * Moodle connection to /connect, otherwise /home.
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

/** Where she goes: brand-new (no user row) to /welcome, not connected to /connect, else /home. */
async function destination(): Promise<"/welcome" | "/connect" | "/home"> {
  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (err) {
    // A first visit has no user row yet: first run starts at Welcome (M5-11).
    if (err instanceof NotSignedIn) return "/welcome";
    throw err;
  }
  const [row] = await db
    .select({ userId: moodleConnections.userId })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  return row ? "/home" : "/connect";
}

async function FrontDoor(): Promise<null> {
  await connection();
  redirect(await destination());
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <FrontDoor />
    </Suspense>
  );
}
