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
 * M7-04 puts Never miss one in the rail.
 *
 * M4-11: `/home?arrive=1` (the first visit after connecting) plays the build
 * once: `Arrive` (a client component) is the grid, and each section carries
 * `data-arrive-part` and its place in the order. Any other visit, and the
 * test switch (?fast=1 or the READY_FAST cookie), renders the same markup at
 * rest. Source: prototype main-flow.html JS 4042-4076.
 *
 * M4-12: when the hand-in flash is there (she handed in a moment ago and came
 * back by a link, not a reload), Home first shows the before state and then
 * rearranges itself, once (`src/components/home/handed-in.tsx`, prototype
 * main-flow.html JS 4125-4160). The page sends the after state as always,
 * plus the handed-in card as it stood in DO FIRST and the next item as the
 * list row it was; `HandedIn` and its parts decide what shows when. Without
 * the flash those parts render the plain markup. Never together with the
 * M4-11 build, and not under the test switch. A hand-in with no due time has
 * no card to show, so it just appears.
 *
 * M6-09: in the rail, under THIS WEEK, the grades card
 * (`src/components/home/grades-card.tsx`): one row per visible course from
 * `getHomeView`'s `grades` (the Grades tab's rows), each linking to
 * `/grades/<courseId>`. No card when she has no courses. It rises in after
 * the week card in the M4-11 build.
 *
 * M7-04: under the grades card (under the week card when there is none), M7-03's
 * Never miss one card (`src/components/home/never-miss.tsx`) with `getHomeView`'s
 * `neverMiss`: how many dates the link lists and what is on (then the done row
 * shows instead). "Turn on" calls `turnOnNeverMiss` (`./never-miss-actions.ts`),
 * which makes the link, saves the choice and answers with the calendar app's
 * subscribe page; the card opens it in a new tab and cross-fades to the done row.
 * Reminders are "none" on Home for now (see the actions file). "Not now" hides
 * the card for 30 days: the card keeps it in localStorage, and `dismissNeverMiss`
 * saves it too, so after a reload the page leaves the card out (no flash).
 *
 * M9-19: under the exam cards, "pick up where you left off"
 * (`src/components/home/pickup.tsx`) with `getHomeView`'s `pickup`: one
 * lecture and Continue, which opens its page. With no exams the row stands
 * alone in the same place, without the EXAMS AND QUIZZES label; with nothing
 * unread anywhere there is no row.
 *
 * M5-15: an account without a login (not a demo) gets one quiet line under the greeting, "Set a
 * username and password so you can get back in.", linking to Settings' "Log in" section. "Not
 * now" hides it on this device; `LoginNudge` (src/components/settings/login-section.tsx) keeps
 * that in localStorage and renders nothing until it has read it, so it never flashes.
 *
 * Cut: the week markers' pulse after turning on. `WeekCard` exposes `pulse()`
 * through a ref, which needs a client component holding both cards; none of this
 * ticket's files can be one.
 */
import { FAB_CLEAR, FAB_CLEAR_WIDE } from "@/components/notes/fab";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";
import { DoodleDefs } from "@/components/doodle";
import { CONCEPT_ICON_NAMES, ConceptIcon, iconFor, type ConceptIconName } from "@/components/exams/concept-icons";
import { Arrive } from "@/components/home/arrive";
import { BiteRow, HomeExamCard } from "@/components/home/bite-row";
import {
  AfterOnly,
  BeforeOnly,
  HandedIn,
  HandedInGreeting,
  QueueNumber,
  Slide,
  Swap,
} from "@/components/home/handed-in";
import { GradesCard } from "@/components/home/grades-card";
import { NeverMiss } from "@/components/home/never-miss";
import { Pickup } from "@/components/home/pickup";
import { LoginNudge } from "@/components/settings/login-section";
import { HeroCard } from "@/components/home/hero-card";
import { Queue, QueueRow } from "@/components/home/queue-row";
import { WeekCard } from "@/components/home/week-card";
import { Button } from "@/components/ui/button";
import { DoneRow } from "@/components/ui/done-row";
import { StickyHeader } from "@/components/ui/sticky-header";
import { ThemeButton } from "@/components/ui/theme-button";
import { lmsNameOf, schoolOf } from "@/lib/schools";
import { dateLine, earlyBy, listDate, sameDay } from "@/lib/dates";
import { FAST_COOKIE, FAST_PARAM } from "@/lib/motion/fast";
import { landingFor } from "@/server/auth/accounts";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { readFlash } from "@/server/data/flash";
import { isDemo } from "@/server/demo/seed";
import { getHomeView, type HomeBite, type HomeDone, type HomeExam, type HomeFirst } from "@/server/data/home";
import { syncNow } from "@/server/sync/run";
import { dismissNeverMiss, turnOnNeverMiss } from "./never-miss-actions";

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

/**
 * A queue number that rolls after a hand-in. `QueueRow` types its `position` as a
 * number and renders it as given; the rolling number is an element, hence the cast.
 */
const rolling = (n: number) => (<QueueNumber n={n} />) as unknown as number;

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
            starts={e.starts}
          />
        </li>
      ))}
    </ul>
  );
}

// The bottom room keeps the last row's Start clear of the notes button (FAB_CLEAR).
const GRID =
  `mx-auto grid max-w-[720px] grid-cols-[minmax(0,1fr)] gap-x-10 px-[var(--pad)] ${FAB_CLEAR} ` +
  `pt-[max(16px,env(safe-area-inset-top,0px))] min-[700px]:px-10 min-[700px]:pt-8 ${FAB_CLEAR_WIDE} ` +
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
  // An account seeded from files (M3-57) has courses but no connection yet: it stays on Home.
  // An account with a username (M5-14) is not sent to /connect for having no connection
  // either: it follows the log in rule (`landingFor`), Home unless it never began the first run.
  const seeded = Boolean((user.settings as { seededFrom?: unknown } | null)?.seededFrom);
  if (!view.connection && !seeded) {
    if (!user.username) redirect("/connect");
    if ((await landingFor(db, user.id)) === "/school") redirect("/school");
  }
  // The hand-in she has just made, when Home should rearrange itself for it (M4-12).
  const handed = flash?.kind === "handedIn" && !fast && !arrive && view.lastDone?.dueAt ? view.lastDone : null;
  const handedDue = handed?.dueAt ?? null;

  return (
    <Arrive play={arrive} className={GRID}>
     <HandedIn play={handed !== null} id={handed ? `${handed.id}:${handed.submittedAt.getTime()}` : undefined}>
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

        {view.connection?.status === "expired" && (
          <Link
            href="/connect"
            className="mt-4 block rounded-[14px] bg-butter px-4 py-3 text-[15px] font-medium text-ink"
          >
            {lms} signed you out. <span className="underline underline-offset-4">Reconnect.</span>
          </Link>
        )}

        <div {...part(1)}>
          <HandedInGreeting sentence={view.greeting} />
        </div>

        {!user.username && !isDemo(user) && <LoginNudge className="mt-2" />}

        <DoodleDefs />

        <Slide as="section" {...part(2)} className="mt-8" aria-labelledby="lbl-first">
          <SectionLabel id="lbl-first">DO FIRST</SectionLabel>
          {handed && handedDue ? (
            <>
              <Swap
                before={
                  <HeroCard
                    title={handed.title}
                    course={handed.course}
                    code=""
                    dueAt={handedDue}
                    now={now}
                    tone={handedDue.getTime() - now.getTime() < URGENT_MS ? "urgent" : "soon"}
                    href={`/assignments/${handed.id}`}
                  />
                }
                done={<DoFirst first={null} lastDone={handed} now={now} />}
              >
                {view.biteFirst && view.bite ? (
                  <BiteFor bite={view.bite} first className="mt-3" />
                ) : view.first ? (
                  <div className="mt-3">
                    <DoFirst first={view.first} lastDone={null} now={now} />
                  </div>
                ) : null}
              </Swap>
              {view.bite &&
                (view.biteFirst ? (
                  // Before the hand-in the bite was the row under the card.
                  <BeforeOnly>
                    <BiteFor bite={view.bite} className="mt-3" />
                  </BeforeOnly>
                ) : (
                  <Slide className="mt-3">
                    <BiteFor bite={view.bite} />
                  </Slide>
                ))}
            </>
          ) : view.biteFirst && view.bite ? (
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
        </Slide>

        <Slide as="section" {...part(3)} className="mt-8 flex flex-col" aria-labelledby="lbl-then">
          <SectionLabel id="lbl-then">THEN</SectionLabel>
          {handed && view.first && (
            // Before the hand-in, what is now DO FIRST was the first row here.
            <BeforeOnly>
              <Queue className={view.then.length > 0 ? "-mx-2 border-b border-solid border-line px-2" : undefined}>
                <QueueRow
                  position={2}
                  title={view.first.title}
                  course={view.first.course}
                  dueAt={view.first.dueAt}
                  now={now}
                  estimateMin={view.first.estimateMin}
                  status={view.first.status}
                  action={
                    <Button size="sm" href={view.first.href}>
                      Start
                    </Button>
                  }
                />
              </Queue>
            </BeforeOnly>
          )}
          <Slide className="flex flex-col">
          {view.then.length > 0 ? (
            <Queue>
              {view.then.map((a, i) => (
                <QueueRow
                  key={a.id}
                  position={rolling(i + 2)}
                  title={a.title}
                  course={a.course}
                  dueAt={a.dueAt}
                  now={now}
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
            <AfterOnly>
              <p className="py-3 text-[15px] text-ink-2">Nothing else is open.</p>
            </AfterOnly>
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
          </Slide>
        </Slide>

        {view.exams.length > 0 ? (
          <Slide as="section" {...part(4)} className="mt-8" aria-labelledby="lbl-exams">
            <SectionLabel id="lbl-exams">EXAMS AND QUIZZES</SectionLabel>
            <ExamCards exams={view.exams} />
            {view.pickup && <Pickup {...view.pickup} className="mt-3.5" />}
          </Slide>
        ) : (
          view.pickup && (
            <Slide as="section" {...part(4)} className="mt-8" aria-label="Pick up where you left off">
              <Pickup {...view.pickup} />
            </Slide>
          )
        )}
      </div>

      <aside className="mt-9 flex min-w-0 flex-col gap-4 @min-[960px]:mt-0 @min-[960px]:pt-0.5" aria-label="This week">
        <Slide {...part(5)}>
          <WeekCard week={view.week} />
        </Slide>
        {view.grades.length > 0 && (
          <Slide {...part(6)}>
            <GradesCard courses={view.grades} lmsName={lms} />
          </Slide>
        )}
        {(view.neverMiss.on || !view.neverMiss.dismissed) && (
          <Slide {...part(7)}>
            <NeverMiss
              dateCount={view.neverMiss.dateCount}
              on={view.neverMiss.on}
              reminders="none"
              schoolName={schoolOf(user).name}
              onTurnOn={turnOnNeverMiss}
              onDismiss={dismissNeverMiss}
            />
          </Slide>
        )}
      </aside>
     </HandedIn>
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
