/**
 * Connect, thin (M1-35): paste your Moodle key. On success the action runs
 * the first sync and sends her to /home; Home sends her here when she has no
 * connection, and links here when her key has expired.
 *
 * The (first-run) group has no layout of its own: no tab bar or side nav
 * before she is connected. Her school (so the LMS name) comes from her user
 * row, which depends on her cookie, so the body streams inside Suspense
 * (cacheComponents is on) after `connection()`.
 *
 * Cut: no QR, no one-tap sign-in, no school choice. M5 replaces this body and
 * keeps paste as the last option.
 */
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PasteKey } from "@/components/first-run/paste-key";
import { lmsNameOf, schoolOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { connectAction } from "./actions";

export const metadata: Metadata = { title: "Connect · Ready" };

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function ConnectBody() {
  await connection();
  const user = await signedInUser();
  return <PasteKey lmsName={lmsNameOf(user)} siteUrl={schoolOf(user).siteUrl} action={connectAction} />;
}

export default function ConnectPage() {
  return (
    <main>
      <Suspense fallback={null}>
        <ConnectBody />
      </Suspense>
    </main>
  );
}
