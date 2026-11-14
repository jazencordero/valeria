/**
 * One assignment, thin (M1-34): header with the due line, the brief, its
 * files, the file picker and the hand-in. The client part is
 * `WorkspaceThin`; this page reads her data and sets `seen_at` on the first
 * open. Another user's assignment, an unknown id or a malformed one is a 404.
 *
 * Everything here depends on the cookie and the id, so it streams inside
 * Suspense (cacheComponents). Cut: no chat (M2-20), no open-from-card
 * transition (M4-14).
 */
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { lmsNameOf } from "@/lib/schools";
import { WorkspaceThin } from "@/components/work/workspace-thin";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getAssignmentPage, markSeen } from "@/server/data/assignment";

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
    <WorkspaceThin
      id={page.id}
      title={page.title}
      dueAt={page.dueAt}
      handedInAt={page.handedInAt}
      brief={page.brief}
      files={page.files}
      acceptsFiles={page.acceptsFiles}
      maxBytes={page.maxBytes}
      maxFiles={page.maxFiles}
      lms={lmsNameOf(user)}
      lmsUrl={page.lmsUrl}
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
