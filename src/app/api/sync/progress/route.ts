import { currentUser, NotSignedIn } from "@/server/auth/session";
import { startFirstSync, syncProgress } from "@/server/sync/progress";

// First-sync progress for the sorting scene (M5-07). See src/server/sync/progress.ts
// for how `stage` is worked out and when it is 'done'.
//
// GET  /api/sync/progress -> { stage, courses, files, dates } for the current user.
//      The client polls this once a second while first run is on screen.
// POST /api/sync/progress -> starts her first sync without waiting for it, then
//      answers { started, stage, courses, files, dates }. `started` is false when
//      one is already running for her on this server. Safe to send again (after a
//      reload, or when the stage has not moved for a long time): an unfinished sync
//      is continued, a finished one is not repeated.
// Signed out: 401 { error: 'not_signed_in' }. Answers are never cached.
//
// The sync runs in `after` (next/server), which lives as long as this route's
// maxDuration (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md).
// 300 s is the most Vercel's free plan allows with fluid compute (sources in
// ../route.ts); runFirstSync starts no new Moodle step after 150 s and does not
// begin listing files after 200 s, which leaves the step in flight time to end.
export const maxDuration = 300;

const NO_STORE = { "cache-control": "no-store" };

async function signedInUserId(): Promise<string | null> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

const notSignedIn = () => Response.json({ error: "not_signed_in" }, { status: 401, headers: NO_STORE });

export async function GET(): Promise<Response> {
  const userId = await signedInUserId();
  if (!userId) return notSignedIn();
  return Response.json(await syncProgress(userId), { headers: NO_STORE });
}

export async function POST(): Promise<Response> {
  const userId = await signedInUserId();
  if (!userId) return notSignedIn();
  const { started } = startFirstSync(userId);
  return Response.json({ started, ...(await syncProgress(userId)) }, { status: 202, headers: NO_STORE });
}
