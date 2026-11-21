/*
 * An invented mock exam for tests and the dev page (M3-60). Not course content: made-up
 * questions on made-up topics, in the same shape as an exam file from a bundle.
 */
import type { Attempt, MockExam, MockExamPaper } from "@/lib/mock-exams/types";

const lec = (page: string, title: string, slides: number[]) => ({ page, title, slides, href: `/courses/c1/lectures/${slides[0] ?? 1}` });

export const sampleExam: MockExam = {
  id: "sample-1",
  course: "SAMPLE101",
  order: 1,
  kind: "teacher",
  title: "Sample exam",
  subtitle: "An invented exam for tests.",
  totalPoints: 24,
  howToAnswer: "Answer briefly. Justify every written answer. Question 1 needs no justification.",
  calculator: true,
  suggestedMinutes: 60,
  answersLabel: "Our answers",
  paperHeader: { left: ["SAMPLE101 Sample course", "Sample School"], right: ["Sample exam", "A Teacher"] },
  questions: [
    {
      number: 1,
      type: "truefalse",
      points: 6,
      prompt: "Determine whether the statement is true or false. (Correct answer 1 p., wrong answer -1 p., no answer 0 p).",
      items: [
        { text: "Apples are fruit.", answer: true, why: "They grow on trees.", lectures: [lec("fruit", "Fruit", [3])] },
        { text: "Carrots are fruit.", answer: false, why: "They are roots.", lectures: [lec("roots", "Roots", [5])] },
        { text: "Tomatoes are fruit.", answer: true, why: "Botanically.", lectures: [lec("fruit", "Fruit", [4])], note: "This key is the least certain." },
        { text: "Potatoes are roots.", answer: false, why: "They are tubers.", lectures: [lec("roots", "Roots", [6])] },
        { text: "Pears are fruit.", answer: true, why: "Like apples.", lectures: [lec("fruit", "Fruit", [3])] },
        { text: "Onions are fruit.", answer: false, why: "Bulbs.", lectures: [{ page: "essentials", title: "Essentials", slides: [] }] },
      ],
    },
    {
      number: 2,
      type: "written",
      points: 6,
      prompt: "Answer briefly to the following:",
      sections: [
        {
          parts: ["(a)", "(b)", "(c)"].map((label) => ({
            label,
            text: `Explain idea ${label}.`,
            points: 2,
            modelAnswer: `Idea ${label} is explained like this.`,
            ticks: [
              { text: "Names the idea", points: 1 },
              { text: "Says why it matters", points: 1 },
            ],
            commonWrong: { answer: "Naming a different idea.", why: "That one is another lecture." },
            lectures: [lec("ideas", "Ideas", [7])],
          })),
        },
      ],
    },
    {
      number: 3,
      type: "written",
      points: 6,
      sections: [
        {
          stem: "A model is given as",
          formula: "y = 2x + 1.",
          parts: [
            { label: "(a)", text: "Predict y for x = 1.", points: 1.5, modelAnswer: "3", ticks: [{ text: "3", points: 1.5 }], commonWrong: { answer: "2", why: "Forgot the 1." }, lectures: [lec("lines", "Lines", [2])] },
            { label: "(b)", text: "Predict y for x = 2.", points: 1.5, modelAnswer: "5", ticks: [{ text: "5", points: 1.5 }], commonWrong: { answer: "4", why: "Forgot the 1." }, lectures: [lec("lines", "Lines", [2])] },
            {
              label: "(c)",
              text: "How sure are you?",
              points: 3,
              modelAnswer: "Quite.",
              ticks: [
                { text: "Says inside the range", points: 2 },
                { text: "Says outside is risky", points: 2 },
              ],
              commonWrong: { answer: "Certain.", why: "There is noise." },
              lectures: [lec("lines", "Lines", [9])],
            },
          ],
        },
      ],
    },
    {
      number: 4,
      type: "written",
      points: 6,
      sections: [
        {
          label: "(a)",
          stem: "Look at the figure.",
          figure: {
            kind: "plot",
            x: { label: "x", min: 0, max: 4, ticks: [0, 2, 4] },
            y: { label: "y", min: 0, max: 4, ticks: [0, 2, 4] },
            points: [
              { series: "A", marker: "dot", data: [[1, 1], [2, 2]] },
              { series: "B", marker: "star", data: [[3, 1]] },
            ],
            legendTitle: "class",
            alt: "Two classes of points.",
          },
          parts: [
            { label: "i.", text: "Is A above B?", points: 1.5, modelAnswer: "Partly.", ticks: [{ text: "Partly", points: 1.5 }], commonWrong: { answer: "Yes", why: "Not all." }, lectures: [lec("plots", "Plots", [1])] },
            { label: "ii.", text: "Why?", points: 1.5, modelAnswer: "Look.", ticks: [{ text: "Looks", points: 1.5 }], commonWrong: { answer: "No", why: "Look." }, lectures: [lec("plots", "Plots", [1])] },
          ],
        },
        {
          label: "(b)",
          stem: "The table:",
          table: { columns: ["Model", "Score"], rows: [["One", "0.5"], ["Two", "0.7"]] },
          parts: ["i.", "ii.", "iii."].map((label) => ({
            label,
            text: `Read the table ${label}`,
            points: 1,
            modelAnswer: "Two.",
            ticks: [{ text: "Two", points: 1 }],
            commonWrong: { answer: "One", why: "Lower." },
            lectures: [lec("tables", "Tables", [8])],
          })),
        },
      ],
    },
  ],
};

/** The same exam as she sees it while sitting it: no keys. */
export const samplePaper: MockExamPaper = {
  ...sampleExam,
  questions: sampleExam.questions.map((q) =>
    q.type === "truefalse"
      ? { number: q.number, type: q.type, points: q.points, prompt: q.prompt, items: q.items.map((i) => ({ text: i.text })) }
      : {
          ...q,
          sections: q.sections.map((s) => ({ ...s, parts: s.parts.map((p) => ({ label: p.label, text: p.text, points: p.points })) })),
        },
  ),
};

export function sampleAttempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: "att-1",
    examId: "sample-1",
    startedAt: "2026-11-21T08:00:00.000Z",
    finishedAt: null,
    secondsUsed: 0,
    tfOrder: [2, 0, 1, 3, 4, 5],
    trueFalse: {},
    texts: {},
    ticks: {},
    edited: false,
    score: null,
    ...over,
  };
}
