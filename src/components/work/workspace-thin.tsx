"use client";

/**
 * The thin assignment page's client part (M1-34): header, brief, sources,
 * file picker and the hand-in. Source: prototype main-flow.html HTML
 * 1632-1657 (#v-work, .work-head, .sources) and CSS 842-850 (.work-head,
 * .work-title, .work-due). No chat yet (M2-20 replaces the middle).
 *
 * Hand-in: "Hand in" sends the picked file to `prepareHandinAction`, which
 * answers with the review and a one-time code; the sheet shows that review,
 * and her tap on Submit sends the code and the same file to
 * `confirmHandinAction`. A code is spent by any confirm, so a retry from the
 * sheet (Moodle down, connection dropped) asks for a new review first.
 * After success the header reads "Handed in 15:52", the Hand in part goes
 * away, and "Back to home" goes to /home.
 */
import { useRef, useState } from "react";
import {
  confirmHandinAction,
  prepareHandinAction,
  type PrepareHandinActionResult,
} from "@/app/(app)/assignments/[id]/actions";
import { Brief } from "@/components/work/brief";
import { FilePick } from "@/components/work/file-pick";
import { HandinSheet, type HandinReview, type Result } from "@/components/work/handin-sheet";
import { fileHref, iconKindFor, sourceMeta, type SourceIconKind } from "@/components/work/sources";
import { Button } from "@/components/ui/button";
import { listDate, sameDay, timeLeft } from "@/lib/dates";
import type { CleanBrief } from "@/lib/html/clean";
import { handinPausedMessage } from "@/server/flags";

export type WorkspaceSource = {
  id: string;
  name: string;
  mime: string | null;
  course: string;
  readable: boolean;
};

export type WorkspaceThinProps = {
  id: string;
  title: string;
  dueAt: Date | null;
  handedInAt: Date | null;
  brief: CleanBrief | null;
  files: WorkspaceSource[];
  acceptsFiles: boolean;
  maxBytes: number | null;
  maxFiles: number | null;
  lms: string;
  lmsUrl: string;
  /** The server's render time, so the due line hydrates the same. */
  now: Date;
  /** Where the back arrow and "Back to home" go. */
  homeHref?: string;
};

type Problem = { text: string; link?: { href: string; label: string } };

/**
 * The header's second line.
 * - Open, due today: `Due 21:00 · 5 h 12 min left`
 * - Open, another day: `Due TUE 17 · 23:59 · 2 days left`
 * - Open, past due: `Due TUE 17 · 23:59 · late by 3 h`
 * - Open, no due date: `No due date`
 * - Handed in today: `Handed in 15:52`; another day: `Handed in TUE 10 · 15:52`
 */
export function dueText(dueAt: Date | null, handedInAt: Date | null, now: Date): string {
  const clock = (at: Date) => listDate(at).split(" · ")[1];
  if (handedInAt) return `Handed in ${sameDay(handedInAt, now) ? clock(handedInAt) : listDate(handedInAt)}`;
  if (!dueAt) return "No due date";
  return `Due ${sameDay(dueAt, now) ? clock(dueAt) : listDate(dueAt)} · ${timeLeft(dueAt, now)}`;
}

/** The line under "Hand in" when the review could not be made. */
function prepareProblem(r: Exclude<PrepareHandinActionResult, { ok: true }>, lms: string, lmsUrl: string): Problem {
  const there = { href: lmsUrl, label: `Open ${lms}` };
  switch (r.reason) {
    case "paused":
      return { text: handinPausedMessage(r.lms), link: { href: r.url ?? lmsUrl, label: `Open ${r.lms}` } };
    case "closed":
      return { text: "This assignment no longer takes a hand-in here.", link: there };
    case "no_files":
      return { text: `This assignment does not take files here. Hand it in on ${lms}.`, link: there };
    case "too_big":
      return { text: `That file is too big to hand in from here. Hand it in on ${lms}.`, link: there };
    case "no_file":
      return { text: "That file is empty or has no name. Pick it again." };
    case "not_found":
      return { text: "We could not find this assignment any more. Go back and open it again." };
    case "signed_out":
      return { text: "You are signed out. Open Ready again, then hand in." };
    case "invalid":
      return { text: "Something went wrong with the file. Pick it again." };
  }
}

function SourceIcon({ kind }: { kind: SourceIconKind }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "image" ? (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M4 16l4.5-4.5L13 16l2.5-2.5L20 18" />
          <circle cx="15.5" cy="9.5" r="1.25" />
        </>
      ) : (
        <>
          <path d="M7 3.5h6.5L18 8v12.5H7z" />
          <path d="M13.5 3.5V8H18" />
          {kind === "data" ? <path d="M9.5 12.5h5M9.5 15.5h5M12 11v6" /> : null}
        </>
      )}
    </svg>
  );
}

function formOf(file: File): FormData {
  const form = new FormData();
  form.append("file", file, file.name);
  return form;
}

export function WorkspaceThin({
  id,
  title,
  dueAt,
  handedInAt,
  brief,
  files,
  acceptsFiles,
  maxBytes,
  maxFiles,
  lms,
  lmsUrl,
  now,
  homeHref = "/home",
}: WorkspaceThinProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [review, setReview] = useState<HandinReview | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // A new sheet for every review, so a failed one never carries over.
  const [sheetKey, setSheetKey] = useState(0);
  const [doneAt, setDoneAt] = useState<Date | null>(null);
  // The code from the latest review, and whether a confirm has spent it.
  const code = useRef<string | null>(null);
  const spent = useRef(false);

  const handed = doneAt ?? handedInAt;

  const prepare = async (picked: File) => {
    const r = await prepareHandinAction(id, formOf(picked));
    if (r.ok) {
      code.current = r.review.code;
      spent.current = false;
    }
    return r;
  };

  const handIn = async () => {
    if (!file || preparing) return;
    setPreparing(true);
    setProblem(null);
    try {
      const r = await prepare(file);
      if (!r.ok) {
        setProblem(prepareProblem(r, lms, lmsUrl));
        return;
      }
      setReview({
        fileName: r.review.fileName,
        bytes: r.review.bytes,
        to: r.review.to,
        // The sheet needs a due time; without one it reads as on time.
        due: r.review.due ?? new Date(),
        earlyBy: r.review.earlyBy ?? "No due date",
        needsStatement: r.review.needsStatement,
      });
      setSheetKey((k) => k + 1);
      setSheetOpen(true);
    } catch {
      setProblem({ text: "The connection dropped, so nothing was sent. Try again." });
    } finally {
      setPreparing(false);
    }
  };

  const submit = async (): Promise<Result> => {
    if (!file) return { ok: false, reason: "changed" };
    // A spent code cannot be used again: get a new review for the same file.
    if (spent.current || !code.current) {
      const again = await prepare(file);
      if (!again.ok) return { ok: false, reason: "expired" };
    }
    spent.current = true;
    const r = await confirmHandinAction(code.current, formOf(file));
    if (r.ok) return { ok: true, submittedAt: r.receipt.submittedAt };
    if (r.reason === "refused") return { ok: false, reason: "refused", message: r.message };
    if (r.reason === "signed_out" || r.reason === "invalid") return { ok: false, reason: "expired" };
    return { ok: false, reason: r.reason };
  };

  const closeSheet = () => {
    setSheetOpen(false);
  };

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-[2] flex items-center gap-1 border-b border-line bg-surface pt-[max(10px,env(safe-area-inset-top,0px))] pr-[var(--pad)] pb-2.5 pl-[max(6px,calc(var(--pad)-14px))]">
        <Button variant="icon" href={homeHref} aria-label="Back to home">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </Button>
        <div className="min-w-0">
          <h1 className="font-display text-[18px] leading-[1.25] font-semibold [overflow-wrap:anywhere]" tabIndex={-1}>
            {title}
          </h1>
          <p
            className={"mono mt-0.5 " + (handed ? "text-ink-2" : "text-due")}
            data-testid="work-due"
          >
            {dueText(dueAt, handed, now)}
          </p>
        </div>
      </header>

      <div className="mx-auto grid max-w-[720px] gap-8 px-[var(--pad)] pt-6 pb-12">
        {brief ? <Brief brief={brief} lmsName={lms} sourceUrl={lmsUrl} /> : null}

        {files.length > 0 ? (
          <section aria-label="Sources">
            <p className="mono uppercase tracking-[0.08em] text-ink-3">Sources</p>
            <ul className="mt-3 grid list-none gap-4">
              {files.map((f) => (
                <li key={f.id} className="flex items-start gap-2.5 text-ink-2">
                  <span className="mt-px">
                    <SourceIcon kind={iconKindFor({ name: f.name, mime: f.mime ?? undefined })} />
                  </span>
                  <div className="min-w-0">
                    <a
                      href={fileHref(f.id)}
                      target="_blank"
                      rel="noopener"
                      className="mono text-ink underline decoration-line underline-offset-4 [overflow-wrap:anywhere] hover:decoration-ink"
                    >
                      {f.name}
                    </a>
                    <p className="mt-0.5 text-[13px] leading-[1.35] text-ink-3">{sourceMeta(f, lms)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {handed ? null : acceptsFiles ? (
          <section aria-label="Hand in" className="grid gap-4">
            <FilePick
              lms={lms}
              lmsUrl={lmsUrl}
              maxBytes={maxBytes ?? undefined}
              maxFiles={maxFiles ?? 1}
              disabled={preparing}
              onChange={(f) => {
                setFile(f);
                setProblem(null);
                code.current = null;
              }}
            />
            <Button
              block
              size="lg"
              disabled={!file}
              loading={preparing}
              onClick={() => void handIn()}
              data-testid="handin-open"
            >
              Hand in
            </Button>
            <div aria-live="polite">
              {problem ? (
                <p role="alert" className="text-[14px] text-ink [overflow-wrap:anywhere]" data-testid="handin-problem">
                  {problem.text}{" "}
                  {problem.link ? (
                    <a
                      href={problem.link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium underline underline-offset-2"
                    >
                      {problem.link.label}
                    </a>
                  ) : null}
                </p>
              ) : null}
            </div>
          </section>
        ) : (
          <p className="text-[15px] text-ink-2">
            This assignment does not take files here.{" "}
            <a href={lmsUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
              Hand it in on {lms}.
            </a>
          </p>
        )}
      </div>

      {review ? (
        <HandinSheet
          key={sheetKey}
          open={sheetOpen}
          onClose={closeSheet}
          review={review}
          onSubmit={submit}
          lmsName={lms}
          backHref={homeHref}
          onHandedIn={(r) => setDoneAt(new Date(r.submittedAt))}
        />
      ) : null}
    </div>
  );
}
