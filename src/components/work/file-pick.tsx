"use client";

/**
 * FilePick: attach the one file she made for an assignment.
 * A drop area with a "Choose file" button (a real, hidden <input type="file">
 * opened by the button, so it is reachable and opens with Enter or Space).
 * Once picked it shows the file's name and size with a Remove button.
 *
 * Checks, in order: how many files (the assignment's accepted count, one for
 * now), the assignment's own size limit (`maxBytes`), then our own 4 MB limit
 * (the hosting limit for request bodies). A file the LMS takes but we cannot
 * yet gets a plain line and a link to hand it in on the LMS itself.
 * A rejected pick leaves the current file as it was.
 *
 * The prototype has no attach screen; styling uses the shared tokens and Button.
 */
import { useId, useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";

/** Our own limit: Vercel takes request bodies up to 4.5 MB. Bigger files are M8-11. */
export const OUR_MAX_BYTES = 4 * 1024 * 1024;

export type FilePickProps = {
  /** The school's LMS name, for example from `lms` in schools.ts. */
  lms: string;
  /** This assignment's page on the LMS, where she can hand in herself. */
  lmsUrl: string;
  /** The assignment's own size limit in bytes. Leave out when the LMS gives none. */
  maxBytes?: number;
  /** How many files the assignment accepts. We take one for now. */
  maxFiles?: number;
  /** Called with the picked file, and with null on Remove. */
  onChange: (file: File | null) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
};

const KB = 1024;
const MB = 1024 * 1024;

/** "820 KB", "1.3 MB", "9 MB". Rounds up so a file just over a limit never reads as the limit. */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} bytes`;
  if (bytes < MB) return `${Math.ceil(bytes / KB)} KB`;
  const mb = Math.ceil((bytes / MB) * 10) / 10;
  return `${mb >= 10 ? Math.ceil(mb) : mb} MB`;
}

type Problem =
  | { kind: "count"; count: number; allowed: number }
  | { kind: "assignment"; size: number; limit: number }
  | { kind: "ours"; size: number };

function check(files: File[], maxFiles: number, maxBytes?: number): Problem | null {
  if (files.length > maxFiles) return { kind: "count", count: files.length, allowed: maxFiles };
  const file = files[0];
  if (maxBytes && maxBytes > 0 && file.size > maxBytes) {
    return { kind: "assignment", size: file.size, limit: maxBytes };
  }
  if (file.size > OUR_MAX_BYTES) return { kind: "ours", size: file.size };
  return null;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (n: number) => WORDS[n] ?? String(n);

function ProblemLine({ problem, lms, lmsUrl }: { problem: Problem; lms: string; lmsUrl: string }) {
  if (problem.kind === "count") {
    const takes =
      problem.allowed === 1 ? "one file" : `up to ${countWord(problem.allowed)} files`;
    return (
      <>
        That is {countWord(problem.count)} files. This assignment takes {takes}. Pick the one to
        hand in.
      </>
    );
  }
  if (problem.kind === "assignment") {
    return (
      <>
        That file is {formatBytes(problem.size)}. This assignment takes up to{" "}
        {formatBytes(problem.limit)}. Make it smaller, or pick another file.
      </>
    );
  }
  return (
    <>
      That file is {formatBytes(problem.size)}. {lms} takes it, we cannot yet.{" "}
      <a
        href={lmsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-ink underline underline-offset-2"
      >
        Hand this one in on {lms}.
      </a>
    </>
  );
}

function FileIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3.5V8h4.5" />
    </svg>
  );
}

export function FilePick({
  lms,
  lmsUrl,
  maxBytes,
  maxFiles = 1,
  onChange,
  disabled = false,
  className = "",
  id,
}: FilePickProps) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const allowed = Math.max(1, maxFiles);

  const take = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    const found = check(files, allowed, maxBytes);
    setProblem(found);
    if (found) return;
    setFile(files[0]);
    onChange(files[0]);
    // The Choose file button goes away; keep focus on the row that replaced it.
    requestAnimationFrame(() => removeRef.current?.focus());
  };

  const remove = () => {
    setFile(null);
    setProblem(null);
    onChange(null);
    requestAnimationFrame(() => chooseRef.current?.focus());
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    take(e.dataTransfer.files);
  };

  const limit = Math.min(OUR_MAX_BYTES, maxBytes && maxBytes > 0 ? maxBytes : OUR_MAX_BYTES);

  return (
    <div id={id} className={"min-w-0 " + className} data-testid="file-pick">
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple={allowed > 1 ? true : undefined}
        tabIndex={-1}
        disabled={disabled}
        data-testid="file-pick-input"
        onChange={(e) => {
          take(e.currentTarget.files);
          // Let her pick the same file again after a Remove.
          e.currentTarget.value = "";
        }}
      />

      {file ? (
        <div className="grid min-h-14 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-[14px] border border-solid border-line bg-surface py-2 pr-2 pl-3.5">
          <span className="grid size-7 place-items-center rounded-full bg-sky text-ink">
            <FileIcon />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-medium [overflow-wrap:anywhere]" data-testid="file-pick-name">
              {file.name}
            </p>
            <p className="mono ink-3 mt-0.5" data-testid="file-pick-size">
              {formatBytes(file.size)}
            </p>
          </div>
          <Button
            ref={removeRef}
            variant="text"
            size="sm"
            onClick={remove}
            disabled={disabled}
            aria-label={`Remove ${file.name}`}
          >
            Remove
          </Button>
        </div>
      ) : (
        <div
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={
            "flex flex-col items-center gap-3 rounded-[14px] border-[1.5px] border-dashed px-4 py-6 text-center " +
            "transition-colors duration-quick ease-out " +
            (over ? "border-ink-3 bg-accent-wash" : "border-line bg-surface")
          }
          data-testid="file-pick-drop"
        >
          <p className="text-[15px] text-ink-2" id={hintId}>
            Drop the file here, or
          </p>
          <Button
            ref={chooseRef}
            variant="secondary"
            size="md"
            disabled={disabled}
            aria-describedby={hintId}
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </Button>
          <p className="fine">
            {allowed === 1 ? "One file" : `Up to ${countWord(allowed)} files`}, up to{" "}
            {formatBytes(limit)}.
          </p>
        </div>
      )}

      <div aria-live="polite" className="min-w-0">
        {problem ? (
          <p role="alert" className="mt-2.5 text-[14px] text-ink [overflow-wrap:anywhere]" data-testid="file-pick-problem">
            <ProblemLine problem={problem} lms={lms} lmsUrl={lmsUrl} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
