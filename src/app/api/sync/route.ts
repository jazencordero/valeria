import { currentUser, NotSignedIn } from "@/server/auth/session";
import { syncNow } from "@/server/sync/run";

// POST /api/sync runs one step of the Moodle refresh for the current user and
// answers { ran, added, status, more }. The client calls again while `more` is
// true. Body (optional): { "force": true } to refresh although the last sync is
// under 10 minutes old.
//
// The host stops a request after a fixed time. `syncNow` starts no new Moodle
// call after 8 seconds, but a call already on its way may still wait for a slow
// Moodle (15 s timeout, plus waits when Moodle says "slow down"), so the route
// gets 60 seconds. Vercel's free (Hobby) plan allows 300 s, default and
// maximum, with fluid compute (on by default), so 60 is well inside it.
// Sources, read 2026-11-14:
// https://vercel.com/docs/functions/configuring-functions/duration#duration-limits
// https://vercel.com/docs/functions/limitations#max-duration
// Set the way node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 60;

export async function POST(request: Request) {
  let user;
  try {
    user = await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return Response.json({ error: "not_signed_in" }, { status: 401 });
    throw err;
  }

  // No body, or one that is not JSON, means "not forced".
  const body: unknown = await request.json().catch(() => null);
  const force = typeof body === "object" && body !== null && (body as { force?: unknown }).force === true;

  return Response.json(await syncNow(user.id, { force }));
}
