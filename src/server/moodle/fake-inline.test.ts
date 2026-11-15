// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "@/server/crypto/seal";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { confirmCodes, users } from "@/server/db/schema/users";
import { assignments, submissions } from "@/server/db/schema/work";
import { confirmHandin } from "@/server/handin/confirm";
import { prepareHandin } from "@/server/handin/prepare";
import { MoodleError, configureMoodleClient, resetMoodleClient, type MoodleConn } from "./client";
import { DEMO_KEY, FAKE_DRAFT_ITEMID, FAKE_QR_KEY, FAKE_QR_USERID, fakeQrLogin, fakeUserKey, resetFake } from "./fake-inline";
import { getSubmissionStatus } from "./read/assignments";
import { saveSubmission, submitForGrading, uploadDraftFile } from "./write";
import { dbConsumeConfirmCode, herTapFromConfirmCode, type HerTap } from "./her-tap";

// Made-up values for tests only.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const SITE = "https://moodle.example.edu";
// In the samples: 7101 hands in on save (submissiondrafts 0), 7301 needs Submit (1).
const NO_SUBMIT_BUTTON = 7101;
const SUBMIT_BUTTON = 7301;
const enc = (s: string) => new TextEncoder().encode(s);
const PDF = { name: "memo.pdf", bytes: enc("%PDF-1.4 fake memo") };

let t: TestDb;

async function seedUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  await t.db.insert(moodleConnections).values({
    userId: u.id,
    siteUrl: SITE,
    moodleUserId: 4242,
    tokenSealed: seal(DEMO_KEY),
  });
  return u.id;
}

const conn = (userId: string): MoodleConn => ({ siteUrl: SITE, token: DEMO_KEY, userId });

/** A real HerTap for the write functions, from a fresh confirm code. */
async function tapFor(userId: string, assignId: number): Promise<HerTap> {
  const [row] = await t.db
    .insert(confirmCodes)
    .values({ userId, purpose: "handin", payloadHash: "h", expiresAt: new Date(Date.now() + 60_000) })
    .returning({ id: confirmCodes.id });
  const made = await herTapFromConfirmCode(
    { userId, assignId, code: row.id, payloadHash: "h" },
    dbConsumeConfirmCode(t.db),
    new Date(),
  );
  if (!made.ok) throw new Error(made.reason);
  return made.tap;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

let her: string;
let other: string;

beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  resetMoodleClient();
  configureMoodleClient({ countStore: null, sleep: async () => {} });
  t = await createTestDb();
  her = await seedUser();
  other = await seedUser();
});

afterEach(async () => {
  resetFake(her);
  resetFake(other);
  vi.unstubAllEnvs();
  await t.close();
});

describe("the fake remembers a hand-in", () => {
  it("upload then save shows the file as submitted when there is no separate Submit", async () => {
    const c = conn(her);
    const tap = await tapFor(her, NO_SUBMIT_BUTTON);
    const itemId = await uploadDraftFile(c, tap, PDF);
    expect(itemId).toBe(FAKE_DRAFT_ITEMID);
    expect(await getSubmissionStatus(c, NO_SUBMIT_BUTTON)).toMatchObject({ state: "none", files: [] });

    await saveSubmission(c, tap, NO_SUBMIT_BUTTON, itemId);
    const s = await getSubmissionStatus(c, NO_SUBMIT_BUTTON);
    expect(s).toEqual({
      state: "submitted",
      submittedAt: expect.any(Date),
      files: [{ name: "memo.pdf", size: PDF.bytes.byteLength }],
      canEdit: false,
    });
  });

  it("shows a draft until Submit when the assignment has a separate Submit", async () => {
    const c = conn(her);
    const tap = await tapFor(her, SUBMIT_BUTTON);
    const itemId = await uploadDraftFile(c, tap, PDF);
    await saveSubmission(c, tap, SUBMIT_BUTTON, itemId);
    expect(await getSubmissionStatus(c, SUBMIT_BUTTON)).toEqual({
      state: "draft",
      submittedAt: null,
      files: [{ name: "memo.pdf", size: PDF.bytes.byteLength }],
      canEdit: true,
    });

    await submitForGrading(c, tap, SUBMIT_BUTTON);
    expect(await getSubmissionStatus(c, SUBMIT_BUTTON)).toMatchObject({
      state: "submitted",
      files: [{ name: "memo.pdf", size: PDF.bytes.byteLength }],
    });
    // Moodle refuses a second save or submit once it is handed in.
    const again = await tapFor(her, SUBMIT_BUTTON);
    const next = await uploadDraftFile(c, again, PDF);
    expect(next).toBe(FAKE_DRAFT_ITEMID + 1);
    expect(await caught(saveSubmission(c, again, SUBMIT_BUTTON, next))).toBeInstanceOf(MoodleError);
  });

  it("refuses a save of an unknown draft and a submit with nothing saved", async () => {
    const c = conn(her);
    const tap = await tapFor(her, SUBMIT_BUTTON);
    await uploadDraftFile(c, tap, PDF);
    expect(await caught(saveSubmission(c, tap, SUBMIT_BUTTON, 123))).toBeInstanceOf(MoodleError);
    const tap2 = await tapFor(her, SUBMIT_BUTTON);
    expect(await caught(submitForGrading(c, tap2, SUBMIT_BUTTON))).toBeInstanceOf(MoodleError);
    expect(await getSubmissionStatus(c, SUBMIT_BUTTON)).toMatchObject({ state: "none", files: [] });
  });

  it("a second user sees nothing of the first user's hand-in", async () => {
    const tap = await tapFor(her, NO_SUBMIT_BUTTON);
    const itemId = await uploadDraftFile(conn(her), tap, PDF);
    await saveSubmission(conn(her), tap, NO_SUBMIT_BUTTON, itemId);

    expect(await getSubmissionStatus(conn(other), NO_SUBMIT_BUTTON)).toEqual({
      state: "none",
      submittedAt: null,
      files: [],
      canEdit: true,
    });
    // Her draft item id is not his either.
    const theirs = await tapFor(other, NO_SUBMIT_BUTTON);
    const otherItem = await uploadDraftFile(conn(other), theirs, PDF);
    expect(otherItem).toBe(FAKE_DRAFT_ITEMID);
    expect(fakeUserKey(conn(her))).not.toBe(fakeUserKey(conn(other)));
  });

  it("resetFake clears that user only", async () => {
    for (const u of [her, other]) {
      const tap = await tapFor(u, NO_SUBMIT_BUTTON);
      const itemId = await uploadDraftFile(conn(u), tap, PDF);
      await saveSubmission(conn(u), tap, NO_SUBMIT_BUTTON, itemId);
    }
    resetFake(her);
    expect(await getSubmissionStatus(conn(her), NO_SUBMIT_BUTTON)).toMatchObject({ state: "none", files: [] });
    expect(await getSubmissionStatus(conn(other), NO_SUBMIT_BUTTON)).toMatchObject({ state: "submitted" });
    // Her next upload starts a fresh draft area again.
    const tap = await tapFor(her, NO_SUBMIT_BUTTON);
    expect(await uploadDraftFile(conn(her), tap, PDF)).toBe(FAKE_DRAFT_ITEMID);
  });

  it("still refuses to run in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await caught(getSubmissionStatus(conn(her), SUBMIT_BUTTON))).toBeInstanceOf(Error);
  });
});

describe("with MOODLE_FAKE=1, prepareHandin then confirmHandin", () => {
  async function seedAssignment(userId: string, moodleId: number, needsSubmitButton: boolean): Promise<string> {
    const [course] = await t.db
      .insert(courses)
      .values({ userId, moodleId: 3100 + moodleId, name: "Strategy Course" })
      .returning();
    const [a] = await t.db
      .insert(assignments)
      .values({ userId, courseId: course.id, moodleId, name: "Case memo 2", acceptsFiles: true, needsSubmitButton })
      .returning();
    return a.id;
  }

  for (const [label, moodleId, needsSubmit] of [
    ["with a separate Submit", SUBMIT_BUTTON, true],
    ["without a separate Submit", NO_SUBMIT_BUTTON, false],
  ] as const) {
    it(`hands in and Moodle lists the file (${label})`, async () => {
      const id = await seedAssignment(her, moodleId, needsSubmit);
      const prepared = await prepareHandin(her, id, PDF, { db: t.db });
      if (!prepared.ok) throw new Error(`prepare refused: ${prepared.reason}`);

      const result = await confirmHandin(her, prepared.review.code, PDF, { db: t.db });
      expect(result).toMatchObject({
        ok: true,
        receipt: { fileName: "memo.pdf", bytes: PDF.bytes.byteLength, to: "Strategy Course › Case memo 2" },
      });
      const [row] = await t.db.select().from(assignments).where(eq(assignments.id, id));
      expect(row.state).toBe("submitted");
      expect(await t.db.select().from(submissions).where(eq(submissions.assignmentId, id))).toHaveLength(1);

      // The other user still has nothing at that assignment.
      expect(await getSubmissionStatus(conn(other), moodleId)).toMatchObject({ state: "none", files: [] });
    });
  }
});

describe("fakeQrLogin (M5-08)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("swaps the sample QR's key for demo-key, again and again", () => {
    expect(fakeQrLogin(FAKE_QR_KEY, FAKE_QR_USERID)).toBe(DEMO_KEY);
    expect(fakeQrLogin(FAKE_QR_KEY, FAKE_QR_USERID)).toBe(DEMO_KEY);
  });

  it("answers invalidkey for any other key or user id", () => {
    for (const [key, userid] of [
      ["otherkey", FAKE_QR_USERID],
      [FAKE_QR_KEY, 7],
    ] as const) {
      const err = (() => {
        try {
          fakeQrLogin(key, userid);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(MoodleError);
      expect((err as MoodleError).errorcode).toBe("invalidkey");
    }
  });

  it("refuses to run on a Vercel production deploy", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => fakeQrLogin(FAKE_QR_KEY, FAKE_QR_USERID)).toThrow(/production/);
  });
});
