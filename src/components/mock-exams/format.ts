/*
 * Mock exams (M3-60): small pure helpers the screens share.
 *
 * - Numbers print as the teacher writes them: halves as 1.5, a real minus sign (−1).
 * - Points next to a part read like his paper, "(2p)" / "(1.5p)"; elsewhere "2 points".
 * - True/false items are lettered (a) to (f) in the order shown this attempt, as on his paper.
 * - The live scores here only move the numbers while she ticks; the stored score is always the
 *   server's (`Attempt.score`), which replaces these as soon as it comes back.
 */
import type {
  Attempt,
  GivenTick,
  MockExam,
  MockQuestion,
  PaperQuestion,
  PartKey,
  WrittenPart,
} from "@/lib/mock-exams/types";
import { partKey } from "@/lib/mock-exams/types";

export const MINUS = "−";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function num(n: number): string {
  const v = r2(n);
  return (v < 0 ? MINUS : "") + String(Math.abs(v));
}

export function points(n: number): string {
  return `${num(n)} ${r2(n) === 1 ? "point" : "points"}`;
}

/** The teacher's form: "(2p)", "(1.5p)". */
export function paperPoints(n: number): string {
  return `(${num(n)}p)`;
}

export function signed(n: number): string {
  return n > 0 ? `+${num(n)}` : n < 0 ? num(n) : "0";
}

/** "(a)" for the first item shown, "(b)" for the second ... */
export function itemLetter(i: number): string {
  return `(${String.fromCharCode(97 + i)})`;
}

/** "Mon 23 Nov" in Helsinki. */
export function shortDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "Europe/Helsinki",
    });
  } catch {
    return "";
  }
}

/** "42 min" from seconds; under a minute is "under a minute". */
export function minutesUsed(seconds: number): string {
  if (seconds < 60) return "under a minute";
  return `${Math.round(seconds / 60)} min`;
}

/** "12:05" from milliseconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type PartRef<P> = {
  key: PartKey;
  question: number;
  section: number;
  index: number;
  /** "2(a)", "4(b) ii." */
  label: string;
  part: P;
};

/** Every written part of an exam (paper or whole), in paper order. */
export function partsOf<Q extends MockQuestion | PaperQuestion>(
  questions: Q[],
): PartRef<Q extends MockQuestion ? WrittenPart : { label: string; text: string; points: number }>[] {
  const out: PartRef<never>[] = [];
  for (const q of questions) {
    if (q.type !== "written") continue;
    q.sections.forEach((sec, si) => {
      sec.parts.forEach((p, pi) => {
        out.push({
          key: partKey(q.number, si, pi),
          question: q.number,
          section: si,
          index: pi,
          label: `${q.number}${sec.label ? `${sec.label} ${p.label}` : p.label}`,
          part: p as never,
        });
      });
    });
  }
  return out as never;
}

/** A part's points from the ticks given: the sum, capped at the part's points. */
export function partScore(part: { points: number; ticks: { points: number }[] }, given: GivenTick[] | undefined): number {
  let sum = 0;
  for (const g of given ?? []) {
    const t = part.ticks[g.index];
    if (t) sum += t.points;
  }
  return Math.min(part.points, r2(sum));
}

/** Question 1: +1 right, −1 wrong, 0 blank, never below 0. */
export function trueFalseScore(exam: MockExam, attempt: Pick<Attempt, "trueFalse">) {
  const q = exam.questions.find((x) => x.type === "truefalse");
  let right = 0;
  let wrong = 0;
  let blank = 0;
  if (q && q.type === "truefalse") {
    q.items.forEach((it, i) => {
      const a = attempt.trueFalse[String(i)];
      if (a === null || a === undefined) blank++;
      else if (a === it.answer) right++;
      else wrong++;
    });
  }
  return { right, wrong, blank, score: Math.max(0, right - wrong) };
}

/** The score of every question and the total, from the answers and ticks in hand. */
export function liveScore(exam: MockExam, attempt: Pick<Attempt, "trueFalse" | "ticks">) {
  const parts = partsOf(exam.questions);
  const questions = exam.questions.map((q) => {
    if (q.type === "truefalse") return { number: q.number, score: trueFalseScore(exam, attempt).score, max: q.points };
    const score = r2(
      parts
        .filter((p) => p.question === q.number)
        .reduce((a, p) => a + partScore(p.part, attempt.ticks[p.key]), 0),
    );
    return { number: q.number, score, max: q.points };
  });
  return { total: r2(questions.reduce((a, q) => a + q.score, 0)), max: exam.totalPoints, questions };
}

/** "Clustering and classification, slides 19, 20"; just the title when there are no slides. */
export function slidesText(l: { title: string; slides: number[] }): string {
  if (!l.slides.length) return l.title;
  return `${l.title}, ${l.slides.length === 1 ? "slide" : "slides"} ${l.slides.join(", ")}`;
}
