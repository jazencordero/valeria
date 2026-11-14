/**
 * The instant-animation switch for tests (the prototype's #fast).
 * `?fast=1` in the URL or a `READY_FAST` cookie (Playwright sets it) marks
 * <html data-fast="1">; useCalm() reads that attribute.
 */
export const FAST_COOKIE = "READY_FAST";
export const FAST_PARAM = "fast";

/** Pure check, easy to test: does this URL query or cookie string ask for fast? */
export function wantsFast(search: string, cookie: string): boolean {
  if (new URLSearchParams(search).get(FAST_PARAM) === "1") return true;
  return cookie
    .split(";")
    .some((part) => part.trim().split("=")[0] === FAST_COOKIE);
}

/** Sets data-fast on <html> when the URL or cookie asks for it. Safe to call often. */
export function applyFast(): void {
  if (typeof document === "undefined") return;
  if (wantsFast(window.location.search, document.cookie)) {
    document.documentElement.dataset.fast = "1";
  }
}

export function isFast(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.fast !== undefined
  );
}
