/*
 * Mock exams: the paper she may see, and the score. Pure: no database, no imports but types.
 *
 * Scoring rules:
 * - True/false: +1 right, -1 wrong, 0 blank or unanswered, summed, never below 0.
 * - A written part: the sum of the ticked ticks' points, capped at the part's points. A tick
 *   index given twice counts once; one the part does not have is ignored.
 * - A question is the sum of its parts; the total is the sum of the questions.
 * Points may be halves (or any two-decimal value): sums are made in whole hundredths, so
 * 0.5 + 0.5 + 0.5 is 1.5 and never 1.4999.
 */
import {
  partKey,
  type AttemptScore,
  type Figure,
  type GivenTick,
  type MockExam,
  type MockExamPaper,
  type PaperQuestion,
  type PartKey,
  type PartScore,
  type QuestionScore,
  type TrueFalseAnswer,
  type TrueFalseQuestion,
  type WrittenPart,
} from "./types";

const toHundredths = (points: number) => (Number.isFinite(points) ? Math.round(points * 100) : 0);
const fromHundredths = (h: number) => h / 100;

/** Every written part of an exam with its key, in paper order. */
export function partsOf(exam: MockExam): { key: PartKey; question: number; part: WrittenPart }[] {
  const out: { key: PartKey; question: number; part: WrittenPart }[] = [];
  for (const q of exam.questions) {
    if (q.type !== "written") continue;
    q.sections.forEach((section, s) => section.parts.forEach((part, p) => out.push({ key: partKey(q.number, s, p), question: q.number, part })));
  }
  return out;
}

/** The written part with this key, or null. */
export function findPart(exam: MockExam, key: PartKey): WrittenPart | null {
  return partsOf(exam).find((p) => p.key === key)?.part ?? null;
}

/** The true/false question of an exam (the first, should a file ever hold two), or null. */
export function trueFalseOf(exam: MockExam): TrueFalseQuestion | null {
  return exam.questions.find((q): q is TrueFalseQuestion => q.type === "truefalse") ?? null;
}

/** The points of one part for the ticks given. */
export function scorePart(part: WrittenPart, ticks: readonly GivenTick[] | undefined): number {
  const seen = new Set<number>();
  let sum = 0;
  for (const t of ticks ?? []) {
    const i = t?.index;
    if (!Number.isInteger(i) || i < 0 || i >= part.ticks.length || seen.has(i)) continue;
    seen.add(i);
    sum += toHundredths(part.ticks[i].points);
  }
  return fromHundredths(Math.max(0, Math.min(sum, toHundredths(part.points))));
}

/** The true/false question's counts and score. A missing answer is blank. */
export function scoreTrueFalse(question: TrueFalseQuestion, answers: Readonly<Record<string, TrueFalseAnswer>>): { right: number; wrong: number; blank: number; score: number } {
  let right = 0;
  let wrong = 0;
  let blank = 0;
  question.items.forEach((item, i) => {
    const given = Object.prototype.hasOwnProperty.call(answers, String(i)) ? answers[String(i)] : null;
    if (given !== true && given !== false) blank += 1;
    else if (given === item.answer) right += 1;
    else wrong += 1;
  });
  return { right, wrong, blank, score: Math.max(0, right - wrong) };
}

/** The whole score of an attempt, from her stored answers and ticks. */
export function scoreAttempt(
  exam: MockExam,
  given: { trueFalse: Readonly<Record<string, TrueFalseAnswer>>; ticks: Readonly<Record<PartKey, readonly GivenTick[]>> },
): AttemptScore {
  const firstTrueFalse = trueFalseOf(exam);
  const questions: QuestionScore[] = exam.questions.map((q) => {
    if (q.type === "truefalse") {
      // Answers are keyed by item index alone, so only one true/false question can hold them.
      const { score, ...counts } = scoreTrueFalse(q, q === firstTrueFalse ? given.trueFalse : {});
      return { number: q.number, score, max: q.points, trueFalse: counts };
    }
    const parts: PartScore[] = [];
    q.sections.forEach((section, s) =>
      section.parts.forEach((part, p) => {
        const key = partKey(q.number, s, p);
        const ticks = Object.prototype.hasOwnProperty.call(given.ticks, key) ? given.ticks[key] : undefined;
        parts.push({ key, score: scorePart(part, ticks), max: part.points });
      }),
    );
    return { number: q.number, score: fromHundredths(parts.reduce((sum, p) => sum + toHundredths(p.score), 0)), max: q.points, parts };
  });
  return {
    total: fromHundredths(questions.reduce((sum, q) => sum + toHundredths(q.score), 0)),
    max: exam.totalPoints,
    questions,
  };
}

function paperFigure(f: Figure): Figure {
  const axis = (a: Figure["x"]) => ({ label: a.label, min: a.min, max: a.max, ticks: [...a.ticks] });
  return {
    kind: f.kind,
    x: axis(f.x),
    y: axis(f.y),
    ...(f.points ? { points: f.points.map((p) => ({ series: p.series, marker: p.marker, data: p.data.map((d) => [...d]) })) } : {}),
    ...(f.lines ? { lines: f.lines.map((l) => ({ label: l.label, style: l.style, ...(l.dots !== undefined ? { dots: l.dots } : {}), data: l.data.map((d) => [...d]) })) } : {}),
    ...(f.labels ? { labels: f.labels.map((l) => ({ x: l.x, y: l.y, text: l.text })) } : {}),
    ...(f.hline !== undefined ? { hline: f.hline } : {}),
    ...(f.square !== undefined ? { square: f.square } : {}),
    ...(f.legendTitle !== undefined ? { legendTitle: f.legendTitle } : {}),
    alt: f.alt,
    // The figure's `note` is left out too: nothing named `note` is on a paper.
  };
}

/**
 * The paper as she sits it. Built field by field from the fields a paper has, so a key, a model
 * answer, a tick, a usual wrong answer, a lecture link or anything the file holds that the
 * types do not name can never come along. The one `ticks` a paper keeps is an axis's tick
 * marks (numbers) inside a figure.
 */
export function toPaper(exam: MockExam): MockExamPaper {
  const questions: PaperQuestion[] = exam.questions.map((q) => {
    if (q.type === "truefalse") {
      return { number: q.number, type: "truefalse", points: q.points, prompt: q.prompt, items: q.items.map((i) => ({ text: i.text })) };
    }
    return {
      number: q.number,
      type: "written",
      points: q.points,
      ...(q.prompt !== undefined ? { prompt: q.prompt } : {}),
      sections: q.sections.map((s) => ({
        ...(s.label !== undefined ? { label: s.label } : {}),
        ...(s.stem !== undefined ? { stem: s.stem } : {}),
        ...(s.formula !== undefined ? { formula: s.formula } : {}),
        ...(s.figure ? { figure: paperFigure(s.figure) } : {}),
        ...(s.table ? { table: { columns: [...s.table.columns], rows: s.table.rows.map((r) => [...r]) } } : {}),
        parts: s.parts.map((p) => ({ label: p.label, text: p.text, points: p.points })),
      })),
    };
  });
  return {
    id: exam.id,
    course: exam.course,
    order: exam.order,
    kind: exam.kind,
    title: exam.title,
    subtitle: exam.subtitle,
    ...(exam.intro !== undefined ? { intro: exam.intro } : {}),
    ...(exam.source !== undefined ? { source: exam.source } : {}),
    ...(exam.expectedScore ? { expectedScore: { low: exam.expectedScore.low, high: exam.expectedScore.high } } : {}),
    totalPoints: exam.totalPoints,
    howToAnswer: exam.howToAnswer,
    calculator: exam.calculator,
    suggestedMinutes: exam.suggestedMinutes,
    answersLabel: exam.answersLabel,
    paperHeader: { left: [...exam.paperHeader.left], right: [...exam.paperHeader.right] },
    questions,
  };
}
