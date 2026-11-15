/*
 * M2-20: download her draft as a PDF she can hand in.
 *
 * GET /api/drafts/<assignments.id>/pdf
 * - Not signed in, a malformed id, an unknown assignment, another user's assignment, or no
 *   draft yet: 404 `{error:'not_found'}`, the same answer for all, so ids cannot be probed.
 * - Otherwise the PDF from src/server/drafts/pdf.ts as an attachment, never cached.
 *
 * The model named in "Use of AI": drafts do not record which model wrote them (M2-19), so it is
 * read from the AI call log (`ai_calls`, written by the router for every call). The draft is
 * saved by a tool in the middle of an `assignment-chat` stream and the call is logged when the
 * stream ends, so the call that wrote it is her first successful `assignment-chat` call logged
 * at or after the draft's `updated_at`; failing that, the last one before it. No call found
 * (the log is kept apart from her data): "not recorded". She can still edit the section.
 * The date in that section is the draft's `updated_at`, the day the AI wrote it.
 *
 * Nothing here logs.
 */
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { NotSignedIn, SESSION_COOKIE, currentUserFor } from "@/server/auth/session";
import { db, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { aiCalls } from "@/server/db/schema/system";
import { assignments } from "@/server/db/schema/work";
import { DraftNotFound, getDraft } from "@/server/drafts/store";
import { draftToPdf } from "@/server/drafts/pdf";

// Runs on the Node.js runtime, the default. `export const runtime` is refused when
// cacheComponents is on, so it is not written out.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_JOB = "assignment-chat";

const notFound = () =>
  Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } });

function sessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>` (RFC 6266 / RFC 5987). */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The model of the chat call that wrote the draft (see the note at the top). */
async function draftModel(database: Db, userId: string, savedAt: Date): Promise<string> {
  const mine = and(eq(aiCalls.userId, userId), eq(aiCalls.job, CHAT_JOB), eq(aiCalls.ok, true));
  const [after] = await database
    .select({ model: aiCalls.model })
    .from(aiCalls)
    .where(and(mine, gte(aiCalls.createdAt, savedAt)))
    .orderBy(asc(aiCalls.createdAt))
    .limit(1);
  if (after) return after.model;
  const [before] = await database
    .select({ model: aiCalls.model })
    .from(aiCalls)
    .where(and(mine, lt(aiCalls.createdAt, savedAt)))
    .orderBy(desc(aiCalls.createdAt))
    .limit(1);
  return before?.model ?? "not recorded";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<Response> {
  let user;
  try {
    user = await currentUserFor(db, sessionToken(request));
  } catch (error) {
    if (error instanceof NotSignedIn) return notFound();
    throw error;
  }

  const { assignmentId } = await params;
  if (typeof assignmentId !== "string" || !UUID.test(assignmentId)) return notFound();

  let draft;
  try {
    draft = await getDraft(user.id, assignmentId, db);
  } catch (error) {
    if (error instanceof DraftNotFound) return notFound();
    throw error;
  }
  if (!draft) return notFound();

  const [course] = await db
    .select({ name: courses.name })
    .from(assignments)
    .innerJoin(courses, eq(courses.id, assignments.courseId))
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, user.id)))
    .limit(1);
  if (!course) return notFound();

  const model = await draftModel(db, user.id, draft.updatedAt);
  const pdf = await draftToPdf(draft, {
    studentName: user.displayName ?? "",
    courseName: course.name,
    model,
    date: draft.updatedAt,
  });

  return new Response(pdf.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(pdf.fileName),
      "content-length": String(pdf.bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
