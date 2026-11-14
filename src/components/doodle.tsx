/**
 * Hand-drawn doodles: our own line drawings, all sharing one wobble filter.
 * Copied from the prototype (main-flow.html JS 2691-2702, CSS 638-643, HTML 1757).
 *
 * Put <DoodleDefs /> once on any page that shows doodles; it holds the
 * shared #wobble filter. The stroke and fill rules come along with every
 * <Doodle> and React hoists them into <head> once.
 */

export const DOODLE_NAMES = [
  "basic",
  "cloze",
  "explain",
  "mcq",
  "done",
  "sun",
  "cup",
  "anki",
  "bite",
  "crown",
] as const;

export type DoodleName = (typeof DOODLE_NAMES)[number];

// Static drawing markup, copied as-is from the prototype. No user input.
const DOODLES: Record<DoodleName, string> = {
  basic: '<ellipse class="dd-sh" cx="60" cy="72" rx="28" ry="4"/><rect class="dd-f2" x="38" y="18" width="40" height="48" rx="6" transform="rotate(-9 58 42)"/><rect class="dd-f" x="44" y="15" width="40" height="49" rx="6"/><path d="M58 31 q1 -7 7 -7 q7 0 6.5 7 q-0.5 5 -6.5 6.5 v5"/><circle class="dd-dot" cx="65" cy="51" r="1.8"/>',
  cloze: '<ellipse class="dd-sh" cx="60" cy="70" rx="34" ry="4"/><path d="M16 30 h20 M16 46 h12"/><rect class="dd-f" x="42" y="21" width="34" height="16" rx="4"/><path d="M82 30 h22 M34 46 h40 M80 46 h20 M16 60 h36"/><path d="M60 25 v8"/>',
  explain: '<ellipse class="dd-sh" cx="60" cy="72" rx="32" ry="4"/><path class="dd-f" d="M18 16 h50 q6 0 6 6 v20 q0 6 -6 6 h-30 l-10 9 v-9 h-10 q-6 0 -6 -6 v-20 q0 -6 6 -6 z"/><circle class="dd-dot" cx="32" cy="32" r="2.2"/><circle class="dd-dot" cx="43" cy="32" r="2.2"/><circle class="dd-dot" cx="54" cy="32" r="2.2"/><path class="dd-f2" d="M64 38 h36 q5 0 5 5 v12 q0 5 -5 5 h-6 v8 l-9 -8 h-21 q-5 0 -5 -5 v-12 q0 -5 5 -5 z"/>',
  mcq: '<ellipse class="dd-sh" cx="60" cy="72" rx="26" ry="4"/><rect class="dd-f" x="38" y="12" width="44" height="56" rx="6"/><path d="M52 8 h16 v8 h-16 z"/><rect class="dd-f2" x="45" y="26" width="8" height="8" rx="2"/><path d="M46 30 l3 3 l6 -7"/><path d="M58 30 h16"/><rect class="dd-f2" x="45" y="42" width="8" height="8" rx="2"/><path d="M58 46 h16"/>',
  done: '<ellipse class="dd-sh" cx="40" cy="58" rx="24" ry="3"/><path class="dd-f" d="M14 34 h52 l-6 18 h-40 z"/><path d="M26 34 l4 -8 h20 l4 8"/><path d="M40 8 v8 M36 12 h8"/><path d="M58 14 v5 M55.5 16.5 h5"/>',
  sun: '<ellipse class="dd-sh" cx="40" cy="58" rx="24" ry="3"/><circle class="dd-f" cx="40" cy="28" r="9"/><path d="M40 10 v4 M40 42 v4 M22 28 h4 M54 28 h4 M27 15 l3 3 M50 38 l3 3 M53 15 l-3 3 M30 38 l-3 3"/><path d="M14 52 h52"/>',
  cup: '<ellipse class="dd-sh" cx="40" cy="58" rx="20" ry="3"/><path class="dd-f" d="M24 28 h28 v12 q0 12 -14 12 q-14 0 -14 -12 z"/><path d="M52 32 q9 0 9 6 q0 6 -9 6"/><path d="M32 12 q-3 4 0 8 q3 4 0 8 M43 12 q-3 4 0 8"/>',
  anki: '<ellipse class="dd-sh" cx="40" cy="58" rx="22" ry="3"/><path class="dd-f" d="M22 30 h36 v24 h-36 z"/><path d="M22 30 l6 -8 h24 l6 8"/><path d="M40 8 v18 M33 19 l7 7 7 -7"/>',
  bite: '<ellipse class="dd-sh" cx="40" cy="58" rx="22" ry="3"/><circle class="dd-f" cx="40" cy="32" r="19"/><path d="M40 32 V18 M40 32 l9 6"/><path class="dd-f2" d="M57 14 a19 19 0 0 1 2 14 l-19 4 z"/><path d="M36 8 h8"/>',
  crown: '<ellipse class="dd-sh" cx="40" cy="58" rx="22" ry="3"/><path class="dd-f" d="M18 46 l-4 -24 l14 10 l12 -18 l12 18 l14 -10 l-4 24 z"/><path d="M18 52 h44"/><circle class="dd-dot" cx="40" cy="36" r="2.4"/>',
};

// Small drawings sit on an 80x64 canvas, card-type drawings on 120x80.
const SMALL = new Set<DoodleName>(["anki", "done", "sun", "cup", "bite", "crown"]);

const DOODLE_CSS = `.doodle{display:block;overflow:visible}
.doodle path,.doodle rect,.doodle ellipse,.doodle circle{fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.doodle .dd-f{fill:var(--surface)}
.doodle .dd-f2{fill:var(--paper)}
.doodle .dd-sh{fill:var(--ink);stroke:none;opacity:.12}
.doodle .dd-dot{fill:var(--ink);stroke:none}`;

/** The shared wobble filter. Render once per page that shows doodles. */
export function DoodleDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id="wobble">
        <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="7" />
        <feDisplacementMap in="SourceGraphic" scale="2" />
      </filter>
    </svg>
  );
}

export type DoodleProps = {
  name: DoodleName;
  /** Width in px. Height follows the drawing's own shape. */
  size: number;
  className?: string;
};

/** A decorative line drawing. Always hidden from screen readers. */
export function Doodle({ name, size, className }: DoodleProps) {
  const small = SMALL.has(name);
  const height = Math.round(size * (small ? 64 / 80 : 80 / 120));
  return (
    <>
      <style href="ready-doodle" precedence="default">
        {DOODLE_CSS}
      </style>
      <svg
        className={className ? `doodle ${className}` : "doodle"}
        viewBox={small ? "0 0 80 64" : "0 0 120 80"}
        width={size}
        height={height}
        aria-hidden="true"
        focusable="false"
        data-doodle={name}
      >
        <g filter="url(#wobble)" dangerouslySetInnerHTML={{ __html: DOODLES[name] }} />
      </svg>
    </>
  );
}
