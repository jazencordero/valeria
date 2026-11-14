/**
 * Assignments tab: everything open in the order to do them, filtered by
 * course, then what she has handed in.
 * Source: prototype main-flow.html HTML 1537-1576 (#tab-assign) and
 * CSS 770-782 (.page, .page-sub, .filters, .empty, .done-label, .done-list).
 *
 * The heading ships in the static shell; her lists depend on the cookie and
 * `?course=`, so they stream inside Suspense. Cut: no search, no sort options.
 */
import { connection } from "next/server";
import { Suspense } from "react";
import { FilterChips } from "@/components/assignments/filter-chips";
import { Doodle, DoodleDefs } from "@/components/doodle";
import { Queue, QueueRow } from "@/components/home/queue-row";
import { Button } from "@/components/ui/button";
import { DoneRow } from "@/components/ui/done-row";
import { listDate, sameDay } from "@/lib/dates";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getAssignmentsView, type DoneAssignment } from "@/server/data/assignments";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

function doneMeta(a: DoneAssignment, now: Date): string {
  // Today: just the time, "15:52 · Forecasting Methods". Earlier: "TUE 10 · 15:52 · ...".
  const when = sameDay(a.submittedAt, now) ? listDate(a.submittedAt).split(" · ")[1] : listDate(a.submittedAt);
  return `${when} · ${a.course}`;
}

function Empty({ doodle, children }: { doodle: "sun" | "done"; children: string }) {
  return (
    <div className="flex items-center gap-3 py-3 text-[13px] text-ink-3">
      <Doodle name={doodle} size={56} className="flex-none" />
      <p>{children}</p>
    </div>
  );
}

async function AssignmentLists({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await connection();
  const user = await signedInUser();
  const now = new Date();
  const course = typeof query.course === "string" ? query.course : null;
  const view = await getAssignmentsView(user.id, { course, now });

  return (
    <>
      <DoodleDefs />
      <FilterChips courses={view.courses} selected={view.course} />

      {view.open.length > 0 ? (
        <Queue>
          {view.open.map((a, i) => (
            <QueueRow
              key={a.id}
              position={i + 1}
              title={a.title}
              course={a.course}
              dueAt={a.dueAt}
              estimateMin={a.estimateMin}
              status={a.status}
              action={
                <Button size="sm" href={a.href}>
                  Start
                </Button>
              }
            />
          ))}
        </Queue>
      ) : (
        <Empty doodle="sun">Nothing open here. Enjoy it.</Empty>
      )}

      <h2 className="mono mt-8 mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]">
        DONE
      </h2>
      {view.done.length > 0 ? (
        <ul className="list-none">
          {view.done.map((a) => (
            <DoneRow key={a.id} as="li" title={`${a.title} handed in`} meta={doneMeta(a, now)} />
          ))}
        </ul>
      ) : (
        <Empty doodle="done">Nothing handed in yet.</Empty>
      )}
    </>
  );
}

export default function AssignmentsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <h1 className="type-h30" tabIndex={-1}>
        Assignments
      </h1>
      <p className="mt-1.5 text-[15px] text-ink-2">In the order to do them.</p>
      <Suspense fallback={null}>
        <AssignmentLists searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
