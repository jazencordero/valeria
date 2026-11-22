/*
 * An invented mock exam (baking) for tests: the shape of a real one, none of its content.
 * 24 points: one true/false question of six items and three written questions.
 */
import type { MockExam } from "./types";

const oven = { page: "oven-basics", title: "Oven basics", slides: [3, 4] };
const dough = { page: "dough", title: "Dough", slides: [7] };
/** A page that is no lecture (her essentials sheet): it gets no link. */
const essentials = { page: "baking-essentials", title: "Baking essentials", slides: [] };

export function sampleExam(over: Partial<MockExam> = {}): MockExam {
  return {
    id: "bake-1",
    course: "Baking for Beginners",
    order: 2,
    kind: "mock",
    title: "Mock bake 1",
    subtitle: "Bread and cakes",
    intro: "A first try at the whole paper.",
    totalPoints: 24,
    howToAnswer: "Answer every question. Show how you got there.",
    calculator: true,
    suggestedMinutes: 90,
    answersLabel: "Model loaf",
    paperHeader: { left: ["Baking for Beginners", "School of Ovens"], right: ["Mock bake 1", "Autumn"] },
    questions: [
      {
        number: 1,
        type: "truefalse",
        points: 6,
        prompt: "True or false? A wrong answer takes a point away.",
        items: [
          { text: "Yeast makes dough rise.", answer: true, why: "KEY-WHY yeast gives off gas.", lectures: [dough] },
          { text: "Salt speeds yeast up.", answer: false, why: "KEY-WHY salt slows it.", lectures: [dough] },
          { text: "A hot oven sets the crust.", answer: true, why: "KEY-WHY the outside dries first.", lectures: [oven] },
          { text: "Steam helps the loaf spring.", answer: true, why: "KEY-WHY the crust stays soft longer.", lectures: [oven] },
          { text: "Sugar is needed for every bread.", answer: false, why: "KEY-WHY flour has enough.", lectures: [essentials] },
          { text: "Cold butter gives a flat cake.", answer: false, why: "KEY-WHY it depends.", lectures: [], note: "KEY-NOTE the least certain one." },
        ],
      },
      {
        number: 2,
        type: "written",
        points: 6,
        prompt: "About bread.",
        sections: [
          {
            label: "(a)",
            stem: "A baker mixes 500 g flour with 350 g water.",
            formula: "hydration = water / flour",
            parts: [
              {
                label: "i.",
                text: "What is the hydration?",
                points: 2,
                modelAnswer: "KEY-MODEL 70 percent.",
                ticks: [
                  { text: "KEY-TICK divides water by flour", points: 1 },
                  { text: "KEY-TICK gets 0.7", points: 0.5 },
                  { text: "KEY-TICK says percent", points: 0.5 },
                ],
                commonWrong: { answer: "KEY-WRONG 143 percent", why: "KEY-WRONG-WHY divided the other way." },
                lectures: [dough],
              },
              {
                label: "ii.",
                text: "Is that a wet dough?",
                points: 1.5,
                modelAnswer: "KEY-MODEL fairly wet.",
                ticks: [
                  { text: "KEY-TICK yes", points: 0.5 },
                  { text: "KEY-TICK compares with 60", points: 0.5 },
                  { text: "KEY-TICK names the effect", points: 0.5 },
                ],
                commonWrong: { answer: "KEY-WRONG dry", why: "KEY-WRONG-WHY mixed the two up." },
                lectures: [dough, essentials],
              },
            ],
          },
          {
            label: "(b)",
            stem: "The figure shows the loaf's height while it bakes.",
            figure: {
              kind: "plot",
              x: { label: "Minutes", min: 0, max: 40, ticks: [0, 10, 20, 30, 40] },
              y: { label: "Height (cm)", min: 0, max: 12, ticks: [0, 4, 8, 12] },
              lines: [{ label: "Loaf", style: "solid", dots: true, data: [[0, 5], [10, 9], [20, 11], [40, 11]] }],
              points: [{ series: "Checks", marker: "star", data: [[10, 9]] }],
              labels: [{ x: 10, y: 9, text: "spring" }],
              hline: 11,
              alt: "A line that rises fast and then stays flat.",
              note: "KEY-NOTE redrawn by hand.",
            },
            table: { columns: ["Minute", "Height"], rows: [[0, 5], [10, 9], ["end", 11]] },
            parts: [
              {
                label: "i.",
                text: "When does the loaf stop rising?",
                points: 2.5,
                modelAnswer: "KEY-MODEL after about 20 minutes.",
                ticks: [
                  { text: "KEY-TICK reads the figure", points: 1 },
                  { text: "KEY-TICK says 20", points: 1 },
                  { text: "KEY-TICK says why", points: 1 },
                ],
                commonWrong: { answer: "KEY-WRONG 40", why: "KEY-WRONG-WHY read the end of the axis." },
                lectures: [oven],
              },
            ],
          },
        ],
      },
      {
        number: 3,
        type: "written",
        points: 6,
        sections: [
          {
            parts: [
              {
                label: "(a)",
                text: "Why rest a dough?",
                points: 3,
                modelAnswer: "KEY-MODEL the gluten relaxes.",
                ticks: [
                  { text: "KEY-TICK gluten", points: 1.5 },
                  { text: "KEY-TICK easier to shape", points: 1.5 },
                ],
                commonWrong: { answer: "KEY-WRONG to cool it", why: "KEY-WRONG-WHY not the point." },
                lectures: [dough],
              },
              {
                label: "(b)",
                text: "Why score the top?",
                points: 3,
                modelAnswer: "KEY-MODEL it opens where you choose.",
                ticks: [
                  { text: "KEY-TICK controls the tear", points: 2 },
                  { text: "KEY-TICK lets steam out", points: 1 },
                ],
                commonWrong: { answer: "KEY-WRONG for looks only", why: "KEY-WRONG-WHY half the story." },
                lectures: [oven],
              },
            ],
          },
        ],
      },
      {
        number: 4,
        type: "written",
        points: 6,
        prompt: "About cakes.",
        sections: [
          {
            parts: [
              {
                label: "(a)",
                text: "Plan a sponge for eight people.",
                points: 6,
                modelAnswer: "KEY-MODEL four eggs, equal weights.",
                ticks: [
                  { text: "KEY-TICK scales the eggs", points: 2 },
                  { text: "KEY-TICK equal weights", points: 2 },
                  { text: "KEY-TICK tin size", points: 1 },
                  { text: "KEY-TICK oven heat", points: 1 },
                ],
                commonWrong: { answer: "KEY-WRONG doubles everything", why: "KEY-WRONG-WHY the tin does not double." },
                lectures: [oven, dough],
              },
            ],
          },
        ],
      },
    ],
    ...over,
  };
}

/**
 * An invented drill set (baking again): three written problems, 18 points, no true/false
 * question. The shape of a "figures and tables" set, none of a real one's content.
 */
export function sampleDrill(over: Partial<MockExam> = {}): MockExam {
  const problem = (number: number, label: string) => ({
    number,
    type: "written" as const,
    points: 6,
    sections: [
      {
        stem: `Tray ${label} was baked at three heats.`,
        figure: {
          kind: "plot" as const,
          x: { label: "Heat", min: 150, max: 250, ticks: [150, 200, 250] },
          y: { label: "Minutes", min: 0, max: 60, ticks: [0, 30, 60] },
          points: [{ series: `Tray ${label}`, marker: "dot" as const, data: [[150, 50], [200, 35], [250, 20]] }],
          alt: "Three dots that fall from left to right.",
        },
        table: { columns: ["Heat", "Minutes"], rows: [[150, 50], [200, 35], [250, 20]] },
        parts: [
          {
            label: "(a)",
            text: `What does the figure say about tray ${label}?`,
            points: 2.5,
            modelAnswer: "KEY-MODEL hotter is faster.",
            ticks: [
              { text: "KEY-TICK reads the trend", points: 1.5 },
              { text: "KEY-TICK names the axis", points: 1 },
            ],
            commonWrong: { answer: "KEY-WRONG hotter is slower", why: "KEY-WRONG-WHY read the axis backwards." },
            lectures: [oven],
          },
          {
            label: "(b)",
            text: "How long at 225?",
            points: 3.5,
            modelAnswer: "KEY-MODEL about 27 minutes.",
            ticks: [
              { text: "KEY-TICK reads between the dots", points: 2 },
              { text: "KEY-TICK gives a number near 27", points: 1.5 },
            ],
            commonWrong: { answer: "KEY-WRONG 35", why: "KEY-WRONG-WHY took the nearest dot." },
            lectures: [oven, essentials],
          },
        ],
      },
    ],
  });
  return {
    id: "bake-figures-1",
    course: "Baking for Beginners",
    order: 12,
    kind: "drill-figure",
    title: "Figures and tables 1",
    subtitle: "Three problems on reading a figure",
    totalPoints: 18,
    howToAnswer: "Answer every problem. Say what you read from the figure.",
    calculator: true,
    suggestedMinutes: 60,
    answersLabel: "Model loaf",
    paperHeader: { left: ["Baking for Beginners", "School of Ovens"], right: ["Figures and tables 1", "Autumn"] },
    questions: [problem(1, "A"), problem(2, "B"), problem(3, "C")],
    ...over,
  };
}

/** Every item of the sample's true/false question answered right. */
export const SAMPLE_ALL_RIGHT: Record<string, boolean> = { "0": true, "1": false, "2": true, "3": true, "4": false, "5": false };
