/**
 * The front door: a brand-new visitor goes to /welcome (M5-11), an account
 * (M5-14) where log in would send it, a device-only visitor with no Moodle
 * connection to /connect, otherwise /home.
 * The old v0 app (typed-in exams, weekly hours) lived here; it is gone.
 *
 * The user comes from the session cookie, so the check runs per request
 * inside Suspense (cacheComponents), the same way the app pages do.
 */
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { landingFor } from "@/server/auth/accounts";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";

/**
 * Where she goes: brand-new (no user row) to /welcome; an account (M5-14) where log in would
 * send it (`landingFor`: Home, or /school before the first run began); a device-only visitor
 * not connected to /connect; else /home.
 */
async function destination(): Promise<"/welcome" | "/connect" | "/home" | "/school"> {
  let userId: string;
  try {
    const user = await currentUser();
    // An account (M5-14) goes where log in sends it: never to /connect just for no Moodle.
    if (user.username) return landingFor(db, user.id);
    userId = user.id;
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
