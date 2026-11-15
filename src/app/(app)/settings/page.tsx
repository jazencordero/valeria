/*
 * Settings, plain (M1-38): MyCourses, your data, what Ready keeps.
 * M2-26 adds a plain checkbox under "What Ready keeps": "Use my course files with AI"
 * (M8-03 turns it into the designed switch).
 *
 * Built from existing pieces only; no design pass (M8-01 designs it). Works
 * with or without the (app) frame from M1-25: it is an ordinary page in the
 * route group and brings its own <main>.
 */
import { eq } from "drizzle-orm";
import { connection } from "next/server";
import { cache, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { dateLine } from "@/lib/dates";
import { filesSwitchOn } from "@/server/ai/consent";
import { ensureSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";
import { DELETE_PHRASE, deleteAccountAction, disconnectAction, setUseFilesAction } from "./actions";

// src/lib/schools.ts (the school's `lms` name) does not exist on this branch
// yet; swap this for it when it lands.
const LMS_NAME = "MyCourses";

type Connection = {
  /** Her display name, when we know it. */
  name: string | null;
  connectedAt: Date;
  /** Last successful sync. Null until the sync runner (M1-16) has run once. */
  lastSyncAt: Date | null;
};

type AccountProps = {
  connection: Connection | null;
  /** True after a delete attempt whose typed text did not match. */
  confirmWrong: boolean;
};

/** The visitor's user, read once per request for both parts that need it. */
const sessionUser = cache(async () => {
  // Request time only: the session and DB reads touch the clock, which Next refuses during
  // (runtime) prerendering.
  await connection();
  return ensureSession();
});

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/*
 * Cache Components is on, so the parts that read the session cookie and the
 * database stream in behind <Suspense>; the heading and "What Ready keeps"
 * are static and ship in the prerendered shell.
 */
export default function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-xl space-y-10 px-5 py-10">
      <h1 className="type-h30">Settings</h1>
      <Suspense fallback={<p className="ink-3">Loading your settings…</p>}>
        <AccountSections searchParams={searchParams} />
      </Suspense>
      <Privacy />
    </main>
  );
}

async function AccountSections({ searchParams }: { searchParams: SearchParams }) {
  const user = await sessionUser();
  const [row] = await db
    .select({
      connectedAt: moodleConnections.connectedAt,
      lastSyncAt: moodleConnections.lastSyncAt,
    })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, user.id))
    .limit(1);
  const { confirm } = await searchParams;

  return (
    <Account
      connection={row ? { name: user.displayName, ...row } : null}
      confirmWrong={confirm === "wrong"}
    />
  );
}

function Account({ connection, confirmWrong }: AccountProps) {
  return (
    <>
      <section aria-labelledby="lms-title" className="space-y-3">
        <h2 id="lms-title" className="type-h22">
          {LMS_NAME}
        </h2>
        {connection ? (
          <>
            <dl className="space-y-1">
              <div>
                <dt className="sr-only">Connected as</dt>
                <dd>{connection.name ? `Connected as ${connection.name}` : "Connected"}</dd>
              </div>
              <div className="flex gap-1 ink-2">
                <dt>Since</dt>
                <dd>{dateLine(connection.connectedAt)}</dd>
              </div>
              <div className="flex gap-1 ink-2">
                <dt>Last refreshed</dt>
                <dd>{connection.lastSyncAt ? dateLine(connection.lastSyncAt) : "not yet"}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {/* Forced sync is wired up by M1-16 (the sync runner); until then it is disabled. */}
              <Button variant="secondary" size="sm" disabled>
                Refresh now
              </Button>
              <form action={disconnectAction}>
                <Button type="submit" variant="secondary" size="sm">
                  Disconnect
                </Button>
              </form>
            </div>
            <p className="fine">Disconnect deletes your key. Your courses, deadlines and progress stay.</p>
          </>
        ) : (
          <p className="ink-2">{LMS_NAME} is not connected.</p>
        )}
      </section>

      <section id="your-data" aria-labelledby="data-title" className="space-y-3">
        <h2 id="data-title" className="type-h22">
          Your data
        </h2>
        <form action={deleteAccountAction} className="space-y-3">
          <label htmlFor="confirm-delete" className="block">
            Type <strong>{DELETE_PHRASE}</strong> to delete your account and everything in it.
            This cannot be undone.
          </label>
          <input
            id="confirm-delete"
            name="confirm"
            type="text"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={confirmWrong || undefined}
            aria-describedby={confirmWrong ? "confirm-wrong" : undefined}
            className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-ink"
          />
          {confirmWrong && (
            <p id="confirm-wrong" role="alert" className="text-due">
              That did not match, so nothing was deleted. Type {DELETE_PHRASE} to confirm.
            </p>
          )}
          <Button type="submit" variant="primary">
            Delete my account and everything in it
          </Button>
        </form>
      </section>
    </>
  );
}

/** Her own switch for course files and AI. Reads the session, so it streams in behind <Suspense>. */
async function AiFilesSwitch() {
  const user = await sessionUser();
  return <AiFiles on={filesSwitchOn(user.settings)} />;
}

function AiFiles({ on }: { on: boolean }) {
  return (
    <form action={setUseFilesAction} className="space-y-2">
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" name="useFiles" defaultChecked={on} className="size-5" />
        Use my course files with AI
      </label>
      <p className="fine">
        When this is on, Ready may send the text of your course files to an AI model, only in courses you marked as
        allowing AI. When it is off, the chat works from the assignment text only.
      </p>
      <Button type="submit" variant="secondary" size="sm">
        Save
      </Button>
    </form>
  );
}

/** Static except the switch: the lists prerender into the shell. */
function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="space-y-3">
      <h2 id="privacy-title" className="type-h22">
        What Ready keeps
      </h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Your key (encrypted, on our server, used only to read your courses and to hand in when you tap)</li>
        <li>Course names</li>
        <li>Deadlines</li>
        <li>The text of files you open</li>
        <li>Your answers and progress</li>
      </ul>
      <Suspense fallback={null}>
        <AiFilesSwitch />
      </Suspense>
      <h3 className="font-semibold">What it never does</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>Hand in without your tap</li>
        <li>Share your data</li>
        <li>Show your password to anyone</li>
      </ul>
    </section>
  );
}
