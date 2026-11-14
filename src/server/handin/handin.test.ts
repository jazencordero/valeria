// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../tests/fake-moodle/server";
import { seal } from "@/server/crypto/seal";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { confirmCodes, users } from "@/server/db/schema/users";
import { assignments, submissions } from "@/server/db/schema/work";
import { configureMoodleClient, resetMoodleClient } from "@/server/moodle/client";
import { HANDIN_PURPOSE } from "@/server/moodle/her-tap";

// The actions read the user from the session cookie and use the app's `db`;
// both are swapped for this test's (as in src/server/study/actions.test.ts).
const signedIn = vi.hoisted(() => ({ userId: "", db: null as unknown as Record<string | symbol, unknown> }));

vi.mock("@/server/auth/session", () => {
  class NotSignedIn extends Error {}
  return {
    NotSignedIn,
    currentUser: async () => {
      if (!signedIn.userId) throw new NotSignedIn("not signed in");
      return { id: signedIn.userId };
    },
  };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy(
    {},
    {
      get(_, key) {
        const v = signedIn.db[key];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(signedIn.db) : v;
      },
    },
  );
  return { ...real, db };
});

vi.mock("next/cache", () => ({ refresh: vi.fn() }));

const { HANDIN_CODE_PURPOSE, HANDIN_CODE_TTL_MS, MAX_HANDIN_BYTES, fileHash, handinPayloadHash, prepareHandin } =
  await import("./prepare");
const { confirmHandin } = await import("./confirm");
const { confirmHandinAction, prepareHandinAction } = await import("@/app/(app)/assignments/[id]/actions");

// Made-up values for tests only.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const MIN = 60 * 1000;
// Saturday 14 Nov 2026, 12:00 in Helsinki.
const NOW = new Date("2026-11-14T10:00:00Z");
const DUE = new Date(NOW.getTime() + 5 * 60 * MIN + 8 * MIN);
const ASSIGN = 7301;
const enc = (s: string) => new TextEncoder().encode(s);
const PDF = { name: "memo.pdf", bytes: enc("%PDF-1.4 fake memo") };
const OTHER_PDF = { name: "memo.pdf", bytes: enc("%PDF-1.4 a different memo") };

let t: TestDb;
let moodle: FakeMoodle;
let her: string;
let other: string;
let assignmentId: string;
let nextMoodleId = ASSIGN;

async function seedUser(withConnection: boolean): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  if (withConnection) {
    await t.db.insert(moodleConnections).values({
      userId: u.id,
      siteUrl: moodle.url,
      moodleUserId: 4242,
      tokenSealed: seal(moodle.token),
    });
  }
  return u.id;
}

async function seedAssignment(userId: string, values: Partial<typeof assignments.$inferInsert> = {}): Promise<string> {
  const [course] = await t.db
    .insert(courses)
    .values({ userId, moodleId: 100 + Math.floor(Math.random() * 1e6), name: "Strategy Course" })
    .returning();
  const [a] = await t.db
    .insert(assignments)
    .values({
      userId,
      courseId: course.id,
      moodleId: nextMoodleId++,
      name: "Case memo 2",
      dueAt: DUE,
      acceptsFiles: true,
      needsSubmitButton: true,
      ...values,
    })
    .returning();
  return a.id;
}

/** What Moodle answers to the status read: her hand-in with these files. */
function moodleShows(files: { filename: string; filesize: number }[], status = "submitted") {
  moodle.override("mod_assign_get_submission_status", {
    body: {
      lastattempt: {
        submission: {
          status,
          timemodified: Math.floor(NOW.getTime() / 1000),
          plugins: [{ type: "file", fileareas: [{ area: "submission_files", files }] }],
        },
        graded: false,
        gradingstatus: "notgraded",
        canedit: false,
      },
      warnings: [],
    },
  });
}

const fns = (from = 0) => moodle.calls.slice(from).map((c) => c.fn);
const opts = () => ({ now: NOW, db: t.db });

async function review(file = PDF, userId = her, id = assignmentId) {
  const r = await prepareHandin(userId, id, file, opts());
  if (!r.ok) throw new Error(`prepare refused: ${r.reason}`);
  return r.review;
}

async function assignmentRow(id = assignmentId) {
  const [row] = await t.db.select().from(assignments).where(eq(assignments.id, id));
  return row;
}

beforeEach(async () => {
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  resetMoodleClient();
  configureMoodleClient({ countStore: null, sleep: async () => {} });
  t = await createTestDb();
  signedIn.db = t.db as unknown as Record<string | symbol, unknown>;
  signedIn.userId = "";
  nextMoodleId = ASSIGN;
  moodle = await startFakeMoodle();
  her = await seedUser(true);
  other = await seedUser(true);
  assignmentId = await seedAssignment(her);
  moodleShows([{ filename: PDF.name, filesize: PDF.bytes.byteLength }]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await moodle.close();
  await t.close();
});

describe("prepareHandin", () => {
  it("stores a 10-minute handin code for this assignment and file, and returns the review", async () => {
    const r = await review();
    expect(r).toEqual({
      code: expect.any(String),
      fileName: "memo.pdf",
      bytes: PDF.bytes.byteLength,
      to: "Strategy Course › Case memo 2",
      due: DUE,
      earlyBy: "5 h 8 min early",
      needsStatement: true,
      expiresAt: new Date(NOW.getTime() + HANDIN_CODE_TTL_MS),
    });
    const [row] = await t.db.select().from(confirmCodes).where(eq(confirmCodes.id, r.code));
    expect(row).toMatchObject({
      userId: her,
      purpose: "handin",
      payloadHash: handinPayloadHash(assignmentId, fileHash(PDF.bytes)),
      usedAt: null,
    });
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(10 * MIN);
    expect(HANDIN_CODE_PURPOSE).toBe(HANDIN_PURPOSE);
    expect(moodle.calls).toEqual([]);
  });

  it("refuses another user's assignment, a closed one, one without files, and a file too big", async () => {
    const theirs = await seedAssignment(other);
    expect(await prepareHandin(her, theirs, PDF, opts())).toEqual({ ok: false, reason: "not_found" });
    expect(await prepareHandin(her, "not-a-uuid", PDF, opts())).toEqual({ ok: false, reason: "not_found" });

    const done = await seedAssignment(her, { state: "submitted" });
    expect(await prepareHandin(her, done, PDF, opts())).toEqual({ ok: false, reason: "closed" });
    const cut = await seedAssignment(her, { cutoffAt: new Date(NOW.getTime() - MIN) });
    expect(await prepareHandin(her, cut, PDF, opts())).toEqual({ ok: false, reason: "closed" });
    const textOnly = await seedAssignment(her, { acceptsFiles: false });
    expect(await prepareHandin(her, textOnly, PDF, opts())).toEqual({ ok: false, reason: "no_files" });

    const big = { name: "big.pdf", bytes: new Uint8Array(MAX_HANDIN_BYTES + 1) };
    expect(await prepareHandin(her, assignmentId, big, opts())).toEqual({ ok: false, reason: "too_big" });
    const small = await seedAssignment(her, { maxBytes: 4 });
    expect(await prepareHandin(her, small, PDF, opts())).toEqual({ ok: false, reason: "too_big" });
    expect(await prepareHandin(her, assignmentId, { name: "x.pdf", bytes: new Uint8Array() }, opts())).toEqual({
      ok: false,
      reason: "no_file",
    });

    expect(await t.db.select().from(confirmCodes)).toEqual([]);
    expect(moodle.calls).toEqual([]);
  });
});

describe("confirmHandin", () => {
  it("hands in: upload, save, submit in order, reads it back, records the receipt", async () => {
    const r = await review();
    const result = await confirmHandin(her, r.code, PDF, opts());

    expect(result).toEqual({
      ok: true,
      receipt: {
        fileName: "memo.pdf",
        bytes: PDF.bytes.byteLength,
        to: "Strategy Course › Case memo 2",
        submittedAt: NOW,
        earlyBy: "5 h 8 min early",
      },
    });
    expect(fns()).toEqual([
      "upload",
      "mod_assign_save_submission",
      "mod_assign_submit_for_grading",
      "mod_assign_get_submission_status",
    ]);
    expect(moodle.calls[1].params).toMatchObject({ assignmentid: String(ASSIGN) });
    expect(moodle.calls[2].params).toEqual({ assignmentid: String(ASSIGN), acceptsubmissionstatement: "1" });

    expect(await assignmentRow()).toMatchObject({ state: "submitted", submittedAt: NOW });
    const [sub] = await t.db.select().from(submissions);
    expect(sub).toMatchObject({
      userId: her,
      assignmentId,
      fileName: "memo.pdf",
      bytes: PDF.bytes.byteLength,
      state: "submitted",
      submittedAt: NOW,
    });
    expect(sub.receipt).toMatchObject({ moodleAssignId: ASSIGN, submitPressed: true, moodleState: "submitted" });
    // Neither her key nor the file's content is kept in the receipt.
    expect(JSON.stringify(sub.receipt)).not.toContain(moodle.token);
    expect(JSON.stringify(sub.receipt)).not.toContain("fake memo");

    const [code] = await t.db.select().from(confirmCodes).where(eq(confirmCodes.id, r.code));
    expect(code.usedAt).toEqual(NOW);
  });

  it("makes no submit call when the assignment needs no submit button", async () => {
    const id = await seedAssignment(her, { needsSubmitButton: false });
    const r = await review(PDF, her, id);
    expect(r.needsStatement).toBe(false);
    const result = await confirmHandin(her, r.code, PDF, opts());
    expect(result.ok).toBe(true);
    expect(fns()).toEqual(["upload", "mod_assign_save_submission", "mod_assign_get_submission_status"]);
  });

  it("makes zero Moodle calls for a reused code, and only one hand-in for two taps at once", async () => {
    const r = await review();
    expect((await confirmHandin(her, r.code, PDF, opts())).ok).toBe(true);
    const before = moodle.calls.length;
    expect(await confirmHandin(her, r.code, PDF, opts())).toEqual({ ok: false, reason: "expired" });
    expect(moodle.calls.length).toBe(before);

    // Both taps pass the read checks; only one wins the atomic update.
    const id = await seedAssignment(her);
    const r2 = await review(PDF, her, id);
    const start = moodle.calls.length;
    const results = await Promise.all([confirmHandin(her, r2.code, PDF, opts()), confirmHandin(her, r2.code, PDF, opts())]);
    expect(results.map((x) => (x.ok ? "ok" : x.reason)).sort()).toEqual(["expired", "ok"]);
    expect(fns(start).filter((f) => f === "upload")).toHaveLength(1);
    expect(fns(start).filter((f) => f === "mod_assign_submit_for_grading")).toHaveLength(1);
  });

  it("is `changed` for a different file than reviewed, with zero Moodle calls, and the code still works", async () => {
    const r = await review();
    expect(await confirmHandin(her, r.code, OTHER_PDF, opts())).toEqual({ ok: false, reason: "changed" });
    expect(moodle.calls).toEqual([]);
    const [code] = await t.db.select().from(confirmCodes).where(eq(confirmCodes.id, r.code));
    expect(code.usedAt).toBeNull();
    expect((await confirmHandin(her, r.code, PDF, opts())).ok).toBe(true);
  });

  it("is `not_shown` when Moodle does not list the file, and the assignment stays open", async () => {
    moodleShows([]);
    const r = await review();
    expect(await confirmHandin(her, r.code, PDF, opts())).toEqual({ ok: false, reason: "not_shown" });
    expect(fns()).toEqual([
      "upload",
      "mod_assign_save_submission",
      "mod_assign_submit_for_grading",
      "mod_assign_get_submission_status",
    ]);
    expect(await assignmentRow()).toMatchObject({ state: "open", submittedAt: null });
    expect(await t.db.select().from(submissions)).toEqual([]);
  });

  it("is `not_shown` when the file is there but Moodle still has it as a draft, or the read-back fails", async () => {
    moodleShows([{ filename: PDF.name, filesize: PDF.bytes.byteLength }], "draft");
    expect(await confirmHandin(her, (await review()).code, PDF, opts())).toEqual({ ok: false, reason: "not_shown" });
    moodle.override("mod_assign_get_submission_status", { status: 502, body: {} });
    expect(await confirmHandin(her, (await review()).code, PDF, opts())).toEqual({ ok: false, reason: "not_shown" });
    expect((await assignmentRow()).state).toBe("open");
  });

  it("is `expired` after 10 minutes, with zero Moodle calls", async () => {
    const r = await review();
    const later = { now: new Date(NOW.getTime() + HANDIN_CODE_TTL_MS + 1), db: t.db };
    expect(await confirmHandin(her, r.code, PDF, later)).toEqual({ ok: false, reason: "expired" });
    expect(moodle.calls).toEqual([]);
  });

  it("refuses another user's code without a Moodle call, and leaves it unused", async () => {
    const theirs = await seedAssignment(other);
    const r = await review(PDF, other, theirs);
    const result = await confirmHandin(her, r.code, PDF, opts());
    expect(result).toMatchObject({ ok: false, reason: "refused", message: expect.any(String) });
    expect(await confirmHandin(her, "not-a-uuid", PDF, opts())).toMatchObject({ ok: false, reason: "refused" });
    expect(moodle.calls).toEqual([]);
    const [code] = await t.db.select().from(confirmCodes).where(eq(confirmCodes.id, r.code));
    expect(code.usedAt).toBeNull();
  });

  it("refuses when the assignment closed or her key is gone since the review, without a Moodle call", async () => {
    const r = await review();
    await t.db.update(assignments).set({ state: "submitted" }).where(eq(assignments.id, assignmentId));
    expect(await confirmHandin(her, r.code, PDF, opts())).toMatchObject({ ok: false, reason: "refused" });
    await t.db.update(assignments).set({ state: "open" }).where(eq(assignments.id, assignmentId));
    await t.db.delete(moodleConnections).where(eq(moodleConnections.userId, her));
    expect(await confirmHandin(her, r.code, PDF, opts())).toMatchObject({ ok: false, reason: "refused" });
    expect(moodle.calls).toEqual([]);
  });

  it("is `moodle_down` when Moodle fails; the code is spent and a new review works", async () => {
    moodle.override("upload", { status: 502, body: {} });
    const r = await review();
    expect(await confirmHandin(her, r.code, PDF, opts())).toEqual({ ok: false, reason: "moodle_down" });
    expect(fns()).toEqual(["upload"]);
    expect((await assignmentRow()).state).toBe("open");
    // The used code is not re-armed: trying it again makes no call.
    const before = moodle.calls.length;
    expect(await confirmHandin(her, r.code, PDF, opts())).toEqual({ ok: false, reason: "expired" });
    expect(moodle.calls.length).toBe(before);

    moodle.override("upload", {
      body: [{ component: "user", filearea: "draft", filename: PDF.name, filepath: "/", itemid: 777001 }],
    });
    expect((await confirmHandin(her, (await review()).code, PDF, opts())).ok).toBe(true);
  });

  it("is `refused` with Moodle's message when Moodle refuses the save, and makes no submit call", async () => {
    moodle.override("mod_assign_save_submission", {
      body: [{ item: String(ASSIGN), itemid: ASSIGN, warningcode: "couldnotsavesubmission", message: "Could not save submission" }],
    });
    const r = await review();
    expect(await confirmHandin(her, r.code, PDF, opts())).toEqual({
      ok: false,
      reason: "refused",
      message: "Could not save submission",
    });
    expect(fns()).toEqual(["upload", "mod_assign_save_submission"]);
    expect((await assignmentRow()).state).toBe("open");
  });

  it("is `refused` with Moodle's message when her key is rejected", async () => {
    moodle.rejectToken();
    const result = await confirmHandin(her, (await review()).code, PDF, opts());
    expect(result).toEqual({ ok: false, reason: "refused", message: "Invalid token - token not found" });
    expect(fns()).toEqual(["upload"]);
  });
});

describe("hand-in actions", () => {
  function formWith(file: { name: string; bytes: Uint8Array }) {
    const form = new FormData();
    form.append("file", new File([file.bytes as BlobPart], file.name, { type: "application/pdf" }));
    return form;
  }

  it("take the user from the session, never from the browser", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(await prepareHandinAction(assignmentId, formWith(PDF))).toEqual({ ok: false, reason: "signed_out" });

    signedIn.userId = other;
    expect(await prepareHandinAction(assignmentId, formWith(PDF))).toEqual({ ok: false, reason: "not_found" });

    signedIn.userId = her;
    expect(await prepareHandinAction("nope", formWith(PDF))).toEqual({ ok: false, reason: "invalid" });
    expect(await prepareHandinAction(assignmentId, "no form")).toEqual({ ok: false, reason: "invalid" });
    const prepared = await prepareHandinAction(assignmentId, formWith(PDF));
    if (!prepared.ok) throw new Error(prepared.reason);

    signedIn.userId = other;
    expect(await confirmHandinAction(prepared.review.code, formWith(PDF))).toMatchObject({ reason: "refused" });
    expect(moodle.calls).toEqual([]);

    signedIn.userId = her;
    expect(await confirmHandinAction(prepared.review.code, formWith(OTHER_PDF))).toEqual({ ok: false, reason: "changed" });
    const done = await confirmHandinAction(prepared.review.code, formWith(PDF));
    expect(done).toMatchObject({ ok: true, receipt: { fileName: "memo.pdf", to: "Strategy Course › Case memo 2" } });
    expect(fns()).toEqual([
      "upload",
      "mod_assign_save_submission",
      "mod_assign_submit_for_grading",
      "mod_assign_get_submission_status",
    ]);
  });
});
