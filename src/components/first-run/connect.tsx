"use client";

/**
 * Connect, full (M5-08). Source: prototype main-flow.html HTML 1314-1337
 * (#v-connect), CSS 280-292 (.connect-cap, .connect-head, .lead, .perks,
 * .perk-ic, .p-butter/.p-mint/.p-sky) and JS 2264-2289 (applySchoolCopy,
 * connect).
 *
 * Three steps on one screen, one at a time:
 * - "intro": back arrow (to /school), the cap, "Connect {lms}", the lead,
 *   three perks with pastel icons, "Continue with {school}" and the privacy
 *   line. Continue shows "Signing in with {school}" for a moment (the cap
 *   thinks), then opens the way in.
 * - "qr": the way in. context/moodle/findings.md: the QR code from her
 *   profile is the way in that works (a pasted key does not exist for a new
 *   user; the laptop launch link is parked, M8-21). `QrScan` (M5-06) picks
 *   the right half for the device: the camera on a phone, a screenshot
 *   upload on a laptop (and as the phone's second way).
 *   Above it, her yes (M8-33), worded and built as in `PasteKey`: a box she
 *   must tick and "What does Ready keep?" (/privacy, new tab). The QR text
 *   goes to `qrAction` with `agree` "yes" only when it is ticked; the action
 *   refuses it otherwise ("Tick the box first.", shown by `QrScan`).
 * - "paste": the M1-35 paste-key form (`PasteKey`, unchanged), for people
 *   who already use the Moodle app. "Paste a key instead" is under the way
 *   in on both other steps.
 *
 * After the QR connects, `connected` runs: the real one
 * (`startFirstSyncAction`) starts the first sync and redirects to /sorting.
 * The paste form's own action does the same.
 *
 * Motion, as on /school so the two screens feel like one flow: the screen
 * and each step arrive from 16 px to the right with a fade; Back leaves
 * 16 px to the right. Calm: fades only, 150 ms. The fast test switch: none.
 * Each new step moves focus to its heading.
 *
 * Plain props, no fetching: `lmsName` and `schoolName` from the user's school
 * (src/lib/schools.ts, never a literal), `siteUrl` for the paste steps, the
 * three actions, and for previews and tests `initialStep`, `camera` and
 * `readImage` (passed through to `QrScan`).
 *
 * Cut (ticket): the prototype's single tap that just signs in is not
 * possible on the web; it is one tap plus showing the QR code.
 */
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useTransition } from "react";
import { PasteKey, type ConnectState } from "@/components/first-run/paste-key";
import { QrScan, type Pixels, type QrConnectResult } from "@/components/first-run/qr-scan";
import { Button } from "@/components/ui/button";
import { Vitonen } from "@/components/vitonen";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type ConnectStep = "intro" | "qr" | "paste";

export type ConnectProps = {
  /** Her school's name for Moodle, from `lmsNameOf(user)`. */
  lmsName: string;
  /** Her school's short name, as in "Aalto", for "Continue with Aalto". */
  schoolName: string;
  /** Her school's Moodle site, linked from the paste steps. */
  siteUrl: string | null;
  /** The paste-key form's action (`connectAction`). */
  pasteAction: (prev: ConnectState, formData: FormData) => Promise<ConnectState>;
  /** Gets the QR code's text and "yes" when she ticked the box (`connectQrAction`). */
  qrAction: (text: string, agree: string) => Promise<QrConnectResult>;
  /** After the QR connected: starts the first sync and goes on (`startFirstSyncAction`). */
  connected: () => Promise<void>;
  /** Where Back goes from the first step. Default /school. */
  backHref?: string;
  /** The step shown first. Previews and tests only. */
  initialStep?: ConnectStep;
  /** Passed to `QrScan`. */
  camera?: boolean;
  /** Passed to `QrScan`. */
  readImage?: (file: File) => Promise<Pixels>;
};

const SLIDE_PX = 16;
/** Longest a slide out is waited for: the base duration plus room. */
const SLIDE_FALLBACK_MS = 600;
/** How long "Signing in with …" shows before the way in opens (prototype: 700 ms). */
const SIGNING_IN_MS = { full: 700, calm: 400, instant: 0 } as const;

const BackIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="ic">
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
);

const PERKS = [
  {
    tone: "bg-butter",
    text: "Nothing to upload or drag in. We read it all.",
    icon: (
      <>
        <path d="M4.5 14v5h15v-5" />
        <path d="M12 4.5v10M8 11l4 4 4-4" />
      </>
    ),
  },
  {
    tone: "bg-mint",
    text: "Courses, deadlines and files, already sorted.",
    icon: (
      <>
        <path d="M5 7.5l1.5 1.5L9 6.5M5 15.5l1.5 1.5L9 14.5" />
        <path d="M12 8h7M12 16h7" />
      </>
    ),
  },
  {
    tone: "bg-sky",
    text: "Hand in from the chat, with your own tap.",
    icon: (
      <>
        <path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z" />
        <path d="M9 10.5l2 2 4-4" />
      </>
    ),
  },
] as const;

const FINE = "Ready reads your courses. Nothing is handed in without your tap.";

export function Connect({
  lmsName,
  schoolName,
  siteUrl,
  pasteAction,
  qrAction,
  connected,
  backHref = "/school",
  initialStep = "intro",
  camera,
  readImage,
}: ConnectProps) {
  const router = useRouter();
  const mode = useMotionMode();
  const [step, setStep] = useState<ConnectStep>(initialStep);
  const [signingIn, setSigningIn] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [going, startGoing] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const [moved, setMoved] = useState(false);
  const resolveSlide = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agreeId = useId();
  const [agreed, setAgreed] = useState(false);
  const sendQr = useCallback((text: string) => qrAction(text, agreed ? "yes" : ""), [qrAction, agreed]);

  // Next keeps a page she left alive but hidden (Activity) and shows it again
  // on browser back. Clear the slide out when it hides, so it comes back.
  useLayoutEffect(
    () => () => {
      resolveSlide.current = null;
      setLeaving(false);
      setSigningIn(false);
    },
    [],
  );

  useEffect(() => {
    router.prefetch(backHref);
  }, [router, backHref]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // A new step: its heading gets focus (not on first paint).
  useEffect(() => {
    if (!moved) return;
    stepRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [step, moved]);

  function goTo(next: ConnectStep) {
    setMoved(true);
    setError(null);
    setStep(next);
  }

  function onContinue() {
    if (signingIn || leaving) return;
    setSigningIn(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setSigningIn(false);
      goTo("qr");
    }, SIGNING_IN_MS[mode]);
  }

  function goBack() {
    if (leaving || going) return;
    if (step !== "intro") {
      goTo("intro");
      return;
    }
    const done = new Promise<void>((resolve) => {
      resolveSlide.current = resolve;
      // In case the animation's end is never reported (a tab in the background).
      setTimeout(resolve, mode === "instant" ? 0 : SLIDE_FALLBACK_MS);
    });
    setLeaving(true);
    void done.then(() => router.push(backHref));
  }

  function onConnected() {
    startGoing(async () => {
      try {
        await connected();
      } catch {
        setError("Something went wrong on our side. Try again in a minute.");
      }
    });
  }

  const move = mode === "full" ? SLIDE_PX : 0;
  const transition =
    mode === "instant"
      ? { duration: 0 }
      : mode === "calm"
        ? { duration: calmDuration, ease: "linear" as const }
        : { duration: duration.base, ease: ease.out };

  const backRow = (
    <div className="-ml-3 flex min-h-11 items-center">
      <Button variant="icon" aria-label="Back" onClick={goBack}>
        {BackIcon}
      </Button>
    </div>
  );

  const pasteInstead = (
    <Button variant="text" block onClick={() => goTo("paste")} disabled={signingIn || going}>
      Paste a key instead
    </Button>
  );

  const capState = signingIn || going ? "thinking" : "idle";
  const column =
    "mx-auto flex w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))]";
  const foot = "pb-[max(28px,env(safe-area-inset-bottom,0px))]";

  let body;
  if (step === "paste") {
    body = (
      <>
        <div className={column}>{backRow}</div>
        <PasteKey lmsName={lmsName} siteUrl={siteUrl} action={pasteAction} />
      </>
    );
  } else {
    body = (
      <div className={`${column} ${foot} min-h-dvh`}>
        {backRow}
        <div className="mt-2">
          <Vitonen size={64} state={capState} />
        </div>
        <h1 tabIndex={-1} className="type-h26 mt-3">
          Connect {lmsName}
        </h1>
        <p className="mt-2.5 max-w-[30ch] text-[17px] text-ink-2">Then you can chat your way to handing things in.</p>

        {step === "intro" ? (
          <ul className="mt-7 grid list-none gap-3.5">
            {PERKS.map((perk) => (
              <li key={perk.text} className="grid grid-cols-[36px_1fr] items-center gap-x-3.5 text-[15px] text-ink">
                <span aria-hidden="true" className={`grid size-9 place-items-center rounded-full text-ink ${perk.tone}`}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="ic !size-[18px]">
                    {perk.icon}
                  </svg>
                </span>
                <span>{perk.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-7 grid gap-5">
            <div className="grid gap-1">
              <label
                htmlFor={agreeId}
                className="grid min-h-11 grid-cols-[20px_1fr] items-start gap-x-3 text-[14px] text-ink"
              >
                <input
                  id={agreeId}
                  name="agree"
                  value="yes"
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 size-5"
                />
                <span>
                  Ready will keep my {lmsName} key, encrypted, to read my courses and to hand in only when I tap.
                </span>
              </label>
              <Link
                href="/privacy"
                target="_blank"
                rel="noopener"
                className="ml-8 inline-flex min-h-11 items-center justify-self-start text-[14px] font-medium text-ink-2 underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-accent"
              >
                What does Ready keep?
              </Link>
            </div>
            <QrScan
              lmsName={lmsName}
              action={sendQr}
              onConnected={onConnected}
              camera={camera}
              readImage={readImage}
            />
          </div>
        )}

        <div className="flex-1" />

        <div className="mt-8 grid gap-2 text-center">
          {step === "intro" && (
            <Button
              size="lg"
              block
              loading={signingIn}
              loadingLabel={`Signing in with ${schoolName}`}
              aria-label={signingIn ? `Signing in with ${schoolName}` : undefined}
              onClick={onContinue}
            >
              Continue with {schoolName}
            </Button>
          )}
          {pasteInstead}
          <p role="alert" className="text-[14px] text-ink empty:hidden">
            {error}
          </p>
          <p className="text-[13px] text-ink-3">{FINE}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh overflow-x-clip min-[700px]:bg-paper">
      <motion.div
        initial={{ opacity: 0, x: move }}
        animate={leaving ? { opacity: 0, x: move } : { opacity: 1, x: 0 }}
        transition={transition}
        onAnimationComplete={() => {
          if (leaving) resolveSlide.current?.();
        }}
      >
        <motion.div
          key={step}
          ref={stepRef}
          initial={moved ? { opacity: 0, x: move } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={transition}
        >
          {body}
        </motion.div>
      </motion.div>
    </div>
  );
}
