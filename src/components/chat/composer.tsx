"use client";

/**
 * Composer: the single-line chat input with a round send button.
 * Source: prototype main-flow.html HTML 1663-1667 (.composer, #chat-input,
 * #btn-send), CSS 909-920 and JS 4524-4531 (sendTyped).
 *
 * Enter or the send button sends the trimmed text and clears the field.
 * Empty or whitespace-only text does not send; it puts focus back in the field.
 * While a reply is arriving (`busy`) the send button is disabled and Enter does
 * nothing, but the field stays typable so the phone keyboard stays open.
 * Cut: single line, no attachments.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

export type ComposerProps = {
  /** A reply is arriving: sending is off. */
  busy?: boolean;
  /** Called once per send with the trimmed text. */
  onSend: (text: string) => void;
  /** Called on every keystroke, so the suggestion chip knows she is typing. */
  onInput?: () => void;
  className?: string;
};

export const COMPOSER_PLACEHOLDER = "Ask or tell me what to do";

function SendIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5.5M6 11.5l6-6 6 6" />
    </svg>
  );
}

export function Composer({ busy = false, onSend, onInput, className = "" }: ComposerProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const text = value.trim();
    if (!text) {
      inputRef.current?.focus();
      return;
    }
    setValue("");
    onSend(text);
  }

  return (
    <form
      onSubmit={submit}
      aria-busy={busy || undefined}
      className={"mt-1 flex items-center gap-2 " + className}
    >
      <label className="sr-only" htmlFor={id}>
        Message
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onInput?.();
        }}
        placeholder={COMPOSER_PLACEHOLDER}
        autoComplete="off"
        enterKeyHint="send"
        className={
          "h-12 min-w-0 flex-1 rounded-full border border-solid border-line bg-paper px-[18px] " +
          "text-[16px] text-ink placeholder:text-ink-3 " +
          "transition-[border-color] duration-quick ease-out motion-reduce:duration-150 " +
          "focus-visible:border-ink-3 focus-visible:outline-none"
        }
      />
      <Button
        type="submit"
        variant="icon"
        disabled={busy}
        aria-label="Send"
        className={
          "bg-[var(--btn)]! text-[var(--btn-ink)]! shadow-[0_2px_0_var(--btn-ledge)] " +
          "active:shadow-[0_0_0_var(--btn-ledge)] [&_svg]:size-[18px]!"
        }
      >
        <SendIcon />
      </Button>
    </form>
  );
}
