/**
 * Home, thin (M1-27): the date, a plain hello, what to do first, what comes
 * after, and a link to every assignment.
 * Source: prototype main-flow.html HTML 1419-1477 (#tab-home: .date-line,
 * #sec-first, #done-row, #hero-a, #sec-then, #btn-all-assign) and CSS 422-444
 * (.home-grid, .date-line, .sec, .sec-label, .link-btn).
 *
 * On every visit it asks the sync runner for fresh Moodle data first (not
 * forced: nothing is asked when the last sync is under 10 minutes old). One
 * call does at most ~8 s of work and answers `more: true` when Moodle is slow;
 * Home then shows what is already stored instead of waiting.
 *
 * - No Moodle connection: sent to /connect.
 * - Connection status 'expired': a banner linking to /connect.
 * - Nothing open: DO FIRST shows her newest hand-in of the last 7 days.
 *
 * Everything depends on her cookie and the clock, so the page streams inside
 * Suspense (cacheComponents is on). Cut: no cap greeting bubble, bite row,
 * exam cards, week strip, grades card or Never miss one (M3, M4, M6, M7).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { HeroCard } from "@/components/home/hero-card";
import { Queue, QueueRow } from "@/components/home/queue-row";
import { Button } from "@/components/ui/button";
import { DoneRow } from "@/components/ui/done-row";
import { lmsNameOf } from "@/lib/schools";
import { dateLine, earlyBy, listDate, sameDay } from "@/lib/dates";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getHomeView, type HomeDone, type HomeFirst } from "@/server/data/home";
import { syncNow } from "@/server/sync/run";

/** The hero card turns urgent (due colour, time left) under this much time. */
const URGENT_MS = 24 * 60 * 60 * 1000;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

function SectionLabel({ id, children }: { id: string; children: string }) {
  return (
    <h2
      id={id}
      className="mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]"
    >
      {children}
    </h2>
  );
}

function doneMeta(a: HomeDone, now: Date): string {
  // Today: "15:52 · 5 h 8 min early". Earlier: "TUE 10 · 15:52 · ...".
  const when = sameDay(a.submittedAt, now) ? listDate(a.submittedAt).split(" · ")[1] : listDate(a.submittedAt);
  return a.dueAt ? `${when} · ${earlyBy(a.submittedAt, a.dueAt)}` : `${when} · ${a.course}`;
}

function DoFirst({ first, lastDone, now }: { first: HomeFirst | null; lastDone: HomeDone | null; now: Date }) {
  if (first?.dueAt) {
    const urgent = first.dueAt.getTime() - now.getTime() < URGENT_MS;
    return (
      <HeroCard
        title={first.title}
        course={first.course}
        code={first.code ?? ""}
        dueAt={first.dueAt}
        now={now}
        tone={urgent ? "urgent" : "soon"}
        estimateMin={first.estimateMin}
        href={first.href}
      />
    );
  }
  if (first) {
    // The hero card needs a due time; with none, it is the first row of the list.
    return (
      <Queue>
        <QueueRow
          position={1}
          title={first.title}
          course={first.course}
          dueAt={null}
          estimateMin={first.estimateMin}
          status={first.status}
          action={
            <Button size="sm" href={first.href}>
              Start
            </Button>
          }
        />
      </Queue>
    );
  }
  if (lastDone) {
    return <DoneRow title={`${lastDone.title} handed in`} meta={doneMeta(lastDone, now)} />;
  }
  return <p className="py-3 text-[15px] text-ink-2">Nothing open. Enjoy it.</p>;
}

async function HomeBody() {
  await connection();
  const user = await signedInUser();
  const lms = lmsNameOf(user);
  try {
    await syncNow(user.id, { force: false });
  } catch (err) {
    // A bug in the sync must not take Home down; it shows what is stored.
    console.error("Home sync failed", err);
  }
  const now = new Date();
  const view = await getHomeView(user.id, { now });
  if (!view.connection) redirect("/connect");

  return (
    <>
      <p className="mono text-ink-3">{dateLine(now)}</p>
      <h1 className="sr-only" tabIndex={-1}>
        Home
      </h1>

      {view.connection.status === "expired" && (
        <Link
          href="/connect"
          className="mt-4 block rounded-[14px] bg-butter px-4 py-3 text-[15px] font-medium text-ink"
        >
          {lms} signed you out. <span className="underline underline-offset-4">Reconnect.</span>
        </Link>
      )}

      <p className="mt-4 text-[17px]">{view.firstName ? `Hi ${view.firstName}.` : "Hi there."}</p>

      <section className="mt-8" aria-labelledby="lbl-first">
        <SectionLabel id="lbl-first">DO FIRST</SectionLabel>
        <DoFirst first={view.first} lastDone={view.lastDone} now={now} />
      </section>

      <section className="mt-8 flex flex-col" aria-labelledby="lbl-then">
        <SectionLabel id="lbl-then">THEN</SectionLabel>
        {view.then.length > 0 ? (
          <Queue>
            {view.then.map((a, i) => (
              <QueueRow
                key={a.id}
                position={i + 2}
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
          <p className="py-3 text-[15px] text-ink-2">Nothing else is open.</p>
        )}
        <Link
          href="/assignments"
          className={
            "mt-1 inline-flex min-h-11 items-center self-start text-[15px] font-semibold text-ink " +
            "underline decoration-line decoration-2 underline-offset-[5px] hover:decoration-accent"
          }
        >
          All assignments
        </Link>
      </section>
    </>
  );
}

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-10 min-[700px]:pt-8">
      <Suspense fallback={null}>
        <HomeBody />
      </Suspense>
    </div>
  );
}
