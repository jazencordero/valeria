"use client";

/**
 * Paste your key (M1-35): the thin Connect screen's body. The cap, "Connect
 * {lms}", three steps, a password field, Connect with a loading state, and
 * the privacy line. Source: prototype main-flow.html HTML 1314-1337
 * (#v-connect: .connect-cap, .connect-head, .start-foot, .fine) and CSS
 * 280-285. The perks list and "Continue with Aalto" are replaced by the steps
 * and the field; the back button is cut (no screen before this one in M1).
 *
 * Takes plain props: `lmsName` (from `lmsNameOf(user)`), `siteUrl` (her
 * school's Moodle, linked from step 1) and `action`, a `useActionState`
 * action. The real one is `connectAction` from
 * src/app/(first-run)/connect/actions.ts, passed in by the server page; it
 * redirects to /home on success and otherwise answers `{ error }`.
 *
 * The field is a password field with autocomplete off, so the key is not shown
 * over her shoulder and the browser does not offer to save it. After an error
 * the form resets (React does this for form actions), the error is announced
 * and the field gets focus again, ready for a fresh paste.
 *
 * Cut: no QR, no one-tap sign-in, no school choice (M5).
 */
import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Vitonen, type VitonenHandle } from "@/components/vitonen";

export type ConnectState = { error: string | null };

export type PasteKeyProps = {
  lmsName: string;
  siteUrl: string | null;
  action: (prev: ConnectState, formData: FormData) => Promise<ConnectState>;
};

const INITIAL: ConnectState = { error: null };

export function PasteKey({ lmsName, siteUrl, action }: PasteKeyProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const inputRef = useRef<HTMLInputElement>(null);
  const cap = useRef<VitonenHandle>(null);
  const ids = { field: useId(), error: useId(), steps: useId() };

  useEffect(() => {
    if (!state.error) return;
    inputRef.current?.focus();
    cap.current?.react("wince");
  }, [state]);

  // Unverified: the wording of these steps was not checked against her
  // school's Moodle (context/moodle/findings.md does not exist yet). It is the
  // ticket's text. Check the menu names on the real site and fix here.
  const steps = [
    <>
      Open{" "}
      {siteUrl ? (
        <a
          href={siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-ink underline decoration-line decoration-2 underline-offset-4 hover:decoration-accent"
        >
          {lmsName}
        </a>
      ) : (
        lmsName
      )}
      , then Preferences, then Security keys.
    </>,
    <>Copy the key called &ldquo;Moodle mobile web service&rdquo;.</>,
    <>Paste it here.</>,
  ];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-[max(28px,env(safe-area-inset-bottom,0px))]">
      <div className="mt-2">
        <Vitonen ref={cap} size={64} state={pending ? "thinking" : "idle"} />
      </div>
      <h1
        className="mt-3 font-display text-[26px] font-semibold leading-[1.15] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]"
        tabIndex={-1}
      >
        Connect {lmsName}
      </h1>

      <ol id={ids.steps} className="mt-6 grid list-none gap-3.5">
        {steps.map((step, i) => (
          <li key={i} className="grid grid-cols-[32px_1fr] items-baseline gap-x-3 text-[15px] text-ink">
            <span
              aria-hidden="true"
              className="mono grid size-7 place-items-center self-center rounded-full bg-paper text-ink-2"
            >
              {i + 1}
            </span>
            <span>
              <span className="sr-only">Step {i + 1}: </span>
              {step}
            </span>
          </li>
        ))}
      </ol>

      <form action={formAction} noValidate className="mt-7 grid gap-3">
        <label htmlFor={ids.field} className="text-[14px] font-medium text-ink">
          Your key
        </label>
        <input
          ref={inputRef}
          id={ids.field}
          name="key"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={pending}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? ids.error : ids.steps}
          className="mono min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 !text-[16px] text-ink aria-invalid:border-ink disabled:opacity-60"
        />
        <p id={ids.error} role="alert" className="text-[14px] text-ink empty:hidden">
          {state.error}
        </p>

        <div className="mt-2 grid gap-3 text-center">
          <Button type="submit" size="lg" block loading={pending} loadingLabel="Connecting">
            Connect
          </Button>
          <p className="text-[13px] text-ink-3">Ready reads your courses. Nothing is handed in without your tap.</p>
          <Link
            href="/settings#privacy"
            className="mx-auto inline-flex min-h-11 items-center text-[14px] font-medium text-ink-2 underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-accent"
          >
            What does Ready keep?
          </Link>
        </div>
      </form>
    </div>
  );
}
