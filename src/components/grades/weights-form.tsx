"use client";

/**
 * Weights form (M6-04): she tells Ready how much each piece of a course
 * counts, in a Sheet. Plain look until M8-04 (not in the prototype).
 *
 * - One percent field per grade item, labelled with the item's name, filled
 *   in with the weight we already have (Moodle's or hers).
 * - "Add a piece that is not in <LMS> yet" adds a row with a name and a
 *   percent, for example the exam. Added rows can be removed again.
 * - A running total, announced politely as it changes. Save stays disabled
 *   until every field holds a number from 0 to 100 (one decimal at most, a
 *   comma works too), every added piece has a name, and the total is exactly
 *   100. Percents are summed in tenths, so 33.3 + 33.3 + 33.4 is 100 and
 *   33.3 three times is not.
 * - Errors: a field with a bad number gets `aria-invalid` and its message
 *   through `aria-describedby`; what still blocks Save is the hint under the
 *   total, which also describes the Save button; a failed save is announced in
 *   a `role="alert"` line.
 *
 * No fetching. `action` is `saveWeightsAction` from
 * src/app/(app)/grades/actions.ts, passed in by a server page; tests pass a
 * fake. Rows are sent as percents; the server stores fractions.
 *
 * `NeedsWeightsCard` is the card a course with `needs_weights` shows: one
 * line and a button that opens this sheet.
 */
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

/** A grade item as the form shows it. `weight` is a fraction (0.2 is 20 %), null when unknown. */
export type WeightsFormItem = { id: string; name: string; weight: number | null };

/** One row the form sends: a weight for an item she has, or a piece she adds. Percent 0 to 100. */
export type WeightRow =
  | { kind: "item"; id: string; percent: number }
  | { kind: "new"; name: string; percent: number };

export type SaveWeightsResult = { ok: true } | { ok: false; message: string };

export type SaveWeightsAction = (courseId: string, rows: WeightRow[]) => Promise<SaveWeightsResult>;

export type WeightsFormProps = {
  open: boolean;
  onClose: () => void;
  course: { id: string; name: string };
  /** Her grade items in this course, in report order. */
  items: WeightsFormItem[];
  /** What her school calls its Moodle (`lmsNameOf(user)`). */
  lmsName: string;
  action: SaveWeightsAction;
  /** Called once the weights are saved, before the sheet closes. */
  onSaved?: () => void;
};

const NAME_MAX = 120;

const INPUT =
  "min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 text-[16px] text-ink " +
  "aria-invalid:border-ink";
const LABEL = "mb-1.5 block text-[14px] font-medium text-ink";

type Line =
  | { key: string; kind: "item"; id: string; name: string; value: string }
  | { key: string; kind: "new"; name: string; value: string };

type Parsed = number | "empty" | "bad";

/** A typed percent as tenths (12,5 is 125), "empty", or "bad". */
export function parsePercent(raw: string): Parsed {
  const s = raw.trim().replace(",", ".");
  if (s === "") return "empty";
  if (!/^\d{1,3}(?:\.\d)?$/.test(s)) return "bad";
  const tenths = Math.round(Number(s) * 10);
  return tenths <= 1000 ? tenths : "bad";
}

/** Tenths as a percent for people: 125 is "12.5", 200 is "20". */
export function formatTenths(tenths: number): string {
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

function startValue(weight: number | null): string {
  if (weight == null || !Number.isFinite(weight) || weight < 0) return "";
  return formatTenths(Math.round(weight * 1000));
}

const BAD = "Type a number from 0 to 100, with at most one decimal.";
const NO_NAME = "Give this piece a name.";

export function WeightsForm(props: WeightsFormProps) {
  const { open, onClose } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} locked={busy} title="How much each piece counts" data-testid="weights-form">
      <WeightsFormBody {...props} onBusy={setBusy} />
    </Sheet>
  );
}

function WeightsFormBody({
  onClose,
  course,
  items,
  lmsName,
  action,
  onSaved,
  onBusy,
}: WeightsFormProps & { onBusy: (busy: boolean) => void }) {
  const uid = useId();
  const nextKey = useRef(0);
  const [lines, setLines] = useState<Line[]>(() =>
    items.map((it) => ({ key: `item-${it.id}`, kind: "item", id: it.id, name: it.name, value: startValue(it.weight) })),
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  useEffect(() => onBusy(pending), [pending, onBusy]);

  // Focus the name field of a piece she just added.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!focusKey) return;
    formRef.current?.querySelector<HTMLInputElement>(`[data-name-for="${focusKey}"]`)?.focus();
  }, [focusKey]);

  const parsed = lines.map((l) => parsePercent(l.value));
  const total = parsed.reduce<number>((sum, p) => (typeof p === "number" ? sum + p : sum), 0);
  const anyBad = parsed.includes("bad");
  const anyEmpty = parsed.includes("empty");
  const anyNameless = lines.some((l) => l.kind === "new" && l.name.trim() === "");
  const canSave = lines.length > 0 && !anyBad && !anyEmpty && !anyNameless && total === 1000;

  let hint: string;
  if (lines.length === 0) hint = "Add the pieces of this course first.";
  else if (anyBad) hint = "Fix the marked numbers first.";
  else if (total < 1000) hint = `${formatTenths(1000 - total)}% still to place.`;
  else if (total > 1000) hint = `${formatTenths(total - 1000)}% too much. The total needs to be 100%.`;
  else if (anyEmpty) hint = "Fill in every piece. 0 is fine.";
  else if (anyNameless) hint = "Give every added piece a name.";
  else hint = "Adds up to 100%.";

  const fieldId = (key: string, part: "percent" | "name") => `${uid}-${key}-${part}`;
  const update = (key: string, patch: Partial<Pick<Line, "name" | "value">>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? ({ ...l, ...patch } as Line) : l)));

  function addPiece() {
    const key = `new-${nextKey.current++}`;
    setLines((ls) => [...ls, { key, kind: "new", name: "", value: "" }]);
    setFocusKey(key);
  }

  function removePiece(key: string) {
    const at = lines.findIndex((l) => l.key === key);
    setLines((ls) => ls.filter((l) => l.key !== key));
    // Focus stays in the sheet: the previous row's percent, else the add button.
    const before = lines[at - 1];
    const target = before ? fieldId(before.key, "percent") : `${uid}-add`;
    requestAnimationFrame(() => document.getElementById(target)?.focus());
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSave || pending) return;
    const rows: WeightRow[] = lines.map((l, i) => {
      const percent = (parsed[i] as number) / 10;
      return l.kind === "item" ? { kind: "item", id: l.id, percent } : { kind: "new", name: l.name.trim(), percent };
    });
    setError("");
    startTransition(async () => {
      const result = await action(course.id, rows);
      if (result.ok) {
        onSaved?.();
        onClose();
      } else {
        setError(result.message);
      }
    });
  }

  const totalId = `${uid}-total`;

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="mt-1 space-y-5">
      <p className="text-[15px] text-ink-2">{course.name}</p>

      <p role="alert" className="text-[14px] text-ink empty:hidden">
        {error}
      </p>

      <ul className="space-y-4">
        {lines.map((l, i) => {
          const p = parsed[i];
          const percentId = fieldId(l.key, "percent");
          const errId = `${percentId}-error`;
          const bad = p === "bad";
          const percentInput = (
            <div className="flex items-center gap-2">
              <input
                id={percentId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={l.value}
                onChange={(e) => update(l.key, { value: e.target.value })}
                className={INPUT + " max-w-28 text-right tabular-nums"}
                aria-invalid={bad || undefined}
                aria-describedby={bad ? errId : undefined}
                {...(l.kind === "new" ? { "aria-label": `${l.name.trim() || "New piece"} percent` } : {})}
              />
              <span aria-hidden="true" className="text-[15px] text-ink-2">
                %
              </span>
            </div>
          );
          const percentError = bad ? (
            <p id={errId} className="mt-1.5 text-[14px] text-ink">
              {BAD}
            </p>
          ) : null;

          if (l.kind === "item") {
            return (
              <li key={l.key}>
                <label htmlFor={percentId} className={LABEL}>
                  {l.name}
                </label>
                {percentInput}
                {percentError}
              </li>
            );
          }

          const nameId = fieldId(l.key, "name");
          const nameErrId = `${nameId}-error`;
          const nameless = touched.has(l.key) && l.name.trim() === "";
          return (
            <li key={l.key} className="rounded-2xl border border-solid border-line p-3">
              <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                <div>
                  <label htmlFor={nameId} className={LABEL}>
                    Name
                  </label>
                  <input
                    id={nameId}
                    data-name-for={l.key}
                    type="text"
                    autoComplete="off"
                    maxLength={NAME_MAX}
                    placeholder="Exam"
                    value={l.name}
                    onChange={(e) => update(l.key, { name: e.target.value })}
                    onBlur={() => setTouched((t) => new Set(t).add(l.key))}
                    className={INPUT}
                    aria-invalid={nameless || undefined}
                    aria-describedby={nameless ? nameErrId : undefined}
                  />
                </div>
                <div>
                  {/* The input is named "<name> percent" by aria-label; this is the visual label. */}
                  <span className={LABEL} aria-hidden="true">
                    Percent
                  </span>
                  {percentInput}
                </div>
              </div>
              {nameless ? (
                <p id={nameErrId} className="mt-1.5 text-[14px] text-ink">
                  {NO_NAME}
                </p>
              ) : null}
              {percentError}
              <Button
                variant="text"
                size="sm"
                className="mt-1 -ml-4"
                onClick={() => removePiece(l.key)}
                aria-label={`Remove ${l.name.trim() || "this piece"}`}
                disabled={pending}
              >
                Remove
              </Button>
            </li>
          );
        })}
      </ul>

      <Button id={`${uid}-add`} variant="secondary" size="sm" onClick={addPiece} disabled={pending}>
        Add a piece that is not in {lmsName} yet
      </Button>

      <div id={totalId} role="status" className="border-t border-solid border-line pt-4">
        <p className="text-[17px] font-semibold text-ink tabular-nums">Total {formatTenths(total)}%</p>
        <p className="mt-1 text-[14px] text-ink-2">{hint}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canSave} loading={pending} loadingLabel="Saving" aria-describedby={totalId}>
          Save
        </Button>
        <Button variant="text" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export type NeedsWeightsCardProps = Omit<WeightsFormProps, "open" | "onClose">;

/** The card a course with `needs_weights` shows; its button opens the weights sheet. */
export function NeedsWeightsCard(props: NeedsWeightsCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-[20px] border border-solid border-line bg-surface p-5" data-testid="needs-weights">
      <p className="text-[16px] text-ink">Add the weights from the syllabus to see where this is heading.</p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={() => setOpen(true)}>
        Add the weights
      </Button>
      <WeightsForm {...props} open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
