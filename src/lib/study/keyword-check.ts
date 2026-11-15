/*
 * M3-16: the quick check for an "Explain it" answer, without AI.
 *
 *   keywordCheck(card.rubric, text)   { had: [labels], missing: [labels] }
 *
 * The prototype's matching (context/tickets/prototype/main-flow.html, lines 3332 to 3338): a
 * rubric point counts as had when any of its keywords appears anywhere in her text. Keywords are
 * stems ("strateg", "differentiat"), so a keyword inside a longer word counts, as it does there.
 *
 * Both sides go through `normalise` first, so case, accents and punctuation never decide it:
 * "Säätö," matches "saato", and "cost-cutting" matches "cost cutting".
 *
 * Every rubric label ends up in exactly one of the two lists, in rubric order. A label that
 * appears twice is listed once: had when either point's keywords appear. Empty text (or text
 * with no letters or digits) has nothing: every label is missing.
 *
 * Pure: no Node or browser APIs.
 */
import type { RubricPoint } from "./card-schema";

export type RubricResult = { had: string[]; missing: string[] };

/** Lower case, accents removed, every run of non-letters and non-digits one space, trimmed. */
export function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Which rubric labels her text covers, by keyword. */
export function keywordCheck(rubric: readonly RubricPoint[], text: string): RubricResult {
  const said = normalise(text);
  const covered = new Map<string, boolean>();
  for (const [label, keywords] of rubric) {
    const hit =
      said !== "" &&
      keywords.some((keyword) => {
        const k = normalise(keyword);
        return k !== "" && said.includes(k);
      });
    covered.set(label, (covered.get(label) ?? false) || hit);
  }
  return split(covered);
}

/** Labels in first-seen order, split by whether they were covered. */
export function split(covered: ReadonlyMap<string, boolean>): RubricResult {
  const had: string[] = [];
  const missing: string[] = [];
  for (const [label, hit] of covered) (hit ? had : missing).push(label);
  return { had, missing };
}
