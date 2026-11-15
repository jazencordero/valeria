"use client";

/**
 * Never miss one: the sky card on Home, its sheet and the done row.
 * Source: prototype main-flow.html HTML 1515-1530 (card, done row) and 1726-1755
 * (sheet), CSS 377-380 (.sync-card) and 814-836 (switches, calendar chips, email
 * field), JS 4599-4692 (switches, Turn on, the done row).
 *
 * Plain props, no fetching, so it can be previewed and tested alone. M7-04 puts it
 * on Home and passes the server's answers:
 * - `dateCount`: how many dates the calendar link lists now.
 * - `reminders`: which reminder the server can send. "push" once M7-06 shipped and
 *   the app is installed, "email" only once M7-08 decided to buy a domain (it has
 *   not: pass "push" or "none" until then), "none" hides the second switch.
 * - `subscribeLinks`: where each calendar app subscribes, if already known. The raw
 *   link exists only when `createFeed` makes it, so usually `onTurnOn` returns it
 *   as `subscribeUrl` instead.
 * - `on`: what is on already; when anything is, the done row shows instead of the card.
 *
 * Turning the calendar on opens the provider's subscribe page in a new tab. The tab
 * is opened inside the click (pop-up blockers allow only that), blank when the link
 * is not known yet, and pointed at the link once `onTurnOn` returns it.
 *
 * "Not now" hides the card for 30 days. That choice belongs to this browser, so it
 * lives in localStorage with a timestamp (`NOT_NOW_KEY`), not on the server.
 */
import { AnimatePresence, motion } from "motion/react";
import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { FeedProvider } from "@/server/calendar/feed";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { DoneRow } from "@/components/ui/done-row";
import { Sheet } from "@/components/ui/sheet";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";

export type ReminderChannel = "push" | "email" | "none";

/** What she turned on. */
export type NeverMissChoice = {
  /** The calendar app she picked, or null when the calendar switch is off. */
  calendar: FeedProvider | null;
  /** How reminders reach her, or null when they are off. */
  reminders: "push" | "email" | null;
  /** Her personal email, when `reminders` is "email". */
  email?: string;
};

export type NeverMissResult = { subscribeUrl?: string } | void;

export type NeverMissProps = {
  dateCount: number;
  reminders: ReminderChannel;
  /** Her school's short name, from `schoolOf(user).name`, for "not the Aalto one". */
  schoolName: string;
  subscribeLinks?: Partial<Record<FeedProvider, string>>;
  /** What is on already. Anything on shows the done row. */
  on?: NeverMissChoice | null;
  /** Saves the choice. Resolve with the subscribe link when the calendar is on. */
  onTurnOn: (choice: NeverMissChoice) => Promise<NeverMissResult>;
  onDismiss?: () => void;
  /** The clock, for "Not now". Defaults to Date.now. */
  now?: () => number;
  /** Starting switch positions (both on, as in the prototype). */
  initialCalendar?: boolean;
  initialReminders?: boolean;
  /** Open the sheet on mount (preview pages). */
  defaultOpen?: boolean;
  className?: string;
};

export const PROVIDERS: { id: FeedProvider; name: string }[] = [
  { id: "google", name: "Google" },
  { id: "apple", name: "Apple" },
  { id: "outlook", name: "Outlook" },
];

const NAME: Record<FeedProvider, string> = { google: "Google", apple: "Apple", outlook: "Outlook" };

// ---------- "Not now" ----------

export const NOT_NOW_KEY = "ready.never-miss.not-now-at";
export const NOT_NOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a stored "Not now" timestamp still hides the card at `nowMs`. */
export function isSnoozed(stored: string | null, nowMs: number): boolean {
  if (!stored) return false;
  const at = Number(stored);
  if (!Number.isFinite(at)) return false;
  return nowMs >= at && nowMs - at < NOT_NOW_MS;
}

const listeners = new Set<() => void>();

function subscribeNotNow(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readNotNow(): string | null {
  try {
    return window.localStorage.getItem(NOT_NOW_KEY);
  } catch {
    return null;
  }
}

function writeNotNow(ms: number) {
  try {
    window.localStorage.setItem(NOT_NOW_KEY, String(ms));
  } catch {
    // Private mode or blocked storage: the card hides for this visit only.
  }
  listeners.forEach((l) => l());
}

// ---------- Copy ----------

export function countLine(n: number): string {
  if (n <= 0) return "No dates yet. New ones as they appear.";
  return `${n} ${n === 1 ? "date" : "dates"} now, new ones as they appear.`;
}

export function doneTitle(choice: NeverMissChoice): string {
  if (choice.calendar && choice.reminders) return "Calendar and reminders are on";
  return choice.calendar ? "Calendar is on" : "Reminders are on";
}

export function doneMeta(choice: NeverMissChoice, dateCount: number): string {
  const parts: string[] = [];
  if (choice.calendar) {
    const cal = `${NAME[choice.calendar]} Calendar`;
    parts.push(dateCount > 0 ? `${dateCount} ${dateCount === 1 ? "date" : "dates"} in ${cal}` : cal);
  }
  if (choice.reminders === "email" && choice.email) parts.push(`reminders to ${choice.email}`);
  else if (choice.reminders === "push") parts.push("reminders on this phone");
  return parts.join(" · ");
}

function cardText(reminders: ReminderChannel): string {
  if (reminders === "email") return "Deadlines in your calendar. Reminders to your personal email.";
  if (reminders === "none") return "Deadlines in your calendar.";
  return "Deadlines in your calendar. Reminders on your phone.";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

function isOn(choice: NeverMissChoice | null | undefined): choice is NeverMissChoice {
  return !!choice && (choice.calendar !== null || choice.reminders !== null);
}

// ---------- Pieces ----------

const MIN_WORK_MS = 500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Switch({
  on,
  onToggle,
  labelledBy,
  disabled,
  buttonRef,
}: {
  on: boolean;
  onToggle: () => void;
  labelledBy: string;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      className="group grid h-11 w-[52px] flex-none place-items-center rounded-full border-0 bg-transparent p-0"
    >
      <span className="relative h-[26px] w-11 rounded-full bg-line transition-colors duration-quick ease-out group-aria-checked:bg-ink">
        <span className="absolute top-[3px] left-[3px] size-5 rounded-full bg-surface shadow-[var(--shadow-card)] transition-transform duration-base ease-out group-aria-checked:translate-x-[18px]" />
      </span>
    </button>
  );
}

function More({ open, mode, children }: { open: boolean; mode: MotionMode; children: ReactNode }) {
  const d = mode === "instant" ? 0 : mode === "calm" ? calmDuration : duration.base;
  const t = { duration: d, ease: ease.out };
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="more"
          className="overflow-hidden"
          initial={mode === "full" ? { height: 0, opacity: 0 } : { opacity: 0 }}
          animate={mode === "full" ? { height: "auto", opacity: 1 } : { opacity: 1 }}
          exit={mode === "full" ? { height: 0, opacity: 0 } : { opacity: 0 }}
          transition={t}
        >
          <div className="pt-2">{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

type Phase = "idle" | "working" | "finishing";

function Fill({ phase, mode }: { phase: Phase; mode: MotionMode }) {
  // Sweeps to 85% over the 500 ms minimum, creeps towards 96% while the server is
  // still out, and fills the rest when it answers.
  let animate: { scaleX: number | number[] };
  let transition: object;
  if (phase === "working" && mode === "full") {
    animate = { scaleX: [0, 0.85, 0.96] };
    transition = { duration: 8, times: [0, MIN_WORK_MS / 8000, 1], ease: ["linear", "easeOut"] };
  } else if (phase === "working" || phase === "finishing") {
    animate = { scaleX: 1 };
    transition = { duration: phase === "finishing" && mode === "full" ? 0.15 : 0, ease: "linear" };
  } else {
    animate = { scaleX: 0 };
    transition = { duration: 0 };
  }
  return (
    <motion.span
      aria-hidden="true"
      data-testid="never-miss-fill"
      data-phase={phase}
      className="pointer-events-none absolute inset-0 origin-left rounded-full bg-[var(--btn-ink)] opacity-20"
      initial={false}
      animate={animate}
      transition={transition}
    />
  );
}

// ---------- The component ----------

export function NeverMiss({
  dateCount,
  reminders,
  schoolName,
  subscribeLinks,
  on,
  onTurnOn,
  onDismiss,
  now = Date.now,
  initialCalendar = true,
  initialReminders = true,
  defaultOpen = false,
  className = "",
}: NeverMissProps) {
  const mode = useMotionMode();
  const ids = useId();
  const calLabel = `${ids}-cal`;
  const remLabel = `${ids}-rem`;
  const emailId = `${ids}-email`;
  const errId = `${ids}-err`;
  const calSwitch = useRef<HTMLButtonElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Read on the client only: the server renders the card (and must not read the clock).
  const snoozed = useSyncExternalStore(
    subscribeNotNow,
    () => isSnoozed(readNotNow(), now()),
    () => false,
  );
  const [notNow, setNotNow] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [cal, setCal] = useState(initialCalendar);
  const [rem, setRem] = useState(initialReminders);
  const [provider, setProvider] = useState<FeedProvider>("google");
  const [email, setEmail] = useState("");
  const [emailErr, setEmailErr] = useState(false);
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [turnedOn, setTurnedOn] = useState<NeverMissChoice | null>(null);

  const offersReminders = reminders !== "none";
  const remOn = offersReminders && rem;
  const busy = phase !== "idle";
  const done = turnedOn ?? (isOn(on) ? on : null);
  const hidden = !done && (notNow || snoozed);

  const toggleRem = () => {
    if (rem) setEmailErr(false);
    setRem(!rem);
  };

  const dismiss = () => {
    setNotNow(true);
    writeNotNow(now());
    onDismiss?.();
  };

  const turnOn = async () => {
    if (busy) return;
    if (!cal && !remOn) {
      setOpen(false);
      return;
    }
    const channel = remOn ? (reminders as "push" | "email") : null;
    if (channel === "email" && !isEmail(email)) {
      setEmailErr(true);
      emailRef.current?.focus();
      return;
    }
    setEmailErr(false);
    setFailed(false);
    const choice: NeverMissChoice = {
      calendar: cal ? provider : null,
      reminders: channel,
      ...(channel === "email" ? { email: email.trim() } : {}),
    };

    // Open the tab now, inside the click, so a pop-up blocker lets it through.
    const known = cal ? subscribeLinks?.[provider] : undefined;
    let tab: Window | null = null;
    if (cal) {
      if (known) window.open(known, "_blank", "noopener");
      else {
        tab = window.open("about:blank", "_blank");
        if (tab) {
          try {
            tab.opener = null;
          } catch {
            // Some browsers make opener read-only; the tab is ours either way.
          }
        }
      }
    }

    setPhase("working");
    try {
      const [result] = await Promise.all([
        onTurnOn(choice),
        wait(mode === "instant" ? 0 : MIN_WORK_MS),
      ]);
      const url = result && typeof result === "object" ? result.subscribeUrl : undefined;
      if (tab) {
        if (url) tab.location.href = url;
        else tab.close();
      }
      setPhase("finishing");
      if (mode === "full") await wait(150);
      setPhase("idle");
      setOpen(false);
      setTurnedOn(choice);
    } catch {
      tab?.close();
      setPhase("idle");
      setFailed(true);
    }
  };

  const fadeOut = mode === "instant" ? 0 : mode === "calm" ? calmDuration : 0.14;
  const riseIn = mode === "instant" ? 0 : mode === "calm" ? calmDuration : 0.24;
  const label = !cal && !remOn ? "Close" : busy ? "Turning on" : "Turn on";

  return (
    <div className={className} data-testid="never-miss">
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.div
            key="done"
            initial={mode === "full" ? { opacity: 0, y: 4 } : { opacity: 0 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: riseIn, ease: ease.out }}
          >
            <DoneRow
              title={<span data-testid="never-miss-done-title">{doneTitle(done)}</span>}
              meta={doneMeta(done, dateCount) || undefined}
            />
          </motion.div>
        ) : hidden ? null : (
          <motion.div
            key="card"
            exit={{ opacity: 0, transition: { duration: fadeOut, ease: "linear" } }}
            className="rounded-[20px] bg-sky p-4"
            data-testid="never-miss-card"
          >
            <p className="text-[15px] font-semibold">Never miss one</p>
            <p className="mt-1 text-[13px] ink-2">{cardText(reminders)}</p>
            <div className="mt-[14px] flex gap-2">
              <Button variant="secondary" onClick={() => setOpen(true)}>
                Set up
              </Button>
              <Button variant="text" onClick={dismiss}>
                Not now
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        locked={busy}
        title="Never miss one"
        initialFocus={calSwitch}
        data-testid="never-miss-sheet"
      >
        <div className="mt-4 border-t border-line py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-medium" id={calLabel}>
                Add deadlines to my calendar
              </p>
              <p className="mt-0.5 text-[13px] ink-3">{countLine(dateCount)}</p>
            </div>
            <Switch
              on={cal}
              onToggle={() => setCal(!cal)}
              labelledBy={calLabel}
              disabled={busy}
              buttonRef={calSwitch}
            />
          </div>
          <More open={cal} mode={mode}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Calendar">
              {PROVIDERS.map((p) => (
                <Chip
                  key={p.id}
                  kind="choice"
                  pressed={provider === p.id}
                  onPressedChange={() => setProvider(p.id)}
                  disabled={busy}
                >
                  {p.name}
                </Chip>
              ))}
            </div>
          </More>
        </div>

        {offersReminders ? (
          <div className="border-t border-line py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-medium" id={remLabel}>
                  {reminders === "email" ? "Remind me by email" : "Remind me"}
                </p>
                <p className="mt-0.5 text-[13px] ink-3">The day before and 3 hours before.</p>
              </div>
              <Switch on={rem} onToggle={toggleRem} labelledBy={remLabel} disabled={busy} />
            </div>
            <More open={rem} mode={mode}>
              {reminders === "email" ? (
                <>
                  <label className="sr-only" htmlFor={emailId}>
                    Personal email for reminders
                  </label>
                  <input
                    ref={emailRef}
                    id={emailId}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    readOnly={busy}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailErr) setEmailErr(false);
                    }}
                    placeholder={`Your personal email, not the ${schoolName} one`}
                    aria-invalid={emailErr || undefined}
                    aria-describedby={emailErr ? errId : undefined}
                    className={
                      "h-12 w-full rounded-2xl border border-solid border-line bg-paper px-4 text-[16px] text-ink " +
                      "placeholder:text-ink-3 focus-visible:border-ink-3 focus-visible:outline-none " +
                      "aria-invalid:border-due"
                    }
                  />
                  {emailErr ? (
                    <p id={errId} role="alert" className="mt-2 text-[13px] text-due">
                      Add an email, or switch reminders off.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-[13px] ink-2">Notifications on this phone.</p>
              )}
            </More>
          </div>
        ) : null}

        <Button
          block
          size="lg"
          className="mt-2 overflow-hidden"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => void turnOn()}
          data-testid="never-miss-submit"
        >
          <Fill phase={phase} mode={mode} />
          <span className="relative">{label}</span>
        </Button>
        {failed ? (
          <p role="alert" className="mt-3 text-center text-[13px] text-due">
            That did not work. Try again.
          </p>
        ) : null}
      </Sheet>
    </div>
  );
}
