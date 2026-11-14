/*
 * GET /demo: this browser becomes the demo account and lands on Home (M1-37).
 * GET /demo?reset=1: the demo is wiped and seeded again (the prototype's
 * "Restart demo"); hand-ins made in it are gone.
 *
 * - Without the fake Moodle (MOODLE_FAKE unset) or in production: 404, and
 *   nothing is read or written.
 * - This browser already holds someone's own data (a Moodle connection,
 *   courses or assignments): 409, nothing changes. Demo data never goes into
 *   a real account.
 * The rules live in `@/server/demo/seed`.
 */
import { redirect } from "next/navigation";
import { connection, type NextRequest } from "next/server";
import { ensureSession } from "@/server/auth/session";
import { demoAllowed, openDemo } from "@/server/demo/seed";

// The sync behind the seed may wait on the fake for a few seconds at most;
// same budget as POST /api/sync.
export const maxDuration = 60;

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function GET(request: NextRequest) {
  // Decided per request: without this the build would bake the answer (the 404
  // when the build ran without MOODLE_FAKE) into a static file.
  await connection();
  if (!demoAllowed()) return text("The demo is not available here.", 404);

  const user = await ensureSession();
  const reset = request.nextUrl.searchParams.get("reset") === "1";
  const result = await openDemo(user, { reset });
  if (!result.ok) {
    return text("This browser already holds your own data, so the demo was not started. Open it in a private window.", 409);
  }
  redirect("/home");
}
