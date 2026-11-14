/*
 * Switches that can stop a feature in a minute, without a new release (M1-43).
 *
 * Each switch is an environment value, read on every call (never cached at
 * import), so changing it in Vercel and redeploying the same build, or
 * restarting, takes effect at once.
 *
 * Environment values (document new ones here):
 *
 *   HANDIN_ENABLED  Hand-in from Ready. Default on. Off when the value,
 *                   trimmed and in any case, is "0", "false", "off" or "no";
 *                   anything else (or unset, or empty) is on. Off means
 *                   `prepareHandin` answers `paused` and `confirmHandin`
 *                   refuses before any Moodle call. Turn it off with
 *                   `vercel env add HANDIN_ENABLED production` (value `off`)
 *                   and redeploy.
 *
 * Default on, so a missing value never takes the feature away; a typo in the
 * value also leaves it on (only the four words above switch it off).
 */

const OFF_WORDS = new Set(["0", "false", "off", "no"]);

/** Whether an on/off environment value is on. Unset or empty counts as `fallback`. */
export function flagOn(value: string | undefined, fallback = true): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "") return fallback;
  return !OFF_WORDS.has(v);
}

/** Whether hand-in from Ready is on (`HANDIN_ENABLED`, default on). */
export function handinEnabled(): boolean {
  return flagOn(process.env.HANDIN_ENABLED, true);
}

/** The sentence the hand-in sheet shows while hand-in is paused. `lms` is the school's LMS name, e.g. MyCourses. */
export function handinPausedMessage(lms: string): string {
  return `Hand-in from Ready is paused. Hand this one in on ${lms}.`;
}
