"use client";

/**
 * Log in (M5-14): for someone who already has an account, made by sign up or handed over (an
 * account made for a student with the seed tool, M3-57). Username, password with a show/hide
 * toggle, Log in. Wrong name or wrong password: one answer. After log in: Home (or the first run
 * when the account never started it). The rules are in ./actions.ts.
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
import { logInAction, type LogInState } from "./actions";

const INITIAL: LogInState = { error: null, username: "" };

const FIELD =
  "min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 !text-[16px] text-ink aria-invalid:border-ink disabled:opacity-60";
const LINK =
  "font-medium text-ink-2 underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-accent";

export default function LogInPage() {
  const [state, formAction, pending] = useActionState(logInAction, INITIAL);
  const [shown, setShown] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const cap = useRef<VitonenHandle>(null);
  const ids = { name: useId(), password: useId(), error: useId() };

  useEffect(() => {
    if (!state.error) return;
    password.current?.focus();
    cap.current?.react("wince");
  }, [state]);

  return (
    <main className="min-h-dvh min-[700px]:bg-paper">
      <title>Log in · Ready</title>
      <div className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-[max(28px,env(safe-area-inset-bottom,0px))]">
        <Link href="/welcome" className={`inline-flex min-h-11 items-center self-start text-[14px] ${LINK}`}>
          Back
        </Link>
        <div className="mt-2">
          <Vitonen ref={cap} size={64} state={pending ? "thinking" : "idle"} />
        </div>
        <h1 className="mt-3 font-display text-[26px] font-semibold leading-[1.15] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]">
          Log in
        </h1>
        <p className="mt-2 text-[15px] text-ink-2">With the username and password of your account.</p>

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
            aria-describedby={state.error ? ids.error : undefined}
            className={FIELD}
          />

          <label htmlFor={ids.password} className="mt-1 text-[14px] font-medium text-ink">
            Password
          </label>
          <div className="relative">
            <input
              ref={password}
              id={ids.password}
              name="password"
              type={shown ? "text" : "password"}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={pending}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? ids.error : undefined}
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

          <p id={ids.error} role="alert" className="text-[14px] text-ink empty:hidden">
            {state.error}
          </p>

          <div className="mt-2 grid gap-3 text-center">
            <Button type="submit" size="lg" block loading={pending} loadingLabel="Logging in">
              Log in
            </Button>
            <p className="text-[14px] text-ink-2">
              No account yet?{" "}
              <Link href="/signup" className={LINK}>
                Sign up
              </Link>
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
