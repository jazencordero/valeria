/**
 * The pencil doodle: a pencil and a squiggle, for "nothing written yet".
 * Source: prototype merged.html JS 3006 (`pencil` in the doodle set).
 *
 * Drawn exactly like the ten in `doodle.tsx` (M1-22): an 80x64 canvas, the
 * shared #wobble filter from <DoodleDefs />, and the same stroke and fill
 * rules. The rules are repeated here under the same `href`, so React keeps
 * one copy in <head> whichever doodle renders first. Kept in its own file so
 * this ticket does not change `doodle.tsx`.
 */

// Static drawing markup, copied as-is from the prototype. No user input.
const PENCIL =
  '<ellipse class="dd-sh" cx="40" cy="58" rx="22" ry="3"/><path class="dd-f" d="M18 44 L48 14 L56 22 L26 52 L15 55 Z"/><path d="M44 18 L52 26"/><path d="M50 50 q6 -4 12 0 q6 4 10 -2"/>';

// Same text as DOODLE_CSS in doodle.tsx; keep the two in step.
const DOODLE_CSS = `.doodle{display:block;overflow:visible}
.doodle path,.doodle rect,.doodle ellipse,.doodle circle{fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.doodle .dd-f{fill:var(--surface)}
.doodle .dd-f2{fill:var(--paper)}
.doodle .dd-sh{fill:var(--ink);stroke:none;opacity:.12}
.doodle .dd-dot{fill:var(--ink);stroke:none}`;

export type DoodlePencilProps = {
  /** Width in px. Height follows the 80x64 canvas. */
  size: number;
  className?: string;
};

/** A decorative line drawing. Always hidden from screen readers. */
export function DoodlePencil({ size, className }: DoodlePencilProps) {
  return (
    <>
      <style href="ready-doodle" precedence="default">
        {DOODLE_CSS}
      </style>
      <svg
        className={className ? `doodle ${className}` : "doodle"}
        viewBox="0 0 80 64"
        width={size}
        height={Math.round((size * 64) / 80)}
        aria-hidden="true"
        focusable="false"
        data-doodle="pencil"
      >
        <g filter="url(#wobble)" dangerouslySetInnerHTML={{ __html: PENCIL }} />
      </svg>
    </>
  );
}
