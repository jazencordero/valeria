/*
 * Mock exams: the shapes shared by the server (src/server/mock-exams) and the screens.
 *
 * Two views of an exam:
 *   MockExam        the whole file from her bundle, keys and model answers included. Server only
 *                   until an attempt is finished.
 *   MockExamPaper   what she may see while sitting it: the same paper with every key, model
 *                   answer, tick, usual wrong answer and lecture link removed.
 *
 * Keys used in an attempt:
 *   a true/false item   its index in the set's true/false question, from 0 (`tfOrder` is the order shown this attempt)
 *   a written part      PartKey "<question number>.<section index>.<part index>", e.g. "2.0.1"
 *   a tick              its index in the part's `ticks`
 */

/**
 * "teacher", "mock" and "boss" are full exams; "drill-math" and "drill-figure" are shorter sets of
 * written problems only (no true/false question, and a total that need not be a full exam's).
 */
export type MockExamKind = "teacher" | "mock" | "boss" | "drill-math" | "drill-figure";

export type LectureRef = {
  page: string;
  title: string;
  slides: number[];
  /**
   * Where her lecture page for `page` is, e.g. "/courses/<id>/lectures/<n>". Filled by the
   * server in finished views only, never stored; left out when the slug has no lecture page.
   */
  href?: string;
};

export type FigureAxis = { label: string; min: number; max: number; ticks: number[] };
export type Figure = {
  kind: "plot";
  x: FigureAxis;
  y: FigureAxis;
  points?: { series: string; marker: "dot" | "star" | "triangle"; data: number[][] }[];
  lines?: { label: string; style: string; dots?: boolean; data: number[][] }[];
  labels?: { x: number; y: number; text: string }[];
  hline?: number;
  square?: boolean;
  legendTitle?: string;
  alt: string;
  note?: string;
};

export type ExamTable = { columns: string[]; rows: (string | number)[][] };

export type Tick = { text: string; points: number };

export type TrueFalseItem = {
  text: string;
  answer: boolean;
  why: string;
  lectures: LectureRef[];
  /** Shown in marking (a key that is less certain). */
  note?: string;
};

export type WrittenPart = {
  label: string;
  text: string;
  points: number;
  modelAnswer: string;
  ticks: Tick[];
  commonWrong: { answer: string; why: string };
  lectures: LectureRef[];
};

export type WrittenSection = {
  label?: string;
  stem?: string;
  formula?: string;
  figure?: Figure;
  table?: ExamTable;
  parts: WrittenPart[];
};

export type TrueFalseQuestion = { number: number; type: "truefalse"; points: number; prompt: string; items: TrueFalseItem[] };
export type WrittenQuestion = { number: number; type: "written"; points: number; prompt?: string; sections: WrittenSection[] };
export type MockQuestion = TrueFalseQuestion | WrittenQuestion;

type ExamHead = {
  /** The exam's id in her bundle, e.g. "mock-1": stable across uploads. */
  id: string;
  course: string;
  order: number;
  kind: MockExamKind;
  title: string;
  subtitle: string;
  intro?: string;
  source?: string;
  expectedScore?: { low: number; high: number };
  totalPoints: number;
  howToAnswer: string;
  calculator: boolean;
  suggestedMinutes: number;
  answersLabel: string;
  paperHeader: { left: string[]; right: string[] };
};

/** The whole exam, keys included. Never sent to the browser before an attempt is finished. */
export type MockExam = ExamHead & { questions: MockQuestion[] };

/** The paper as she sits it: no keys. */
export type PaperTrueFalseQuestion = Omit<TrueFalseQuestion, "items"> & { items: { text: string }[] };
export type PaperPart = Pick<WrittenPart, "label" | "text" | "points">;
export type PaperSection = Omit<WrittenSection, "parts"> & { parts: PaperPart[] };
export type PaperWrittenQuestion = Omit<WrittenQuestion, "sections"> & { sections: PaperSection[] };
export type PaperQuestion = PaperTrueFalseQuestion | PaperWrittenQuestion;
export type MockExamPaper = ExamHead & { questions: PaperQuestion[] };

/** "<question number>.<section index>.<part index>". */
export type PartKey = string;
export const partKey = (question: number, section: number, part: number): PartKey => `${question}.${section}.${part}`;

/** Her answer to one true/false item: true, false, or null for "Leave blank" (also: not answered yet). */
export type TrueFalseAnswer = boolean | null;

/** One tick she (or "Check my answer") gave on a part. */
export type GivenTick = { index: number; fromCheck: boolean };

export type PartScore = { key: PartKey; score: number; max: number };
export type QuestionScore = {
  number: number;
  score: number;
  max: number;
  /** A true/false question only. */
  trueFalse?: { right: number; wrong: number; blank: number };
  /** Written questions only. */
  parts?: PartScore[];
};
export type AttemptScore = { total: number; max: number; questions: QuestionScore[] };

export type Attempt = {
  id: string;
  /** The exam's bundle id. */
  examId: string;
  /**
   * The set's kind and total as they are now (from the set, not stored with the attempt). The
   * server always fills both; optional only so that hand-made attempts (samples, tests) still fit.
   */
  kind?: MockExamKind;
  totalPoints?: number;
  startedAt: string;
  /** Null while she is sitting it. */
  finishedAt: string | null;
  /** Seconds on the timer, as the screen last reported them. */
  secondsUsed: number;
  /**
   * True/false item indexes in the order shown in this attempt: each item of the set as it is
   * now exactly once (empty for a set with no true/false question).
   */
  tfOrder: number[];
  /** Keyed by item index (as a string); a missing key is unanswered, the same as blank. */
  trueFalse: Record<string, TrueFalseAnswer>;
  texts: Record<PartKey, string>;
  ticks: Record<PartKey, GivenTick[]>;
  /** True once she changed her ticks after finishing. */
  edited: boolean;
  /** Null until finished. Computed on the server from the stored answers and ticks. */
  score: AttemptScore | null;
};

/** One line of history: a finished attempt. */
export type AttemptSummary = {
  id: string;
  examId: string;
  examTitle: string;
  /** The set's kind and total as they are now. The server always fills these three (optional as on `Attempt`). */
  kind?: MockExamKind;
  totalPoints?: number;
  /** score.total of score.max, in percent with one decimal (0 when max is 0): comparable across kinds. */
  percent?: number;
  startedAt: string;
  finishedAt: string;
  secondsUsed: number;
  edited: boolean;
  score: AttemptScore;
};

export type MockExamStatus = "new" | "open" | "done";

/** One row of the list. */
export type MockExamListing = {
  id: string;
  order: number;
  kind: MockExamKind;
  title: string;
  subtitle: string;
  totalPoints: number;
  suggestedMinutes: number;
  expectedScore?: { low: number; high: number };
  /** "open" when an unfinished attempt exists (even after finished ones); "done" when only finished ones. */
  status: MockExamStatus;
  /** Totals of finished attempts; null when there is none. */
  best: number | null;
  latest: number | null;
  /** Finished attempts. */
  attempts: number;
  openAttemptId: string | null;
};

/** The start screen. */
export type MockExamStart = {
  exam: MockExamPaper;
  listing: MockExamListing;
  /** True when "Check my answer" may be offered for this course. */
  checkAllowed: boolean;
};

/** An attempt with the exam as she may see it: the paper while open, the whole exam once finished. */
export type AttemptView =
  | { finished: false; attempt: Attempt; exam: MockExamPaper; checkAllowed: boolean }
  | { finished: true; attempt: Attempt; exam: MockExam; checkAllowed: boolean };

export type AnswerInput =
  | { kind: "trueFalse"; item: number; answer: TrueFalseAnswer }
  | { kind: "text"; part: PartKey; text: string };

export type TickSuggestion =
  | { status: "ok"; part: PartKey; ticks: number[]; /** Two short lines on what was missing. */ missing: string[] }
  | { status: "unavailable" };
