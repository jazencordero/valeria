"use client";

/**
 * The bite row on Home (M3-44), under the DO FIRST card. Source: prototype
 * main-flow.html JS 2897-2902 (homeBiteHTML), HTML 1459 (#btn-home-bite) and
 * CSS 1161-1166 (.home-bite, .hb-pic, .hb-txt, .hb-t, .hb-m, .hb-go); .p-blush
 * is the accent wash, .p-mint the mint.
 *
 * - "bite": the bite doodle, "Or a 5-minute bite for Friday's exam",
 *   "8 CARDS · +4% FORECAST" and "Start". The whole row links to the session.
 *   `first` (nothing is open, so the bite is the DO FIRST card) drops the
 *   "Or": "A 5-minute bite for Friday's exam".
 * - "done": the cup doodle, "Today's bites are done", "FORECAST 68% · FRIDAY"
 *   and "Open", linking to the exam.
 *
 * Plain data in: Home works out the exam, the words for its day and the
 * numbers. The page must render <DoodleDefs /> once.
 *
 * `HomeExamCard` is M3-22's exam card with its two buttons wired to links,
 * so a server page can show it: the title opens the exam, the bite button
 * starts today's bite (or opens the exam when there is none).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Doodle } from "@/components/doodle";
import { ExamCard, type ExamCardProps } from "@/components/exams/exam-card";

export type BiteRowProps =
  | {
      state: "bite";
      minutes: number;
      cards: number;
      /** Forecast gain in percentage points. */
      gain: number;
      /** "Friday's exam", "tomorrow's quiz", "the exam on 4 Dec". */
      forWhat: string;
      /** The session: `/study/new?exam=<id>&kind=bite`. */
      href: string;
      /** The bite is the DO FIRST card: no "Or". */
      first?: boolean;
      className?: string;
    }
  | {
      state: "done";
      /** Forecast shown today, a whole percent. */
      forecast: number;
      /** "FRIDAY". */
      day: string;
      /** The exam page. */
      href: string;
      className?: string;
    };

const ROW =
  "grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-[20px] border border-solid " +
  "border-line bg-surface py-2.5 pl-2.5 pr-3.5 text-left text-ink no-underline " +
  "transition-[transform,box-shadow] duration-quick ease-out " +
  "hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] motion-reduce:hover:translate-y-0";

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4 flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5]"
    >
      <path d="M9.5 5.5L16 12l-6.5 6.5" />
    </svg>
  );
}

export function biteTitle(minutes: number, forWhat: string, first = false): string {
  return `${first ? "A" : "Or a"} ${minutes}-minute bite for ${forWhat}`;
}

export function BiteRow(props: BiteRowProps) {
  const done = props.state === "done";
  const title = done ? "Today’s bites are done" : biteTitle(props.minutes, props.forWhat, props.first);
  const meta = done
    ? `FORECAST ${props.forecast}% · ${props.day}`
    : `${props.cards} CARDS · +${props.gain}% FORECAST`;

  return (
    <Link href={props.href} className={props.className ? `${ROW} ${props.className}` : ROW} data-state={props.state}>
      <span className={"grid h-[52px] w-16 place-items-center rounded-[14px] " + (done ? "bg-mint" : "bg-accent-wash")}>
        <Doodle name={done ? "cup" : "bite"} size={52} />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="mono text-[11px] text-ink-3">{meta}</span>
      </span>
      <span className="inline-flex items-center gap-0.5 text-[13px] font-semibold">
        {done ? "Open" : "Start"}
        {!done && <Chevron />}
      </span>
    </Link>
  );
}

export type HomeExamCardProps = Omit<ExamCardProps, "onOpenExam" | "onSession"> & {
  /** `/exams/<id>`. */
  href: string;
  /** Today's bite, `/study/new?exam=<id>&kind=bite`; used while `biteMinutes` is set. */
  biteHref: string;
};

export function HomeExamCard({ href, biteHref, ...card }: HomeExamCardProps) {
  const router = useRouter();
  return (
    <ExamCard
      {...card}
      onOpenExam={() => router.push(href)}
      onSession={() => router.push(card.biteMinutes != null ? biteHref : href)}
    />
  );
}
