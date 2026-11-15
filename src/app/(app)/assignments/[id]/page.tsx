/**
 * One assignment: the chat workspace (M2-22). The client part is `Workspace`
 * (header, sources, chat, AI-policy card, draft card, hand-in); this page
 * reads her data (the assignment, the course's AI rule, the stored chat and
 * her draft) and sets `seen_at` on the first open. Another user's
 * assignment, an unknown id or a malformed one is a 404.
 *
 * Everything here depends on the cookie and the id, so it streams inside
 * Suspense (cacheComponents). Cut: no open-from-card transition (M4-14).
 */
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { lmsNameOf } from "@/lib/schools";
import { Workspace as WorkspaceView } from "@/components/work/workspace";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getAssignmentPage, markSeen } from "@/server/data/assignment";
import { setCourseAiPolicy } from "./policy-actions";

type Params = Promise<{ id: string }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function Workspace({ params }: { params: Params }) {
  const { id } = await params;
  await connection();
  const user = await signedInUser();
  const page = await getAssignmentPage(user.id, id);
  if (!page) notFound();
  const now = new Date();
  await markSeen(user.id, page.id, now);

  return (
    <WorkspaceView
      id={page.id}
      title={page.title}
      courseName={page.course}
      dueAt={page.dueAt}
      handedInAt={page.handedInAt}
      brief={page.brief}
      files={page.files}
      acceptsFiles={page.acceptsFiles}
      maxBytes={page.maxBytes}
      maxFiles={page.maxFiles}
      lms={lmsNameOf(user)}
      lmsUrl={page.lmsUrl}
      connected={page.connected}
      aiAssignments={page.aiAssignments}
      setPolicy={setCourseAiPolicy.bind(null, page.courseId)}
      messages={page.messages}
      draft={page.draft}
      now={now}
      homeHref="/home"
    />
  );
}

export default function AssignmentPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <Workspace params={params} />
    </Suspense>
  );
}
