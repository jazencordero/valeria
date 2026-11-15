import { describe, expect, it } from "vitest";
import { canonicalJson, clozeBlanks, contentHash, parseCard, type Card } from "./card-schema";

/** The prototype's CARD_DATA, copied from context/tickets/prototype/main-flow.html lines 2513 to 2571. */
const CARD_DATA: Record<string, unknown> = {
  s1: { type: 'basic', concept: 'gov', q: 'What is the difference between IT governance and IT management?',
        a: 'Governance decides who makes which IT decisions and who answers for them. Management makes and carries out those decisions day to day.',
        src: 'Lecture 3, slide 8', st: { type: 'review', ivl: 3, ease: 2.5, step: 0 } },
  s2: { type: 'cloze', concept: 'dec', q: 'Weill and Ross name five key IT decisions: IT principles, IT architecture, IT infrastructure, {{business application needs}} and {{IT investment and prioritisation}}.',
        src: 'Lecture 3, slide 14', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  s3: { type: 'mcq', concept: 'src', q: 'A firm outsources its help desk but keeps architecture decisions in-house. What is this called?',
        opts: [['Selective sourcing', true], ['Total outsourcing', false], ['Backsourcing', false], ['Offshoring', false]],
        why: 'Selective sourcing hands over well-defined commodity services and keeps the strategic decisions inside.',
        src: 'Lecture 5, slide 6', st: { type: 'review', ivl: 2, ease: 2.5, step: 0 } },
  s4: { type: 'basic', concept: 'src', q: 'Name two risks of vendor lock-in.',
        a: 'High switching costs, and less bargaining power because you depend on the vendor\'s prices and roadmap.',
        src: 'Lecture 5, slide 19', st: { type: 'learning', ivl: 0, ease: 2.5, step: 1 } },
  s5: { type: 'explain', concept: 'dsa', q: 'Explain strategic alignment between business and IT in your own words.',
        rubric: [['Business strategy shapes IT choices', ['business strategy', 'drive', 'shape', 'support']],
                 ['It goes both ways: IT can also open up new strategy', ['both', 'two-way', 'enable', 'new']],
                 ['Structure and processes have to fit too, not only strategy', ['structure', 'process', 'organisation', 'organization']]],
        model: 'Alignment means business strategy and IT strategy fit and inform each other, and that the organisation\'s structures and processes are set up to deliver on both.',
        src: 'Lecture 7, slides 4 to 9', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  s6: { type: 'basic', concept: 'sla', q: 'What does a service level agreement define?',
        a: 'The measurable level of service the vendor must deliver, how it is measured, and what happens when it is missed.',
        src: 'Lecture 5, slide 11', st: { type: 'review', ivl: 5, ease: 2.5, step: 0 } },
  m1: { type: 'match', concept: 'sla', q: 'Match each term to what it means.',
        pairs: [['SLA', 'The service level a vendor must hit'], ['Lock-in', 'Switching vendor costs too much'], ['Selective sourcing', 'Outsource commodity work, keep strategy'], ['Backsourcing', 'Bring outsourced work back in-house']],
        order: [2, 0, 3, 1], src: 'Lecture 5, slides 6 to 19', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  b1: { type: 'mcq', boss: true, concept: 'src', concepts: ['src', 'sla'],
        q: 'Your CRM vendor has missed its SLA three months running, and switching would take a year. What is the strongest first move?',
        opts: [['Use the SLA penalties to renegotiate, and plan an exit path', true], ['Switch vendor right away', false], ['Bring CRM in-house next month', false], ['Accept it. Lock-in means you have no options', false]],
        why: 'The SLA gives you leverage now. Lock-in makes a sudden switch costly, so you press on the contract while you prepare a way out.',
        src: 'Past exam 2024, question 3', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  p1: { type: 'cloze', concept: 'sla', q: 'A {{service level agreement}} sets the measurable level of service a vendor must deliver.',
        src: 'Lecture 5, slide 11', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  p2: { type: 'mcq', concept: 'dec', q: 'According to Weill and Ross, who should set the IT principles?',
        opts: [['Business and IT leaders together', true], ['The IT department alone', false], ['External consultants', false], ['Each business unit on its own', false]],
        why: 'IT principles say how IT creates value for the business, so business and IT leaders set them together.',
        src: 'Lecture 3, slide 16', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  p3: { type: 'explain', concept: 'src', q: 'Explain when a firm should keep an IT activity in-house.',
        rubric: [['It is strategic or a source of advantage', ['strateg', 'advantage', 'core', 'differentiat']],
                 ['The firm has, or needs, the know-how inside', ['skill', 'know-how', 'knowhow', 'expertise', 'capabilit']],
                 ['Outsourcing would create a risky dependence', ['lock-in', 'lock in', 'depend', 'risk', 'switch']]],
        model: 'Keep an activity in-house when it is strategic or a source of advantage, when you need the know-how inside, and when handing it over would make you dangerously dependent on one vendor.',
        src: 'Lecture 5, slides 4 to 9', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  p4: { type: 'basic', concept: 'val', q: 'What is the difference between IT cost and IT value?',
        a: 'Cost is what you spend. Value is the business benefit it creates: more revenue, lower costs elsewhere, or less risk.',
        src: 'Lecture 8, slide 3', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  b2: { type: 'mcq', boss: true, concept: 'dsa', concepts: ['dsa', 'val'],
        q: 'The board asks whether a new data platform "fits the strategy". Which answer shows alignment thinking?',
        opts: [['It supports how we plan to win on service, and our teams can actually use it', true], ['It is the cheapest platform on the market', false], ['IT chose it, so it fits IT strategy', false], ['Our competitors bought it last year', false]],
        why: 'Alignment ties the choice to the business strategy and checks the organisation can deliver on it. Price and imitation are not alignment.',
        src: 'Past exam 2023, question 5', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  q1: { type: 'basic', concept: 'sta', q: 'What does it mean for a time series to be stationary?',
        a: 'Its mean, variance and autocorrelation do not change over time.', src: 'Lecture 7, slide 5', st: { type: 'review', ivl: 2, ease: 2.5, step: 0 } },
  q2: { type: 'cloze', concept: 'dif', q: 'Differencing a series once removes a {{linear trend}}; seasonal differencing removes {{seasonality}}.',
        src: 'Lecture 7, slide 9', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
  q3: { type: 'mcq', concept: 'acf', q: 'The ACF cuts off after lag 2 and the PACF tails off. Which model fits?',
        opts: [['MA(2)', true], ['AR(2)', false], ['ARMA(2,2)', false], ['White noise', false]],
        why: 'A sharp ACF cut-off with a decaying PACF is the signature of a moving-average process.',
        src: 'Lecture 8, slide 14', st: { type: 'new', ivl: 0, ease: 2.5, step: 0 } },
};

function ok(json: unknown): Card {
  const r = parseCard(json);
  if (!r.ok) throw new Error(`expected a card, got: ${r.problems.join(" | ")}`);
  return r.card;
}

function problems(json: unknown): string[] {
  const r = parseCard(json);
  if (r.ok) throw new Error("expected problems, got a card");
  return r.problems;
}

const mcq = CARD_DATA.s3 as Record<string, unknown>;
const cloze = CARD_DATA.s2 as Record<string, unknown>;
const match = CARD_DATA.m1 as Record<string, unknown>;

describe("parseCard: the prototype's cards", () => {
  it.each(Object.keys(CARD_DATA))("%s parses", (id) => {
    expect(parseCard(CARD_DATA[id]).ok).toBe(true);
  });

  it("covers all five card types", () => {
    const types = new Set(Object.values(CARD_DATA).map((c) => ok(c).type));
    expect([...types].sort()).toEqual(["basic", "cloze", "explain", "match", "mcq"]);
  });

  it("normalises src to source, concept to concepts, boss to a boolean, and drops st", () => {
    const card = ok(CARD_DATA.s1);
    expect(card.source).toBe("Lecture 3, slide 8");
    expect(card.concepts).toEqual(["gov"]);
    expect(card.boss).toBe(false);
    expect(card).not.toHaveProperty("st");
    expect(card).not.toHaveProperty("src");
    expect(card).not.toHaveProperty("concept");
  });

  it("merges concept and concepts on boss cards, primary first, no duplicates", () => {
    const card = ok(CARD_DATA.b1);
    expect(card.boss).toBe(true);
    expect(card.concepts).toEqual(["src", "sla"]);
  });

  it("keeps the match order and the cloze blanks", () => {
    const m = ok(match);
    expect(m.type === "match" && m.order).toEqual([2, 0, 3, 1]);
    const c = ok(cloze);
    expect(c.type === "cloze" && clozeBlanks(c.q)).toEqual(["business application needs", "IT investment and prioritisation"]);
  });

  it("accepts an optional rung 1..5 and rejects others", () => {
    expect(ok({ ...mcq, rung: 3 }).rung).toBe(3);
    expect(problems({ ...mcq, rung: 6 })).toContain("The rung must be a whole number from 1 to 5.");
    expect(problems({ ...mcq, rung: 2.5 })).toContain("The rung must be a whole number from 1 to 5.");
  });
});

describe("parseCard: rejects with a readable reason", () => {
  it("an mcq with two correct options", () => {
    const opts = [["A", true], ["B", true], ["C", false]];
    expect(problems({ ...mcq, opts })).toEqual([
      "A multiple-choice card needs exactly one correct option; this one has 2.",
    ]);
  });

  it("an mcq with too many or too few options", () => {
    expect(problems({ ...mcq, opts: [["A", true]] })).toEqual([
      "A multiple-choice card needs 2 to 4 options; this one has 1.",
    ]);
    const five = [["A", true], ["B", false], ["C", false], ["D", false], ["E", false]];
    expect(problems({ ...mcq, opts: five })).toEqual([
      "A multiple-choice card needs 2 to 4 options; this one has 5.",
    ]);
  });

  it("a cloze with no blank", () => {
    expect(problems({ ...cloze, q: "Weill and Ross name five key IT decisions." })).toEqual([
      "A fill-the-gap card needs at least one blank written as {{answer}}; this one has none.",
    ]);
  });

  it("a cloze with an empty or broken blank", () => {
    expect(problems({ ...cloze, q: "A {{ }} sets the level." })).toEqual([
      "Every blank needs an answer inside the braces; 1 blank is empty.",
    ]);
    expect(problems({ ...cloze, q: "A {{service level agreement}} sets the {{level." })).toEqual([
      "The text has a {{ or }} that is not part of a complete {{answer}} blank.",
    ]);
  });

  it("a match with two pairs", () => {
    const pairs = [["SLA", "The service level a vendor must hit"], ["Lock-in", "Switching vendor costs too much"]];
    expect(problems({ ...match, pairs, order: [1, 0] })).toEqual([
      "A match card needs 3 to 5 pairs; this one has 2.",
    ]);
  });

  it("a match whose order does not name every pair once", () => {
    expect(problems({ ...match, order: [0, 0, 1, 2] })).toEqual([
      "The order must list every pair number from 0 to 3 once; this one is [0, 0, 1, 2].",
    ]);
  });

  it("an explain card without a rubric point or keywords", () => {
    const explain = CARD_DATA.s5 as Record<string, unknown>;
    expect(problems({ ...explain, rubric: [] })).toEqual([
      "An explain card needs at least one rubric point; this one has none.",
    ]);
    expect(problems({ ...explain, rubric: [["Label", []]] })).toEqual([
      "Each rubric point needs at least one keyword.",
    ]);
  });

  it("missing fields, unknown types and non-objects", () => {
    expect(problems({ type: "basic", concept: "gov", src: "Lecture 3" })).toEqual([
      "The question is missing.",
      "The answer is missing.",
    ]);
    expect(problems({ type: "basic", q: "Q?", a: "A." })).toEqual([
      "A recall card needs a concept (concept or concepts); this one has none.",
      'A recall card needs a source, such as "Lecture 5, slide 11"; this one has none.',
    ]);
    expect(problems({ type: "essay", q: "Q?" })).toEqual([
      'The card type must be one of basic, cloze, mcq, match, explain; this one is "essay".',
    ]);
    expect(problems(null)).toEqual(["A card must be an object with a type and a question."]);
    expect(problems({ ...mcq, q: "   " })).toEqual(["The question is empty."]);
  });
});

describe("contentHash", () => {
  const base = ok(mcq);

  it("is a 16-character hex string and the same every time", () => {
    expect(contentHash(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash(ok(mcq))).toBe(contentHash(base));
  });

  it("ignores key order", () => {
    const reversed = Object.fromEntries(Object.entries(mcq).reverse());
    expect(contentHash(ok(reversed))).toBe(contentHash(base));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("ignores whitespace in strings", () => {
    const spaced = { ...mcq, q: `  ${(mcq.q as string).replace(/ /g, "   \n ")}  ` };
    expect(contentHash(ok(spaced))).toBe(contentHash(base));
  });

  it("ignores fields that are not content: source, concepts, why, boss, rung, match order", () => {
    expect(contentHash(ok({ ...mcq, src: "Another lecture", concept: "other", why: "Other.", boss: true, rung: 2 }))).toBe(
      contentHash(base),
    );
    expect(contentHash(ok({ ...match, order: [0, 1, 2, 3] }))).toBe(contentHash(ok(match)));
  });

  it("differs for different content", () => {
    const hashes = Object.values(CARD_DATA).map((c) => contentHash(ok(c)));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(contentHash(ok({ ...mcq, q: `${mcq.q as string} Really?` }))).not.toBe(contentHash(base));
    const flipped = [["Selective sourcing", false], ["Total outsourcing", true], ["Backsourcing", false], ["Offshoring", false]];
    expect(contentHash(ok({ ...mcq, opts: flipped }))).not.toBe(contentHash(base));
  });
});

describe("core, first and accept (M3-52)", () => {
  const blanks = { type: "cloze", concept: "stats", src: "Lecture 2, slide 4", q: "With a {{ large }} sample the error goes to {{zero}}." };

  it("core and first default to false and are kept when set", () => {
    const plain = ok(mcq);
    expect(plain.core).toBe(false);
    expect(plain.first).toBe(false);
    const marked = ok({ ...mcq, core: true, first: true });
    expect(marked.core).toBe(true);
    expect(marked.first).toBe(true);
    expect(ok({ ...CARD_DATA.s1 as object, core: true }).core).toBe(true);
    expect(problems({ ...mcq, core: "yes" })).toContain("Core must be true or false.");
    expect(problems({ ...mcq, first: 1 })).toContain("First must be true or false.");
  });

  it("keeps cloze accept, keys trimmed to the blank answers", () => {
    const card = ok({ ...blanks, accept: { large: ["big"], " zero ": [" 0 "] } });
    expect(card.type === "cloze" && card.accept).toEqual({ large: ["big"], zero: ["0"] });
  });

  it("drops empty accept lists, and accept when nothing is left", () => {
    const some = ok({ ...blanks, accept: { large: [], zero: ["0"] } });
    expect(some.type === "cloze" && some.accept).toEqual({ zero: ["0"] });
    const none = ok({ ...blanks, accept: { large: [] } });
    expect(none).not.toHaveProperty("accept");
    expect(ok(blanks)).not.toHaveProperty("accept");
  });

  it("rejects an accept key that is not a blank, and bad shapes, in plain words", () => {
    expect(problems({ ...blanks, accept: { huge: ["big"] } })).toEqual([
      'The accepted answers name a blank "huge" that is not in the text; each key must be the answer inside one of its {{...}} blanks.',
    ]);
    expect(problems({ ...blanks, accept: ["big"] })).toEqual([
      "The accepted answers must be an object: { blank answer: [other answers] }.",
    ]);
    expect(problems({ ...blanks, accept: { large: "big" } })).toEqual([
      "Each blank's accepted answers must be a list of text.",
    ]);
    expect(problems({ ...blanks, accept: { large: ["  "] } })).toEqual(["Each accepted answer is empty."]);
  });

  it("does not change contentHash", () => {
    const base = contentHash(ok(blanks));
    expect(contentHash(ok({ ...blanks, core: true, first: true, accept: { large: ["big"] } }))).toBe(base);
    expect(contentHash(ok({ ...mcq, core: true, first: true }))).toBe(contentHash(ok(mcq)));
  });
});
