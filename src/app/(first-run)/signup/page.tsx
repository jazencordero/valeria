"use client";

/**
 * Sign up (M5-14): the first step of the first run. Username, password with a show/hide toggle,
 * the yes from M8-33 (a box she must tick, and the link to /privacy in a new tab), Sign up. Then
 * the school screen. A taken name gets one sentence. The rules are in ./actions.ts.
 *
 * The tick's sentence is new here (the connect screen's own is about the key) and waits for
 * Jazen like the M8-33 wording.
 *
 * In the first-run look: the centred 440 px column, the cap and the heading of the connect
 * screen (src/components/first-run/paste-key.tsx). A client page (the toggle and the pending
 * state need it), so the title is a React <title>, not `metadata`.
 *
 * The password field is cleared after a failed try (React resets a form after its action); the
 * name stays, from the state. Focus goes back to the password and the cap winces.
 */
import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Vitonen, type VitonenHandle } from "@/components/vitonen";
import { signUpAction, type SignUpState } from "./actions";

const INITIAL: SignUpState = { error: null, username: "" };

const FIELD =
  "min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 !text-[16px] text-ink aria-invalid:border-ink disabled:opacity-60";
const LINK =
  "font-medium text-ink-2 underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-accent";

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUpAction, INITIAL);
  const [shown, setShown] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const cap = useRef<VitonenHandle>(null);
  const agree = useRef<HTMLInputElement>(null);

  // The page is prerendered: a box ticked before it hydrated counts as ticked.
  useEffect(() => {
    if (agree.current?.checked) setAgreed(true);
  }, []);
  const ids = { name: useId(), nameHelp: useId(), password: useId(), passwordHelp: useId(), error: useId(), agree: useId() };

  useEffect(() => {
    if (!state.error) return;
    password.current?.focus();
    cap.current?.react("wince");
  }, [state]);

  return (
    <main className="min-h-dvh min-[700px]:bg-paper">
      <title>Sign up · Ready</title>
      <div className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-[max(28px,env(safe-area-inset-bottom,0px))]">
        <Link href="/welcome" className={`inline-flex min-h-11 items-center self-start text-[14px] ${LINK}`}>
          Back
        </Link>
        <div className="mt-2">
          <Vitonen ref={cap} size={64} state={pending ? "thinking" : "idle"} />
        </div>
        <h1 className="mt-3 font-display text-[26px] font-semibold leading-[1.15] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]">
          Sign up
        </h1>
        <p className="mt-2 text-[15px] text-ink-2">Pick a username and a password. With them you can log in on any device.</p>

        <form action={formAction} noValidate className="mt-7 grid gap-3">
          <label htmlFor={ids.name} className="text-[14px] font-medium text-ink">
            Username
          </label>
          <input
            id={ids.name}
            name="username"
            type="text"
            defaultValue={state.username}
            key={`name-${state.username}`}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            disabled={pending}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? `${ids.error} ${ids.nameHelp}` : ids.nameHelp}
            className={FIELD}
          />
          <p id={ids.nameHelp} className="-mt-1 text-[13px] text-ink-3">
            3 to 32 letters, numbers, dots, dashes or underscores.
          </p>

          <label htmlFor={ids.password} className="mt-1 text-[14px] font-medium text-ink">
            Password
          </label>
          <div className="relative">
            <input
              ref={password}
              id={ids.password}
              name="password"
              type={shown ? "text" : "password"}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={pending}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? `${ids.error} ${ids.passwordHelp}` : ids.passwordHelp}
              className={`${FIELD} pr-20`}
            />
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-pressed={shown}
              aria-controls={ids.password}
              className={`absolute inset-y-0 right-0 min-w-11 px-3 text-[14px] ${LINK}`}
            >
              {shown ? "Hide" : "Show"}
              <span className="sr-only"> password</span>
            </button>
          </div>
          <p id={ids.passwordHelp} className="-mt-1 text-[13px] text-ink-3">
            At least 5 characters.
          </p>

          <p id={ids.error} role="alert" className="text-[14px] text-ink empty:hidden">
            {state.error}
          </p>

          <div className="mt-1 grid gap-1">
            <label htmlFor={ids.agree} className="grid min-h-11 grid-cols-[20px_1fr] items-start gap-x-3 text-[14px] text-ink">
              <input
                id={ids.agree}
                name="agree"
                value="yes"
                type="checkbox"
                required
                ref={agree}
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 size-5"
              />
              <span>I have read what Ready keeps about me, and I agree.</span>
            </label>
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener"
              className={`ml-8 inline-flex min-h-11 items-center justify-self-start text-[14px] ${LINK}`}
            >
              What does Ready keep?
            </Link>
          </div>

          <div className="mt-2 grid gap-3 text-center">
            <Button
              type="submit"
              size="lg"
              block
              loading={pending}
              loadingLabel="Signing up"
              disabled={!agreed}
              aria-describedby={agreed ? undefined : ids.agree}
            >
              Sign up
            </Button>
            <p className="text-[14px] text-ink-2">
              Already have an account?{" "}
              <Link href="/login" className={LINK}>
                Log in
              </Link>
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
