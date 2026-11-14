/*
 * M7-02: her private calendar feed.
 *
 * GET /api/cal/<token>  (or /api/cal/<token>.ics)
 * - No session: calendar apps cannot sign in. The token in the path is the only key.
 * - Malformed, unknown or revoked token: 404, the same answer for all three.
 * - Otherwise the iCalendar text of her deadlines and exams (`text/calendar; charset=utf-8`),
 *   `Cache-Control: private, max-age=900`.
 * Nothing here logs: not the token, not the path.
 */
import { buildCalendar } from "@/lib/ics";
import { CALENDAR_NAME, itemsForToken } from "@/server/calendar/feed";
import { db } from "@/server/db/client";

const notFound = () =>
  new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token: raw } = await params;
  if (typeof raw !== "string") return notFound();
  const token = raw.endsWith(".ics") ? raw.slice(0, -4) : raw;

  const items = await itemsForToken(token, db);
  if (!items) return notFound();

  return new Response(buildCalendar(items, { name: CALENDAR_NAME }), {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="ready.ics"',
      "cache-control": "private, max-age=900",
      "x-content-type-options": "nosniff",
    },
  });
}
