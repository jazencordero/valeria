/**
 * The Finnish 0 to 5 grade scale.
 *
 * Pure. Formula from the prototype (main-flow.html gradeFromPct): 0 under 50%,
 * then one grade per 10 points from 1 at 50% up to 5 at 90%, capped at 5.
 */

/**
 * Grade for a percentage, on the continuous 0..5 scale (not rounded):
 * 0 under 50, else `min(5, (p - 40) / 10)`. So 50 is 1, 80 is 4, 85 is 4.5,
 * 90 and above are 5. Fractions are kept because grade trajectories draw
 * them; use `gradeStep` for the whole grade a student actually gets.
 */
export function gradeFromPct(p: number): number {
  return p < 50 ? 0 : Math.min(5, (p - 40) / 10);
}

/**
 * The whole grade 0..5 for a percentage: `gradeFromPct` floored. The 1e-9
 * absorbs float noise so a percentage that is meant to sit exactly on a step
 * (for example 69.99999999999999 from a weighted sum) reaches it, as in the
 * prototype's gradeAt.
 */
export function gradeStep(p: number): 0 | 1 | 2 | 3 | 4 | 5 {
  return Math.floor(gradeFromPct(p) + 1e-9) as 0 | 1 | 2 | 3 | 4 | 5;
}
