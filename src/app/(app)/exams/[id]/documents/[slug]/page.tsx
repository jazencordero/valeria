/**
 * One exam document (M3-54), read in `DocumentReader`. The document is found
 * by her user id, the exam id and the slug together: another user's document,
 * a document of another exam, an unknown or malformed id, or an exam of a
 * course she has hidden is a 404 (the same rule as the exam page).
 *
 * Document text is hers and her teachers': it is only shown to her here, never
 * sent to a model.
 *
 * The cookie and the params make it dynamic, so it streams inside Suspense
 * (cacheComponents), like the exam page (M3-42).
 *
 * The two loaders take a `Db`, so tests run them against `createTestDb()`.
 * `loadExamDocuments` is the exam page's list (its Today tab, `ExamDocuments`).
 */
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { DocumentReader } from "@/components/exams/document-reader";
import { readingMinutes, type ExamDocumentRow } from "@/components/exams/exam-documents";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { db, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { examDocuments, exams } from "@/server/db/schema/study";

type Params = Promise<{ id: string; slug: string }>;

const ExamId = z.uuid();
const Slug = z.string().regex(/^[a-z0-9-]{1,200}$/);

/** Her exam with this id, if it is hers and its course is not hidden. */
const visibleExam = (userId: string, examId: string) =>
  and(
    eq(examDocuments.examId, examId),
    eq(examDocuments.userId, userId),
    eq(exams.userId, userId),
    eq(courses.userId, userId),
    eq(courses.hidden, false),
  );

/** Her documents for one exam, in `position` order (then slug, so ties stay put). */
export async function loadExamDocuments(database: Db, userId: string, examId: string): Promise<ExamDocumentRow[]> {
  if (!ExamId.safeParse(examId).success) return [];
  const rows = await database
    .select({ slug: examDocuments.slug, title: examDocuments.title, bodyMd: examDocuments.bodyMd })
    .from(examDocuments)
    .innerJoin(exams, eq(exams.id, examDocuments.examId))
    .innerJoin(courses, eq(courses.id, exams.courseId))
    .where(visibleExam(userId, examId))
    .orderBy(asc(examDocuments.position), asc(examDocuments.slug));
  return rows.map((r) => ({ slug: r.slug, title: r.title, minutes: readingMinutes(r.bodyMd) }));
}

export type LoadedDocument = { examId: string; title: string; bodyMd: string; minutes: number };

/** One of her documents, or null when it is not hers (or not there). */
export async function loadExamDocument(
  database: Db,
  userId: string,
  examId: string,
  slug: string,
): Promise<LoadedDocument | null> {
  if (!ExamId.safeParse(examId).success || !Slug.safeParse(slug).success) return null;
  const [row] = await database
    .select({ title: examDocuments.title, bodyMd: examDocuments.bodyMd })
    .from(examDocuments)
    .innerJoin(exams, eq(exams.id, examDocuments.examId))
    .innerJoin(courses, eq(courses.id, exams.courseId))
    .where(and(visibleExam(userId, examId), eq(examDocuments.slug, slug)));
  if (!row) return null;
  return { examId, title: row.title, bodyMd: row.bodyMd, minutes: readingMinutes(row.bodyMd) };
}

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function ExamDocument({ params }: { params: Params }) {
  const { id, slug } = await params;
  await connection();
  const user = await signedInUser();
  const doc = await loadExamDocument(db, user.id, id, slug);
  if (!doc) notFound();
  return <DocumentReader examId={doc.examId} title={doc.title} bodyMd={doc.bodyMd} minutes={doc.minutes} />;
}

export default function ExamDocumentRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <ExamDocument params={params} />
    </Suspense>
  );
}
