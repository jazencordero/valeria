/**
 * Connect (M1-35, full in M5-08): after /school. "Continue with {school}"
 * opens the QR way in (scan on a phone, upload on a laptop), with "Paste a
 * key instead" underneath. Once connected, the first sync starts and she goes
 * to /sorting. Home sends her here when she has no connection, and links here
 * when her key has expired.
 *
 * The (first-run) group has no layout of its own: no tab bar or side nav
 * before she is connected. Her school (so the LMS name) comes from her user
 * row, which depends on her cookie, so the body streams inside Suspense
 * (cacheComponents is on) after `connection()`.
 *
 * Cut: no one-tap sign-in (not possible on the web): one tap plus the QR code.
 */
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Connect } from "@/components/first-run/connect";
import { lmsNameOf, schoolOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { connectAction, startFirstSyncAction } from "./actions";
import { connectQrAction } from "./qr-actions";

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
  const school = schoolOf(user);
  return (
    <Connect
      lmsName={lmsNameOf(user)}
      schoolName={school.name}
      siteUrl={school.siteUrl}
      pasteAction={connectAction}
      qrAction={connectQrAction}
      connected={startFirstSyncAction}
    />
  );
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
