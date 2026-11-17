/**
 * The order a multiple-choice card shows its options in (M3-33).
 *
 * Bundles list the right option first, so showing them in file order makes
 * "A" always right. `shownOptions(opts, seed)` returns the same options in a
 * seeded order: the right one is carried as its own `[text, isRight]` pair,
 * never found again by position.
 *
 * - Same seed, same order. The seed is `optionSeed(cardId, sessionId, attempt)`,
 *   shared by the player and the tutor: a reload of the card she is on keeps
 *   its order, a missed card that comes back in the same session (the next
 *   attempt) and the next session show a new one.
 * - "All of the above", "None of the above", "Both of these", "Neither of the
 *   above" keep their own slot (they only make sense where they were put).
 * - A card whose options name another option by letter ("A and B", "Both A and
 *   C", "option B") keeps its file order: moving them would change what the
 *   letters point at.
 */
export type Option = readonly [text: string, right: boolean];

const ANCHORED = /\b(?:all|none|both|neither|any)\s+of\s+(?:the\s+)?(?:above|these|those|them|the\s+options)\b/i;
// The words in any case, the letters capital only (so "a model" is not a reference to option A).
const LETTER_REF =
  /\b(?:[Oo]ptions?|[Aa]nswers?|[Cc]hoices?)\s+[A-D]\b|\b[A-D]\s*(?:,|and|&|or|\+)\s*[A-D]\b|\b(?:[Bb]oth|[Oo]nly|[Nn]either|[Ee]ither)\s+[A-D]\b/;

/**
 * The one seed for a card's option order, used by the player and by the tutor's context, so
 * the tutor sees the options exactly as she does. `attempt` is how many times the card was
 * already answered in this session (0 the first time). Attempt 0 keeps the plain
 * `cardId:sessionId` seed.
 */
export function optionSeed(cardId: string, sessionId: string, attempt = 0): string {
  return attempt > 0 ? `${cardId}:${sessionId}:${attempt}` : `${cardId}:${sessionId}`;
}

/** The option keeps its slot: "All of the above" and the like. */
export const isAnchored = (text: string) => ANCHORED.test(text);

/** Some option points at another by its letter: the card keeps its file order. */
export const refersByLetter = (opts: readonly Option[]) => opts.some(([text]) => LETTER_REF.test(text));

/** 32-bit FNV-1a hash of a string. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, well-spread PRNG from a 32-bit seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The options in the order to show them for `seed`. Pure; never mutates `opts`. */
export function shownOptions<T extends Option>(opts: readonly T[], seed: string): T[] {
  if (opts.length < 2 || refersByLetter(opts)) return [...opts];
  const free = opts.map((_, i) => i).filter((i) => !isAnchored(opts[i][0]));
  const moved = free.map((i) => opts[i]);
  const next = rng(hash(seed));
  for (let i = moved.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [moved[i], moved[j]] = [moved[j], moved[i]];
  }
  const out = [...opts];
  free.forEach((slot, k) => {
    out[slot] = moved[k];
  });
  return out;
}
