/**
 * Welcome screen (M5-02). Source: prototype main-flow.html HTML 1266-1284,
 * CSS 242-255 and 561-569. Spacing the given CSS ranges do not hold (the
 * start column, the top row, the mini doodles' place, the underline) was
 * measured from the prototype rendered in a browser.
 *
 * Top: the wordmark (tiny cap + "Ready") and the theme button. Middle: the
 * cap on a blush blob with a butter star and a squiggle, the three-line
 * headline (the last line rose italic with a hand-drawn underline) and the
 * sub line. Foot: Get started (to /school) and "Takes about 20 seconds."
 *
 * No state of its own, so it stays a Server Component; the cap, theme button
 * and button bring their own client code. Needs the #wobble filter on the
 * page (`DoodleDefs`, held by the (first-run) layout).
 *
 * Cut: no intro animation (M5-03). The underline path keeps
 * `pathLength="1"` so M5-03 can draw it in with a dash offset.
 */
import { ThemeButton } from "@/components/ui/theme-button";
import { Button } from "@/components/ui/button";
import { Vitonen } from "@/components/vitonen";

const BLOB =
  "M102 8 C150 6 194 34 190 80 C186 124 142 146 96 142 C50 138 8 118 10 74 C12 32 54 10 102 8 Z";
const STAR =
  "M12 3l2.3 5.4 5.7.5-4.4 3.8 1.4 5.6L12 15.3l-5 3 1.4-5.6L4 8.9l5.7-.5z";
const SQUIG = "M2 10 q5 -9 10 0 t10 0 t10 -2";
const UNDERLINE = "M3 9 C 30 3, 50 13, 80 7 S 130 3, 160 8 S 190 10, 197 5";

/** Small hand-drawn marks: ink-2 line, round ends. */
const MINI =
  "absolute [&_path]:stroke-ink-2 [&_path]:[stroke-width:1.6] [&_path]:[stroke-linecap:round] [&_path]:[stroke-linejoin:round]";

export function Welcome() {
  return (
    // From 700 px the prototype's page is paper (body background there); the
    // app's body stays surface, so the screen paints it itself.
    <div className="min-h-dvh min-[700px]:bg-paper">
      <div className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-[max(28px,env(safe-area-inset-bottom,0px))]">
        <div className="-mr-3 flex items-center justify-between">
          <div className="inline-flex min-h-11 items-center gap-2 font-display text-[20px] font-semibold tracking-[-0.01em] [font-variation-settings:'SOFT'_100]">
            <Vitonen size={24} />
            Ready
          </div>
          <ThemeButton />
        </div>

        <div className="flex flex-1 flex-col justify-center py-4">
          <div
            className="relative mx-auto mb-6 flex h-[150px] w-[200px] items-end justify-center"
            aria-hidden="true"
          >
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 200 150"
              aria-hidden="true"
              focusable="false"
            >
              <path d={BLOB} className="fill-accent-wash" />
            </svg>
            <Vitonen size={120} state="idle" className="relative mb-3" />
            <svg
              className={`${MINI} top-1.5 left-2 h-6 w-6 [&_path]:fill-butter`}
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <g filter="url(#wobble)">
                <path d={STAR} />
              </g>
            </svg>
            <svg
              className={`${MINI} top-[26px] right-0.5 h-4 w-[34px] [&_path]:fill-none`}
              viewBox="0 0 34 16"
              aria-hidden="true"
              focusable="false"
            >
              <g filter="url(#wobble)">
                <path d={SQUIG} />
              </g>
            </svg>
          </div>

          <h1 className="text-[34px] leading-[1.08]">
            <span className="block">Get a 5.</span>
            <span className="block">Worry less.</span>
            <span className="relative inline-block font-medium text-accent italic">
              Party more.
              <svg
                className="absolute -bottom-1.5 left-0 h-2.5 w-full overflow-visible"
                viewBox="0 0 200 14"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  pathLength={1}
                  d={UNDERLINE}
                  className="fill-none stroke-accent [stroke-linecap:round] [stroke-width:2.5]"
                />
              </svg>
            </span>
          </h1>
          <p className="mt-4 max-w-[32ch] text-[17px] text-ink-2">
            Your courses, deadlines and homework, sorted before you finish your
            coffee.
          </p>
        </div>

        <div className="grid gap-3 pt-4 text-center">
          <Button href="/school" size="lg" block>
            Get started
          </Button>
          <p className="fine">Takes about 20 seconds.</p>
        </div>
      </div>
    </div>
  );
}
