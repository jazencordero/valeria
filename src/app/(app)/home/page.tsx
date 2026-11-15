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
 * Suspense (cacheComponents is on).
 *
 * M3-44: under the DO FIRST card, the bite row (prototype main-flow.html HTML
 * 1459, JS 2897-2902): today's bite for the soonest exam that has one, or
 * "Today's bites are done". When nothing is open the bite is the DO FIRST
 * card itself. After THEN, the EXAMS AND QUIZZES section (HTML 1479-1482)
 * with M3-22's Home exam card for every upcoming exam, soonest first.
 * `getHomeView` says which exam and what each card shows.
 *
 * M4-10, the complete layout (prototype main-flow.html HTML 1420-1506, CSS
 * 421-430, 591 (.home-top), 808-810 (two columns) and 958-982):
 * - A sticky top row with the date line; under 700 px it also holds the
 *   theme button (on wide screens the side nav has it).
 * - Vitonen's greeting bubble with `getHomeView`'s `greeting()` sentence. The
 *   flash cookie (`src/server/data/flash.ts`) says when she has just handed
 *   in or studied; it is only read here and expires on its own.
 * - The NEW tag on queue rows comes with each row's status (`isNew`).
 * - Main column: greeting, DO FIRST, THEN, EXAMS AND QUIZZES. Rail: THIS WEEK
 *   (later: grades, Never miss one). One column below a 960 px wide content
 *   area; from there (the prototype's container query, on the scrolling
 *   main) the rail is a 340 px second column next to a main of up to 720 px.
 *
 * Cut: grades card and Never miss one (M6-09, M7-04).
 *
 * M4-11: `/home?arrive=1` (the first visit after connecting) plays the build
 * once: `Arrive` (a client component) is the grid, and each section carries
 * `data-arrive-part` and its place in the order. Any other visit, and the
 * test switch (?fast=1 or the READY_FAST cookie), renders the same markup at
 * rest. Source: prototype main-flow.html JS 4042-4076.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";
import { DoodleDefs } from "@/components/doodle";
import { CONCEPT_ICON_NAMES, ConceptIcon, iconFor, type ConceptIconName } from "@/components/exams/concept-icons";
import { Arrive } from "@/components/home/arrive";
import { BiteRow, HomeExamCard } from "@/components/home/bite-row";
import { Greeting } from "@/components/home/greeting";
import { HeroCard } from "@/components/home/hero-card";
import { Queue, QueueRow } from "@/components/home/queue-row";
import { WeekCard } from "@/components/home/week-card";
import { Button } from "@/components/ui/button";
import { DoneRow } from "@/components/ui/done-row";
import { StickyHeader } from "@/components/ui/sticky-header";
import { ThemeButton } from "@/components/ui/theme-button";
import { lmsNameOf } from "@/lib/schools";
import { dateLine, earlyBy, listDate, sameDay } from "@/lib/dates";
import { FAST_COOKIE, FAST_PARAM } from "@/lib/motion/fast";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { readFlash } from "@/server/data/flash";
import { getHomeView, type HomeBite, type HomeDone, type HomeExam, type HomeFirst } from "@/server/data/home";
import { syncNow } from "@/server/sync/run";

/** The hero card turns urgent (due colour, time left) under this much time. */
const URGENT_MS = 24 * 60 * 60 * 1000;

type Search = Promise<{ [key: string]: string | string[] | undefined }>;

/** Marks a section for `Arrive`: its place in the order; `bare` rises in without an outline. */
function part(i: number, bare = false) {
  return { "data-arrive-part": bare ? "bare" : "", style: { "--arrive-i": i } as CSSProperties };
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
  // What she handed in this week stays on top as a done row, above what is next.
  const done = lastDone ? (
    <DoneRow title={`${lastDone.title} handed in`} meta={doneMeta(lastDone, now)} />
  ) : null;
  if (first && done) {
    return (
      <>
        {done}
        <div className="mt-3">
          <DoFirst first={first} lastDone={null} now={now} />
        </div>
      </>
    );
  }
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
  if (done) return done;
  return <p className="py-3 text-[15px] text-ink-2">Nothing open. Enjoy it.</p>;
}

function BiteFor({ bite, first = false, className }: { bite: HomeBite; first?: boolean; className?: string }) {
  return bite.state === "bite" ? (
    <BiteRow
      state="bite"
      minutes={bite.minutes}
      cards={bite.cards}
      gain={bite.gain}
      forWhat={bite.forWhat}
      href={bite.href}
      first={first}
      className={className}
    />
  ) : (
    <BiteRow state="done" forecast={bite.forecast} day={bite.day} href={bite.href} className={className} />
  );
}

const iconName = (icon: string | null, name: string): ConceptIconName =>
  (CONCEPT_ICON_NAMES as readonly string[]).includes(icon ?? "") ? (icon as ConceptIconName) : iconFor(name);

function ExamCards({ exams }: { exams: HomeExam[] }) {
  return (
    <ul className="grid list-none gap-3.5 p-0">
      {exams.map((e) => (
        <li key={e.id}>
          <HomeExamCard
            href={e.href}
            biteHref={e.biteHref}
            kind={e.kind}
            title={e.title}
            course={e.course}
            when={e.when}
            forecast={e.forecast}
            spark={e.spark}
            target={e.target}
            grade={e.grade}
            verdict={e.verdict}
            concepts={e.concepts.map((c) => ({
              id: c.id,
              name: c.name,
              rung: c.rung,
              icon: <ConceptIcon name={iconName(c.icon, c.name)} />,
            }))}
            biteMinutes={e.biteMinutes}
            making={e.making}
          />
        </li>
      ))}
    </ul>
  );
}

const GRID =
  "mx-auto grid max-w-[720px] grid-cols-[minmax(0,1fr)] gap-x-10 px-[var(--pad)] pb-4 " +
  "pt-[max(16px,env(safe-area-inset-top,0px))] min-[700px]:px-10 min-[700px]:pt-8 min-[700px]:pb-6 " +
  "min-[700px]:[--pad:40px] @min-[960px]:max-w-[1100px] @min-[960px]:grid-cols-[minmax(0,720px)_340px]";

async function HomeBody({ searchParams }: { searchParams: Search }) {
  await connection();
  const query = await searchParams;
  const fast = query[FAST_PARAM] === "1" || (await cookies()).has(FAST_COOKIE);
  const arrive = query.arrive === "1" && !fast;
  const user = await signedInUser();
  const lms = lmsNameOf(user);
  try {
    await syncNow(user.id, { force: false });
  } catch (err) {
    // A bug in the sync must not take Home down; it shows what is stored.
    console.error("Home sync failed", err);
  }
  const now = new Date();
  const flash = await readFlash(now);
  const view = await getHomeView(user.id, { now, flash });
  if (!view.connection) redirect("/connect");

  return (
    <Arrive play={arrive} className={GRID}>
      <div className="flex min-w-0 flex-col">
        <StickyHeader
          {...part(0, true)}
          className="-mx-[var(--pad)] -mt-1.5 flex min-h-11 items-center justify-between pr-[calc(var(--pad)-12px)] pl-[var(--pad)]"
        >
          <p className="mono text-ink-3">{dateLine(now)}</p>
          <ThemeButton className="min-[700px]:hidden" />
        </StickyHeader>
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

        <div {...part(1)}>
          <Greeting sentence={view.greeting} />
        </div>

        <DoodleDefs />

        <section {...part(2)} className="mt-8" aria-labelledby="lbl-first">
          <SectionLabel id="lbl-first">DO FIRST</SectionLabel>
          {view.biteFirst && view.bite ? (
            <>
              {view.lastDone && <DoFirst first={null} lastDone={view.lastDone} now={now} />}
              <BiteFor bite={view.bite} first className={view.lastDone ? "mt-3" : undefined} />
            </>
          ) : (
            <>
              <DoFirst first={view.first} lastDone={view.lastDone} now={now} />
              {view.bite && <BiteFor bite={view.bite} className="mt-3" />}
            </>
          )}
        </section>

        <section {...part(3)} className="mt-8 flex flex-col" aria-labelledby="lbl-then">
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

        {view.exams.length > 0 && (
          <section {...part(4)} className="mt-8" aria-labelledby="lbl-exams">
            <SectionLabel id="lbl-exams">EXAMS AND QUIZZES</SectionLabel>
            <ExamCards exams={view.exams} />
          </section>
        )}
      </div>

      <aside className="mt-9 flex min-w-0 flex-col gap-4 @min-[960px]:mt-0 @min-[960px]:pt-0.5" aria-label="This week">
        <div {...part(5)}>
          <WeekCard week={view.week} />
        </div>
      </aside>
    </Arrive>
  );
}

export default function HomePage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={null}>
      <HomeBody searchParams={searchParams} />
    </Suspense>
  );
}
