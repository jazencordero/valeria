/**
 * Check a typed fill-the-gap answer (M3-52). Pure: no Node or browser APIs.
 *
 *   matchBlank("  Squared. ", "squared", ["²", "^2"])  -> true
 *   matchCloze(["x²", "big"], card)                     -> [true, true]
 *
 * Both sides go through `normaliseAnswer`, then the typed answer must equal the blank's
 * answer or one of its accepted variants (`card.accept[blank]`, see ./card-schema).
 * Normalising, in this order:
 * 1. A run of superscript digits or signs becomes "^" and the plain characters, so
 *    "x²" and "x^2" are the same answer ("x^2") and "x⁻¹" is "x^-1". This runs before
 *    NFKC on purpose: NFKC alone turns "²" into "2", which would make "10²" equal "102".
 *    So "x2" is NOT the same as "x²"; a card that wants to accept it lists it in accept.
 * 2. Unicode NFKC: full-width letters, ligatures and subscripts become plain ("CO₂" is
 *    "co2"); composed letters stay composed, so ä and ö stay distinct from a and o.
 * 3. Lower case (no diacritics are removed: in Finnish "pää" is not "paa").
 * 4. Whitespace trimmed, every run collapsed to one space.
 * 5. Surrounding punctuation stripped, repeatedly: a trailing . , ; : ? or …, double
 *    quotes (straight, curly, guillemets) on either end, and a matching pair around the
 *    whole answer: (...), [...], '...', ‘...’. Leading dots, dashes, %, ! and inner
 *    punctuation are kept, because they change meaning: ".5" is not "5", "-5" is not
 *    "5", "3.5" is not "35".
 *
 * Nothing fuzzier than that: no edit distance, no stemming, no dropped accents. In an
 * exam tool a wrong answer marked right teaches her something false and inflates the
 * forecast, which is worse than a right answer she has to self-mark; alternatives the
 * card's author expects go in `accept` instead.
 */
import { clozeBlanks, type ClozeAccept } from "./card-schema";

const SUPERSCRIPT: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁺": "+", "⁻": "-",
};
const SUPERSCRIPT_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g;

const TRAILING = /[.,;:?…]$/;
const QUOTES = /^["“”„«»]+|["“”„«»]+$/g;
const PAIRS: [string, string][] = [["(", ")"], ["[", "]"], ["'", "'"], ["‘", "’"]];

/** The comparable form of an answer (see the header). */
export function normaliseAnswer(s: string): string {
  let out = s
    .replace(SUPERSCRIPT_RUN, (run) => `^${Array.from(run, (ch) => SUPERSCRIPT[ch]).join("")}`)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    let next = out.replace(QUOTES, "").replace(TRAILING, "");
    const pair = PAIRS.find(([open, close]) => next.length >= 2 && next.startsWith(open) && next.endsWith(close));
    if (pair) next = next.slice(pair[0].length, next.length - pair[1].length);
    next = next.trim();
    if (next === out) return out;
    out = next;
  }
}

/** True when the typed answer equals the blank's answer or an accepted variant, once normalised. */
export function matchBlank(input: string, answer: string, accept?: readonly string[]): boolean {
  const typed = normaliseAnswer(input);
  if (typed === "") return false;
  return [answer, ...(accept ?? [])].some((v) => normaliseAnswer(v) === typed);
}

/**
 * One result per blank of the card, in order. A missing input counts as wrong. The
 * accepted variants for a blank are `card.accept[blank answer, trimmed]`.
 */
export function matchCloze(inputs: readonly string[], card: { q: string; accept?: ClozeAccept }): boolean[] {
  return clozeBlanks(card.q).map((blank, i) => matchBlank(inputs[i] ?? "", blank, card.accept?.[blank.trim()]));
}
