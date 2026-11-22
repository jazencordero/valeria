/*
 * Mock exams: is this JSON an exam file? Used by the seed tool (before sending) and by the
 * server (before storing). Unknown keys are dropped, so what is stored is exactly the shape in
 * ./types.ts. Problems name the path and the rule, never a value of the file.
 */
import { z } from "zod";
import type { MockExam } from "./types";

/** Text answers and other free text of a file: generous, but bounded. */
const TEXT_MAX = 20_000;
const text = (max = TEXT_MAX) => z.string().max(max);
const filled = (max = TEXT_MAX) => z.string().trim().min(1).max(max);
/** Points: zero or more, at most two decimals (halves are the usual case). */
const points = z
  .number()
  .min(0)
  .max(1000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, { error: "points may have two decimals at most." });
const wholeNumber = z.number().int();

export const MOCK_EXAM_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const LectureRefSchema = z.object({ page: filled(200), title: text(500), slides: z.array(wholeNumber).max(500) });

const AxisSchema = z.object({ label: text(500), min: z.number(), max: z.number(), ticks: z.array(z.number()).max(200) });
const DataSchema = z.array(z.array(z.number()).max(10)).max(5000);
const FigureSchema = z.object({
  kind: z.literal("plot"),
  x: AxisSchema,
  y: AxisSchema,
  points: z.array(z.object({ series: text(500), marker: z.enum(["dot", "star", "triangle"]), data: DataSchema })).max(50).optional(),
  lines: z.array(z.object({ label: text(500), style: text(100), dots: z.boolean().optional(), data: DataSchema })).max(50).optional(),
  labels: z.array(z.object({ x: z.number(), y: z.number(), text: text(500) })).max(200).optional(),
  hline: z.number().optional(),
  square: z.boolean().optional(),
  legendTitle: text(500).optional(),
  alt: text(),
  note: text().optional(),
});

const TableSchema = z.object({
  columns: z.array(text(500)).max(50),
  rows: z.array(z.array(z.union([z.string().max(2000), z.number()])).max(50)).max(500),
});

const PartSchema = z.object({
  label: text(100),
  text: text(),
  points,
  modelAnswer: text(),
  ticks: z.array(z.object({ text: text(), points })).max(50),
  commonWrong: z.object({ answer: text(), why: text() }),
  lectures: z.array(LectureRefSchema).max(50),
});

const SectionSchema = z.object({
  label: text(100).optional(),
  stem: text().optional(),
  formula: text().optional(),
  figure: FigureSchema.optional(),
  table: TableSchema.optional(),
  parts: z.array(PartSchema).min(1).max(50),
});

const TrueFalseSchema = z.object({
  number: wholeNumber.min(1).max(99),
  type: z.literal("truefalse"),
  points,
  prompt: text(),
  items: z
    .array(z.object({ text: filled(), answer: z.boolean(), why: text(), lectures: z.array(LectureRefSchema).max(50), note: text().optional() }))
    .min(1)
    .max(50),
});

const WrittenSchema = z.object({
  number: wholeNumber.min(1).max(99),
  type: z.literal("written"),
  points,
  prompt: text().optional(),
  sections: z.array(SectionSchema).min(1).max(50),
});

export const MockExamSchema = z
  .object({
    id: z.string().regex(MOCK_EXAM_ID, { error: "id must be lower-case letters, digits, - or _ (64 at most)." }),
    course: text(500),
    order: z.number().min(0).max(10_000),
    kind: z.enum(["teacher", "mock", "boss", "drill-math", "drill-figure"]),
    title: filled(500),
    subtitle: text(1000),
    intro: text().optional(),
    source: text().optional(),
    expectedScore: z.object({ low: z.number(), high: z.number() }).optional(),
    totalPoints: points,
    howToAnswer: text(),
    calculator: z.boolean(),
    suggestedMinutes: z.number().min(0).max(24 * 60),
    answersLabel: text(500),
    paperHeader: z.object({ left: z.array(text(500)).max(10), right: z.array(text(500)).max(10) }),
    questions: z.array(z.discriminatedUnion("type", [TrueFalseSchema, WrittenSchema])).min(1).max(50),
  })
  .superRefine((exam, ctx) => {
    const numbers = exam.questions.map((q) => q.number);
    numbers.forEach((n, i) => {
      if (numbers.indexOf(n) !== i) ctx.addIssue({ code: "custom", path: ["questions", i, "number"], message: "this question number is used twice." });
    });
    // The arithmetic of the paper, whatever its size: questions add up to the total, parts to their question.
    const hundredths = (n: number) => Math.round(n * 100);
    if (exam.questions.reduce((sum, q) => sum + hundredths(q.points), 0) !== hundredths(exam.totalPoints)) {
      ctx.addIssue({ code: "custom", path: ["totalPoints"], message: "the questions' points do not add up to totalPoints." });
    }
    exam.questions.forEach((q, i) => {
      if (q.type !== "written") return;
      const parts = q.sections.reduce((sum, s) => sum + s.parts.reduce((inner, p) => inner + hundredths(p.points), 0), 0);
      if (parts !== hundredths(q.points)) ctx.addIssue({ code: "custom", path: ["questions", i, "points"], message: "the parts' points do not add up to the question's points." });
    });
    // Her true/false answers are kept by item index alone, so a file may hold one such question.
    exam.questions.forEach((q, i) => {
      if (q.type === "truefalse" && exam.questions.findIndex((o) => o.type === "truefalse") !== i) {
        ctx.addIssue({ code: "custom", path: ["questions", i, "type"], message: "only one true/false question is supported." });
      }
    });
  });

export type MockExamCheck = { ok: true; exam: MockExam } | { ok: false; problems: string[] };

/** Checks one exam file's JSON. The problems name paths and rules only. */
export function checkMockExam(raw: unknown): MockExamCheck {
  const parsed = MockExamSchema.safeParse(raw);
  if (parsed.success) return { ok: true, exam: parsed.data satisfies MockExam };
  return {
    ok: false,
    problems: parsed.error.issues.slice(0, 20).map((i) => {
      const at = i.path.map(String).join(".");
      return `${at ? `${at}: ` : ""}${i.message.replace(/"[^"]*"/g, '"…"')}`;
    }),
  };
}
