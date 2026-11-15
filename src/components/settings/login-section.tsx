"use client";

/**
 * Settings, "Log in" (M5-15), and Home's quiet line that points to it.
 *
 * `LoginSection`, by whether the account has a login:
 * - none: "Set a username and password so you can log in on any device." Username, password with
 *   a show/hide toggle, Save. Then "You can now log in as <username>." and the second state.
 * - a login: the username, and "Change password" (current and new). Then "Your new password is
 *   saved."
 * The page leaves the section out for a demo. Built from the sign-up screen's pieces (fields,
 * toggle, error line: src/app/(first-run)/signup/page.tsx); no design pass (M8-01 designs
 * Settings). The page passes the two Server Actions (./login-actions.ts) as props, and this file
 * imports only their types, so no server code reaches the browser.
 *
 * A refused try clears the password fields (React resets a form after its action); the name
 * stays, from the state, and focus goes back to the first password field.
 *
 * `LoginNudge`: Home's one line for an account without a login, "Set a username and password so
 * you can get back in.", linking to this section, with "Not now", which hides it on this device
 * (localStorage; every read and write wrapped, as storage can throw in a private window). The
 * server and the first client render show nothing, the stored choice is read right after
 * hydration (`useSyncExternalStore`), so a dismissed line never shows, not even for a frame; a
 * line not dismissed appears once the page is interactive.
 */
import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { Button } from "@/components/ui/button";
import type { ChangePasswordState, SetLoginState } from "@/app/(app)/settings/login-actions";

/** The id of the section, for Home's link (`/settings#log-in`). */
export const LOGIN_SECTION_ID = "log-in";

const SET_START: SetLoginState = { error: null, username: "", savedAs: null };
const CHANGE_START: ChangePasswordState = { error: null, changed: false };

const FIELD =
  "min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 !text-[16px] text-ink aria-invalid:border-ink disabled:opacity-60";
const LINK =
  "font-medium text-ink-2 underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-accent";

type Props = {
  /** The account's username; null when it has no login yet. */
  username: string | null;
  setLoginAction: (prev: SetLoginState, formData: FormData) => Promise<SetLoginState>;
  changePasswordAction: (prev: ChangePasswordState, formData: FormData) => Promise<ChangePasswordState>;
};

export function LoginSection({ username, setLoginAction, changePasswordAction }: Props) {
  const [setState, setAction, setPending] = useActionState(setLoginAction, SET_START);
  // Right after a save the page may not have re-rendered yet: the saved name counts as hers.
  const name = username ?? setState.savedAs;

  return (
    <section id={LOGIN_SECTION_ID} aria-labelledby="login-title" className="scroll-mt-6 space-y-3">
      <h2 id="login-title" className="type-h22">
        Log in
      </h2>
      {setState.savedAs ? (
        <p role="status" className="text-ink">
          You can now log in as {setState.savedAs}.
        </p>
      ) : null}
      {name ? (
        <ChangePassword username={name} action={changePasswordAction} />
      ) : (
        <SetLogin state={setState} action={setAction} pending={setPending} />
      )}
    </section>
  );
}

function PasswordField({
  id,
  name,
  label,
  help,
  autoComplete,
  invalid,
  errorId,
  disabled,
  inputRef,
}: {
  id: string;
  name: string;
  label: string;
  help?: string;
  autoComplete: "new-password" | "current-password";
  invalid: boolean;
  errorId: string;
  disabled: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [shown, setShown] = useState(false);
  const helpId = `${id}-help`;
  const describedBy = [invalid ? errorId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined;
  return (
    <>
      <label htmlFor={id} className="mt-1 text-[14px] font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={`${FIELD} pr-20`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-controls={id}
          aria-label={`${shown ? "Hide" : "Show"} ${label.toLowerCase()}`}
          className={`absolute inset-y-0 right-0 min-w-11 px-3 text-[14px] ${LINK}`}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {help ? (
        <p id={helpId} className="-mt-1 text-[13px] text-ink-3">
          {help}
        </p>
      ) : null}
    </>
  );
}

function SetLogin({
  state,
  action,
  pending,
}: {
  state: SetLoginState;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  const ids = { name: useId(), nameHelp: useId(), password: useId(), error: useId() };
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.error) password.current?.focus();
  }, [state]);
  const invalid = Boolean(state.error);

  return (
    <>
      <p className="ink-2">Set a username and password so you can log in on any device.</p>
      <form action={action} noValidate className="grid gap-3">
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
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${ids.error} ${ids.nameHelp}` : ids.nameHelp}
          className={FIELD}
        />
        <p id={ids.nameHelp} className="-mt-1 text-[13px] text-ink-3">
          3 to 32 letters, numbers, dots, dashes or underscores.
        </p>
        <PasswordField
          id={ids.password}
          name="password"
          label="Password"
          help="At least 5 characters."
          autoComplete="new-password"
          invalid={invalid}
          errorId={ids.error}
          disabled={pending}
          inputRef={password}
        />
        <p id={ids.error} role="alert" className="text-[14px] text-ink empty:hidden">
          {state.error}
        </p>
        <div>
          <Button type="submit" variant="secondary" loading={pending} loadingLabel="Saving">
            Save
          </Button>
        </div>
      </form>
    </>
  );
}

function ChangePassword({ username, action }: { username: string; action: Props["changePasswordAction"] }) {
  const [state, formAction, pending] = useActionState(action, CHANGE_START);
  const ids = { current: useId(), next: useId(), error: useId() };
  const current = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.error) current.current?.focus();
  }, [state]);
  const invalid = Boolean(state.error);

  return (
    <>
      <p>
        Your username is <strong>{username}</strong>.
      </p>
      <form action={formAction} noValidate className="grid gap-3">
        <h3 className="font-semibold">Change password</h3>
        {/* For password managers: which account these passwords belong to. */}
        <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
        <PasswordField
          id={ids.current}
          name="current"
          label="Current password"
          autoComplete="current-password"
          invalid={invalid}
          errorId={ids.error}
          disabled={pending}
          inputRef={current}
        />
        <PasswordField
          id={ids.next}
          name="next"
          label="New password"
          help="At least 5 characters."
          autoComplete="new-password"
          invalid={invalid}
          errorId={ids.error}
          disabled={pending}
        />
        <p id={ids.error} role="alert" className="text-[14px] text-ink empty:hidden">
          {state.error}
        </p>
        {state.changed ? (
          <p role="status" className="text-[14px] text-ink">
            Your new password is saved.
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="secondary" loading={pending} loadingLabel="Saving">
            Change password
          </Button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Home's quiet line.                                                        */
/* ------------------------------------------------------------------------- */

/** The localStorage key that hides the line on this device. */
export const NUDGE_HIDDEN_KEY = "ready.login-nudge.hidden";

const nudgeListeners = new Set<() => void>();
/** Hidden for this page's life when storage cannot be written (a private window). */
let hiddenInMemory = false;

function subscribeNudge(onChange: () => void): () => void {
  nudgeListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    nudgeListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function nudgeHidden(): boolean {
  if (hiddenInMemory) return true;
  try {
    return window.localStorage.getItem(NUDGE_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** On the server and while hydrating: hidden, so the page never shows a line it then takes back. */
const hiddenOnServer = () => true;

function hideNudge() {
  hiddenInMemory = true;
  try {
    window.localStorage.setItem(NUDGE_HIDDEN_KEY, "1");
  } catch {
    // Storage blocked: hidden until the page is reloaded.
  }
  for (const listener of nudgeListeners) listener();
}

export function LoginNudge({ className }: { className?: string }) {
  const hidden = useSyncExternalStore(subscribeNudge, nudgeHidden, hiddenOnServer);
  if (hidden) return null;
  return (
    <p className={`flex flex-wrap items-center gap-x-3 text-[14px] text-ink-2 ${className ?? ""}`}>
      <Link href={`/settings#${LOGIN_SECTION_ID}`} className={`inline-flex min-h-11 items-center ${LINK}`}>
        Set a username and password so you can get back in.
      </Link>
      <button type="button" onClick={hideNudge} className={`inline-flex min-h-11 items-center ${LINK}`}>
        Not now
      </button>
    </p>
  );
}
