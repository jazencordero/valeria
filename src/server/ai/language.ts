/*
 * M2-26: which language is this course text in?
 *
 *   const lang = languageOf(slideText); // "fi" | "sv" | "en"
 *
 * Prompts can then ask for output in the material's own language, while the app's own wording
 * stays English. It counts very common words of each language and the most hits wins.
 *
 * Limits: three languages only, and it needs a sentence or two; a few words, a formula or a
 * table of numbers have no common words. With no hits at all, or a tie, the answer is "en".
 * Words that are common in two of the languages ("on", "en", "men", "i", "he", "me", "under") are left out.
 */

export type Language = "fi" | "sv" | "en";

/** Human name, for prompts: "Write in Finnish." */
export const LANGUAGE_NAMES: Record<Language, string> = { fi: "Finnish", sv: "Swedish", en: "English" };

const words = (list: string) => new Set(list.split(" "));

const COMMON: Record<Language, Set<string>> = {
  fi: words(
    "ja ei että se tämä oli joka mutta kun myös tai ovat sekä kuin niin hän mitä voi tässä olla ole jos vain " +
      "miten sitä ne mikä tämän sen jotka koska kanssa vielä nyt sitten kaikki ovat olivat eli " +
      "esimerkiksi tehtävä tehtävän kurssin luento",
  ),
  sv: words(
    "och att det är som på för med inte av till den har de ett om kan eller vi jag du så från vad hur ska " +
      "när också detta dessa blir vara finns sig sin efter mellan genom mycket bara än även där här " +
      "uppgift uppgiften kursen föreläsning",
  ),
  en: words(
    "the and of to is in that it for with as are this be not or by from at an was what how you which have " +
      "has were can will their there these those than then your they we but if about into more should " +
      "assignment course lecture",
  ),
};

/** "en" first, so a tie or no hits at all stays "en". */
const ORDER: Language[] = ["en", "fi", "sv"];

/** "fi", "sv" or "en", from common-word counts. "en" when it cannot tell. */
export function languageOf(text: string): Language {
  const score: Record<Language, number> = { fi: 0, sv: 0, en: 0 };
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    for (const lang of ORDER) if (COMMON[lang].has(word)) score[lang] += 1;
  }
  let best: Language = "en";
  for (const lang of ORDER) if (score[lang] > score[best]) best = lang;
  return best;
}
