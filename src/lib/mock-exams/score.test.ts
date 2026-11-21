import { describe, expect, it } from "vitest";
import { SAMPLE_ALL_RIGHT, sampleExam } from "./sample-exam";
import { findPart, partsOf, scoreAttempt, scorePart, scoreTrueFalse, toPaper, trueFalseOf } from "./score";
import type { GivenTick, MockExam, TrueFalseAnswer, WrittenPart } from "./types";
import { checkMockExam } from "./validate";

const exam = sampleExam();
const tf = trueFalseOf(exam)!;
const tick = (...indexes: number[]): GivenTick[] => indexes.map((index) => ({ index, fromCheck: false }));
const part = (key: string) => findPart(exam, key)!;

describe("true/false", () => {
  const score = (answers: Record<string, TrueFalseAnswer>) => scoreTrueFalse(tf, answers);

  it("gives a point for each right answer", () => {
    expect(score(SAMPLE_ALL_RIGHT)).toEqual({ right: 6, wrong: 0, blank: 0, score: 6 });
  });

  it("takes a point away for each wrong answer", () => {
    expect(score({ ...SAMPLE_ALL_RIGHT, "0": false })).toEqual({ right: 5, wrong: 1, blank: 0, score: 4 });
  });

  it("gives nothing for a blank, whether left blank or never answered", () => {
    expect(score({ "0": true, "1": false, "2": null })).toEqual({ right: 2, wrong: 0, blank: 4, score: 2 });
    expect(score({})).toEqual({ right: 0, wrong: 0, blank: 6, score: 0 });
  });

  it("never goes below zero", () => {
    expect(score({ "0": false, "1": true, "2": false, "3": false, "4": true, "5": true })).toEqual({ right: 0, wrong: 6, blank: 0, score: 0 });
    expect(score({ "0": true, "1": true, "2": false, "3": false }).score).toBe(0);
  });

  it("ignores answers for items the question does not have", () => {
    expect(score({ "9": true, "-1": false, x: true })).toEqual({ right: 0, wrong: 0, blank: 6, score: 0 });
  });
});

describe("a written part", () => {
  it("is the sum of the ticked ticks", () => {
    expect(scorePart(part("2.0.0"), tick(0))).toBe(1);
    expect(scorePart(part("2.0.0"), tick(0, 2))).toBe(1.5);
    expect(scorePart(part("2.0.0"), tick(0, 1, 2))).toBe(2);
    expect(scorePart(part("2.0.0"), [])).toBe(0);
    expect(scorePart(part("2.0.0"), undefined)).toBe(0);
  });

  it("adds halves without drift", () => {
    expect(scorePart(part("2.0.1"), tick(0, 1, 2))).toBe(1.5);
    const tenths: WrittenPart = { ...part("2.0.0"), points: 1, ticks: [{ text: "a", points: 0.1 }, { text: "b", points: 0.2 }, { text: "c", points: 0.7 }] };
    expect(scorePart(tenths, tick(0, 1))).toBe(0.3);
    expect(scorePart(tenths, tick(0, 1, 2))).toBe(1);
  });

  it("is capped at the part's points", () => {
    // Three ticks of 1 on a part worth 2.5.
    expect(scorePart(part("2.1.0"), tick(0, 1, 2))).toBe(2.5);
  });

  it("counts a tick given twice once", () => {
    expect(scorePart(part("2.0.0"), tick(1, 1, 1))).toBe(0.5);
  });

  it("ignores tick indexes the part does not have", () => {
    expect(scorePart(part("2.0.0"), tick(3, -1, 99))).toBe(0);
    expect(scorePart(part("2.0.0"), [{ index: 0.5, fromCheck: false }, { index: Number.NaN, fromCheck: false }, null as unknown as GivenTick])).toBe(0);
  });

  it("counts a tick from Check my answer like any other", () => {
    expect(scorePart(part("2.0.0"), [{ index: 0, fromCheck: true }])).toBe(1);
  });
});

describe("the whole attempt", () => {
  const allTicks = Object.fromEntries(partsOf(exam).map((p) => [p.key, tick(...p.part.ticks.map((_, i) => i))]));

  it("is the sum of the four questions", () => {
    const score = scoreAttempt(exam, { trueFalse: SAMPLE_ALL_RIGHT, ticks: allTicks });
    expect(score.total).toBe(24);
    expect(score.max).toBe(24);
    expect(score.questions.map((q) => [q.number, q.score, q.max])).toEqual([[1, 6, 6], [2, 6, 6], [3, 6, 6], [4, 6, 6]]);
  });

  it("scores question 1 alone before she has ticked anything", () => {
    const score = scoreAttempt(exam, { trueFalse: { ...SAMPLE_ALL_RIGHT, "5": true, "4": null }, ticks: {} });
    expect(score.total).toBe(3);
    expect(score.questions[0]).toEqual({ number: 1, score: 3, max: 6, trueFalse: { right: 4, wrong: 1, blank: 1 } });
    expect(score.questions[1].parts).toEqual([
      { key: "2.0.0", score: 0, max: 2 },
      { key: "2.0.1", score: 0, max: 1.5 },
      { key: "2.1.0", score: 0, max: 2.5 },
    ]);
  });

  it("adds part scores with halves", () => {
    const score = scoreAttempt(exam, { trueFalse: {}, ticks: { "2.0.0": tick(1), "2.0.1": tick(0, 1, 2), "2.1.0": tick(0, 1, 2), "3.0.0": tick(0), "4.0.0": tick(2) } });
    expect(score.questions.map((q) => q.score)).toEqual([0, 4.5, 1.5, 1]);
    expect(score.total).toBe(7);
  });

  it("ignores ticks for parts the exam does not have", () => {
    expect(scoreAttempt(exam, { trueFalse: {}, ticks: { "9.9.9": tick(0), "2.0": tick(0), toString: tick(0) } }).total).toBe(0);
  });

  it("lists every part with its key in paper order", () => {
    expect(partsOf(exam).map((p) => p.key)).toEqual(["2.0.0", "2.0.1", "2.1.0", "3.0.0", "3.0.1", "4.0.0"]);
    expect(findPart(exam, "1.0.0")).toBeNull();
    expect(findPart(exam, "2.0.2")).toBeNull();
  });
});

describe("the paper", () => {
  const paper = toPaper(exam);
  const text = JSON.stringify(paper);

  /** Every property name anywhere in a value, with the path it sits at. */
  function names(value: unknown, path: string[] = [], out: { name: string; path: string[]; value: unknown }[] = []) {
    if (Array.isArray(value)) value.forEach((v, i) => names(v, [...path, String(i)], out));
    else if (typeof value === "object" && value !== null) {
      for (const [name, v] of Object.entries(value)) {
        out.push({ name, path, value: v });
        names(v, [...path, name], out);
      }
    }
    return out;
  }

  it("carries no key, model answer, tick, usual wrong answer, note or lecture link", () => {
    const found = names(JSON.parse(text));
    for (const forbidden of ["answer", "why", "note", "lectures", "modelAnswer", "commonWrong", "href"]) {
      expect(found.filter((f) => f.name === forbidden)).toEqual([]);
    }
    // The only `ticks` on a paper are an axis's tick marks: numbers, under a figure's x or y.
    const ticks = found.filter((f) => f.name === "ticks");
    expect(ticks).toHaveLength(2);
    for (const t of ticks) {
      expect(["x", "y"]).toContain(t.path[t.path.length - 1]);
      expect(t.path[t.path.length - 2]).toBe("figure");
      expect((t.value as unknown[]).every((v) => typeof v === "number")).toBe(true);
    }
  });

  it("carries none of the key's text", () => {
    expect(text).not.toContain("KEY-");
    expect(JSON.stringify(exam)).toContain("KEY-MODEL");
  });

  it("keeps the whole paper she reads", () => {
    expect(paper.questions).toHaveLength(4);
    expect(paper.paperHeader).toEqual(exam.paperHeader);
    expect(paper.howToAnswer).toBe(exam.howToAnswer);
    const q1 = paper.questions[0];
    expect(q1.type === "truefalse" && q1.items.map((i) => Object.keys(i))).toEqual(Array(6).fill(["text"]));
    const q2 = paper.questions[1];
    if (q2.type !== "written") throw new Error("question 2 is written");
    expect(q2.sections[0].formula).toBe("hydration = water / flour");
    expect(q2.sections[0].parts).toEqual([
      { label: "i.", text: "What is the hydration?", points: 2 },
      { label: "ii.", text: "Is that a wet dough?", points: 1.5 },
    ]);
    expect(q2.sections[1].table).toEqual({ columns: ["Minute", "Height"], rows: [[0, 5], [10, 9], ["end", 11]] });
    expect(q2.sections[1].figure?.lines?.[0].data).toEqual([[0, 5], [10, 9], [20, 11], [40, 11]]);
    expect(q2.sections[1].figure?.alt).toBe("A line that rises fast and then stays flat.");
  });

  it("drops anything the file holds that a paper has no place for", () => {
    const odd = sampleExam() as MockExam & { secret?: string };
    odd.secret = "KEY-EXTRA";
    (odd.questions[0] as unknown as Record<string, unknown>).solution = "KEY-EXTRA";
    const q2 = odd.questions[1];
    if (q2.type === "written") (q2.sections[0].parts[0] as unknown as Record<string, unknown>).hint = "KEY-EXTRA";
    expect(JSON.stringify(toPaper(odd))).not.toContain("KEY-EXTRA");
  });

  it("does not change the exam it was made from", () => {
    const before = JSON.stringify(exam);
    const made = toPaper(exam);
    const q2 = made.questions[1];
    if (q2.type === "written") q2.sections[1].table!.rows[0][0] = 99;
    expect(JSON.stringify(exam)).toBe(before);
  });
});

describe("checking an exam file", () => {
  const broken = (change: (exam: Record<string, unknown>) => void) => {
    const raw = JSON.parse(JSON.stringify(sampleExam())) as Record<string, unknown>;
    change(raw);
    return checkMockExam(raw);
  };
  const questions = (raw: Record<string, unknown>) => raw.questions as Record<string, unknown>[];

  it("takes the sample as it is", () => {
    const checked = checkMockExam(JSON.parse(JSON.stringify(sampleExam())));
    expect(checked.ok && checked.exam).toEqual(sampleExam());
  });

  it("drops keys an exam file does not have", () => {
    const checked = broken((raw) => {
      raw.extra = "x";
      questions(raw)[0].extra = "x";
    });
    expect(checked.ok && JSON.stringify(checked.exam)).not.toContain("extra");
  });

  it.each([
    ["no key on an item", (raw: Record<string, unknown>) => delete (questions(raw)[0].items as Record<string, unknown>[])[2].answer, "questions.0.items.2.answer"],
    ["an id that is not a slug", (raw: Record<string, unknown>) => (raw.id = "Bake 1!"), "id"],
    ["a kind it does not know", (raw: Record<string, unknown>) => (raw.kind = "final"), "kind"],
    ["a part without ticks", (raw: Record<string, unknown>) => delete ((questions(raw)[1].sections as Record<string, unknown>[])[0].parts as Record<string, unknown>[])[0].ticks, "questions.1.sections.0.parts.0.ticks"],
    ["points with three decimals", (raw: Record<string, unknown>) => (questions(raw)[2].points = 1.234), "questions.2.points"],
    ["a question number used twice", (raw: Record<string, unknown>) => (questions(raw)[3].number = 2), "questions.3.number"],
    ["two true/false questions", (raw: Record<string, unknown>) => questions(raw).push({ ...questions(raw)[0], number: 5 }), "questions.4.type"],
    ["no questions", (raw: Record<string, unknown>) => (raw.questions = []), "questions"],
  ])("refuses %s", (_name, change, path) => {
    const checked = broken(change);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems.some((p) => p.startsWith(`${path}:`))).toBe(true);
  });

  it.each([[null], ["text"], [[]], [{}]])("refuses %j", (raw) => {
    expect(checkMockExam(raw).ok).toBe(false);
  });

  it("names paths, never the file's own text", () => {
    const checked = broken((raw) => (raw.kind = "KEY-SECRET"));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems.join(" ")).not.toContain("KEY-SECRET");
  });
});
