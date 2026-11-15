// @vitest-environment node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { lectureConcepts, lectureContent, lectures } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import { cardConcepts, cards, cardStates, concepts, examDocuments, exams } from "@/server/db/schema/study";
import { confirmCodes, sessions, users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { parseArgs, run } from "../../../scripts/study/seed-account";
import { logIn } from "@/server/auth/accounts";
import { getAssignmentPage } from "@/server/data/assignment";
import { syncNow } from "@/server/sync/run";
import type { ImportResult } from "./import-bundle";
import {
  applyAccountPart,
  applyBundlePart,
  applySeed,
  assignmentMoodleId,
  bundlePartsOf,
  combineAnswers,
  courseMoodleId,
  loadSeed,
  planSeed,
  readSeedPart,
  redeemOpenCode,
  SeedInvalid,
  SeedRefused,
  seedPartsOf,
  serialisePart,
  UPLOAD_PART_BYTES,
  type ExamBundlePart,
  type SeedAnswer,
  type SeedInput,
  type SeedResult,
} from "./seed-account";

// Invented data only: the sample account and the sample bundles of tests/fixtures/study.
const ACCOUNT = path.join(process.cwd(), "tests/fixtures/study/sample-account");
const BUNDLE = path.join(process.cwd(), "tests/fixtures/study/sample-bundle");
const STUDY_ONLY = path.join(process.cwd(), "tests/fixtures/study/sample-study-only");
const NOW = new Date("2026-11-15T10:00:00Z");
const T = 90_000;

const BUNDLES_ACCOUNT = {
  exams: [
    {
      courseCode: "TST-E0001",
      title: "Forecasting final",
      kind: "exam",
      at: "2026-12-11T09:00:00+02:00",
      atIsPlaceholderTime: true,
      source: "invented syllabus",
    },
    { courseCode: "TST-E0002", title: "Lab exam", kind: "exam", at: null, atIsPlaceholderTime: false, source: "invented" },
  ],
  gradeWeights: [
    {
      courseCode: "TST-E0001",
      items: [
        { name: "Exercises", weight: 40 },
        { name: "Final exam", weight: 60 },
      ],
      passRule: "Half of the exam points",
      gradeBands: [{ grade: 1, from: 50 }],
      note: "Invented.",
      source: "invented syllabus",
    },
  ],
  aiAllowed: [
    { courseCode: "TST-E0001", allowed: true },
    { courseCode: "TST-E0003", allowed: false, scope: "assignments" },
    { courseCode: "TST-E0002", allowed: "unknown" },
  ],
  unknown: [],
  noExam: ["TST-E0003"],
};

const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));

let bundles: string;
let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "seed-account-"));
  bundles = path.join(tmp, "bundles");
  await cp(BUNDLE, path.join(bundles, "TST-E0001"), { recursive: true });
  await cp(STUDY_ONLY, path.join(bundles, "TST-E0003"), { recursive: true });
  await write(path.join(bundles, "account.json"), BUNDLES_ACCOUNT);
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
}, T);
afterEach(async () => {
  await t.close();
});

const TABLES = { users, courses, assignments, events, gradeItems, exams, concepts, cards, cardStates, lectures, lectureContent };
async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table);
    out[name] = row.n;
  }
  return out;
}

async function seed(opts: { dryRun?: boolean; accountDir?: string; name?: string } = {}): Promise<SeedResult> {
  const plan = planSeed(await loadSeed(opts.accountDir ?? ACCOUNT, bundles));
  return applySeed(t.db, plan, { dryRun: opts.dryRun, name: opts.name ?? "Testi", now: NOW });
}

const touched = (r: SeedResult) =>
  [...Object.values(r.counts), ...r.imports.flatMap((i) => Object.values(i.counts))].reduce((s, c) => s + c.created + c.updated, 0);

describe("planSeed (pure)", () => {
  it("gives every course a stable negative int4 moodle_id from its code", () => {
    for (const code of ["TST-E0001", "TST-E0002", "tst-e0001 "]) {
      const id = courseMoodleId(code);
      expect(id).toBeLessThan(0);
      expect(id).toBeGreaterThanOrEqual(-2147483648);
    }
    expect(courseMoodleId("tst-e0001 ")).toBe(courseMoodleId("TST-E0001"));
    expect(courseMoodleId("TST-E0001")).not.toBe(courseMoodleId("TST-E0002"));
    expect(assignmentMoodleId("TST-E0002", "Lab report 2")).toBeLessThan(0);
  });

  it(
    "plans the account: weights as fractions, the dated exam under the bundle's title, the undated one skipped",
    async () => {
      const plan = planSeed(await loadSeed(ACCOUNT, bundles));
      expect(plan.courses.map((c) => c.code)).toEqual(["TST-E0001", "TST-E0002", "TST-E0003"]);
      const [one, two, three] = plan.courses;
      expect(one.weights.map((w) => [w.name, w.weight])).toEqual([
        ["Exercises", 0.4],
        ["Final exam", 0.6],
      ]);
      expect(one.aiPolicy).toEqual({ aiAssignments: "allowed", aiStudy: "allowed" });
      expect(two.aiPolicy).toBeNull();
      expect(three.aiPolicy).toEqual({ aiAssignments: "off", aiStudy: "allowed" });
      // A file id is the real Moodle id; none: a negative one.
      expect(one.assignments.map((a) => [a.moodleId, a.state])).toEqual([
        [910001, "open"],
        [910002, "graded"],
      ]);
      expect(two.assignments[0].moodleId).toBe(assignmentMoodleId("TST-E0002", "Lab report 2"));
      expect(two.assignments[0].state).toBe("draft");
      // Events: an id gives the sync's moodle_ref; none, a seed ref.
      expect(one.events.map((e) => [e.moodleRef, e.source, e.kind])).toEqual([
        ["event:930001", "moodle", "deadline"],
        ["event:930002", "moodle", "other"],
      ]);
      expect(three.events[0].source).toBe("manual");
      expect(three.events[0].moodleRef).toMatch(/^seed:/);
      // One course, one exam: account.json's date and kind, the bundle's title and target.
      expect(plan.exams).toEqual([
        { courseCode: "TST-E0001", title: "Intro to Forecasting final exam", kind: "exam", at: new Date("2026-12-11T07:00:00Z"), targetPct: expect.any(Number) },
      ]);
      expect(plan.skipped.some((s) => s.includes('"Lab exam"') && s.includes("no date"))).toBe(true);
      expect(plan.notStored.join(" ")).toMatch(/passRule, gradeBands, note/);
      expect(plan.notes.join(" ")).toMatch(/placeholder/);
      expect(plan.bundles.map((b) => [b.kind, b.courseCode])).toEqual([
        ["exam", "TST-E0001"],
        ["studyOnly", "TST-E0003"],
      ]);
    },
    T,
  );
});

describe("applySeed", () => {
  it(
    "creates the user, courses, assignments, calendar entries, the exam, weights and the imported bundle",
    async () => {
      const r = await seed();
      expect(r.dryRun).toBe(false);
      const [user] = await t.db.select().from(users).where(eq(users.id, r.userId));
      expect(user.displayName).toBe("Testi");
      expect(user.settings.demo).toBeUndefined();
      expect((user.settings.seededFrom as { key: string }).key).toMatch(/^[0-9a-f]{64}$/);
      expect(await t.db.select().from(moodleConnections)).toHaveLength(0);

      const hers = await t.db.select().from(courses).where(eq(courses.userId, r.userId));
      expect(hers.map((c) => [c.code, c.moodleId < 0]).sort()).toEqual([
        ["TST-E0001", true],
        ["TST-E0002", true],
        ["TST-E0003", true],
      ]);
      const one = hers.find((c) => c.code === "TST-E0001")!;
      expect([one.aiAssignments, one.aiStudy]).toEqual(["allowed", "allowed"]);

      const rows = await t.db.select().from(assignments).where(eq(assignments.userId, r.userId));
      expect(rows).toHaveLength(3);
      expect(rows.find((a) => a.moodleId === 910001)!.dueAt).toEqual(new Date("2026-11-20T21:59:00Z"));
      expect(await t.db.select().from(events)).toHaveLength(3);

      const weights = await t.db.select().from(gradeItems).where(eq(gradeItems.courseId, one.id));
      expect(weights.map((w) => [w.name, w.weight, w.weightSource, w.max])).toEqual(
        expect.arrayContaining([
          ["Exercises", 0.4, "manual", 100],
          ["Final exam", 0.6, "manual", 100],
        ]),
      );

      // One exam for the course: account.json's date, the bundle's cards.
      const examRows = await t.db.select().from(exams).where(eq(exams.userId, r.userId));
      expect(examRows).toHaveLength(1);
      expect(examRows[0].title).toBe("Intro to Forecasting final exam");
      expect(examRows[0].at).toEqual(new Date("2026-12-11T07:00:00Z"));
      expect(examRows[0].studyMap).not.toBeNull();
      const cardRows = await t.db.select().from(cards).where(eq(cards.examId, examRows[0].id));
      expect(cardRows.length).toBeGreaterThan(0);
      expect(r.counts.exams.created).toBe(1);
      const imported = r.imports.find((i) => i.courseCode === "TST-E0001") as ImportResult;
      // The importer found the exam account.json made (by title) instead of making a second one.
      expect(imported.counts.exam.created).toBe(0);

      // The study-only course brought its page.
      const three = hers.find((c) => c.code === "TST-E0003")!;
      const lec = await t.db.select().from(lectures).where(eq(lectures.courseId, three.id));
      expect(lec).toHaveLength(1);
      expect(await t.db.select().from(lectureContent).where(eq(lectureContent.lectureId, lec[0].id))).toHaveLength(1);

      expect(r.skipped.some((s) => s.includes('"Lab exam"'))).toBe(true);
    },
    T,
  );

  it(
    "changes nothing on a second run, and reuses the same user",
    async () => {
      const first = await seed();
      const before = await rowCounts();
      const second = await seed();
      expect(second.userId).toBe(first.userId);
      expect(await rowCounts()).toEqual(before);
      expect(touched(second)).toBe(0);
    },
    T,
  );

  it(
    "updates in place when a file changed (a moved due date)",
    async () => {
      const first = await seed();
      const moved = path.join(tmp, "moved-account");
      await cp(ACCOUNT, moved, { recursive: true });
      const raw = JSON.parse(await readFile(path.join(moved, "account.json"), "utf8"));
      raw.courses[0].assignments[0].dueAt = "2026-11-21T21:59:00.000Z";
      await write(path.join(moved, "account.json"), raw);
      // Another folder is another student unless account.json names her: give it the same key by copying the marker.
      const plan = planSeed(await loadSeed(moved, bundles));
      await t.db.update(users).set({ settings: { seededFrom: { key: plan.key, pulledAt: plan.pulledAt } } }).where(eq(users.id, first.userId));
      const r = await applySeed(t.db, plan, { now: NOW });
      expect(r.userId).toBe(first.userId);
      expect(r.counts.assignments).toEqual({ created: 0, skipped: 2, updated: 1 });
      expect(await t.db.select().from(assignments)).toHaveLength(3);
    },
    T,
  );

  it(
    "writes nothing on a dry run, and still counts",
    async () => {
      const r = await seed({ dryRun: true });
      expect(r.dryRun).toBe(true);
      expect(r.counts.courses.created).toBe(3);
      expect(r.imports.length).toBe(2);
      expect(Object.values(await rowCounts()).every((n) => n === 0)).toBe(true);
    },
    T,
  );

  it(
    "rejects a shape mismatch with a path-named message, and writes nothing",
    async () => {
      const bad = path.join(tmp, "bad-account");
      await cp(ACCOUNT, bad, { recursive: true });
      const raw = JSON.parse(await readFile(path.join(bad, "account.json"), "utf8"));
      raw.courses[0].assignments[0].dueAt = "next friday";
      delete raw.courses[1].name;
      raw.courses[2].calendarNext60Days = [{ title: "No time" }];
      await write(path.join(bad, "account.json"), raw);
      const err = await loadSeed(bad, bundles).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SeedInvalid);
      const text = (err as SeedInvalid).problems.join("\n");
      expect(text).toContain("<account-dir>/account.json (at courses.0.assignments.0.dueAt)");
      expect(text).toContain("(at courses.1.name)");
      expect(text).toContain("(at courses.2.calendarNext60Days.0)");

      const lines: string[] = [];
      const code = await run([bad, bundles, "--dry-run"], t.db, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("courses.0.assignments.0.dueAt");
      expect(Object.values(await rowCounts()).every((n) => n === 0)).toBe(true);

      const badBundles = path.join(tmp, "bad-bundles");
      await cp(bundles, badBundles, { recursive: true });
      await write(path.join(badBundles, "account.json"), { ...BUNDLES_ACCOUNT, gradeWeights: [{ courseCode: "TST-E0001", items: [{ name: "Exam" }] }] });
      const err2 = await loadSeed(ACCOUNT, badBundles).catch((e: unknown) => e);
      expect((err2 as SeedInvalid).problems.join("\n")).toContain("<bundles-dir>/account.json (at gradeWeights.0.items.0)");
    },
    T,
  );

  it(
    "is skipped quietly by the sync: not_connected, no error state, nothing changed",
    async () => {
      const r = await seed();
      const before = await rowCounts();
      expect(await syncNow(r.userId, { force: true }, t.db)).toEqual({ ran: false, added: 0, status: "not_connected", more: false });
      expect(await rowCounts()).toEqual(before);
      expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
      // The assignment page knows she is not connected, so it offers "Connect ... to hand in".
      const [a] = await t.db.select().from(assignments).where(eq(assignments.userId, r.userId)).limit(1);
      expect((await getAssignmentPage(r.userId, a.id, t.db))?.connected).toBe(false);
    },
    T,
  );

  it(
    "refuses to seed again once she has connected MyCourses",
    async () => {
      const r = await seed();
      await t.db.insert(moodleConnections).values({ userId: r.userId, siteUrl: "https://moodle.example.test", moodleUserId: 1, tokenSealed: "not-a-real-sealed-key" });
      await expect(seed()).rejects.toBeInstanceOf(SeedRefused);
    },
    T,
  );
});

describe("shapes a real hand-made bundles folder has (M3-57 follow-up)", () => {
  it(
    "takes course folders over a stray root seed, weightPct/maxPoints, a gradeTarget object beside targetPct, a repeated concept name, and a study-only seed with no courseCode",
    async () => {
      const real = path.join(tmp, "real-shaped");
      await cp(bundles, real, { recursive: true });
      // A copy of one course's seed left at the top, beside the course folders.
      await cp(path.join(real, "TST-E0001", "seed.json"), path.join(real, "seed.json"));
      // The exam seed: target written both ways (they disagree), and one concept name under two slugs.
      const seedFile = path.join(real, "TST-E0001", "seed.json");
      const examSeed = JSON.parse(await readFile(seedFile, "utf8"));
      examSeed.exam.targetPct = 72;
      examSeed.exam.gradeTarget = { grade: 4, examPointsNeeded: 31, of: 40, assumes: "invented" };
      examSeed.concepts.push({ slug: "moving-average-again", name: examSeed.concepts[0].name, lecture: 1, position: 9, weight: 1 });
      await write(seedFile, examSeed);
      // The study-only seed carries no code: its folder name is the code.
      const studyFile = path.join(real, "TST-E0003", "seed.json");
      const studySeed = JSON.parse(await readFile(studyFile, "utf8"));
      delete studySeed.courseCode;
      await write(studyFile, studySeed);
      await write(path.join(real, "account.json"), {
        ...BUNDLES_ACCOUNT,
        gradeWeights: [
          { courseCode: "TST-E0001", items: [{ name: "Final exam", weightPct: 60, maxPoints: 40 }, { name: "Assignments", weightPct: 40 }] },
        ],
      });

      const plan = planSeed(await loadSeed(ACCOUNT, real));
      const r = await applySeed(t.db, plan, { name: "Testi", now: NOW });
      expect(r.imports.map((i) => i.courseCode).sort()).toEqual(["TST-E0001", "TST-E0003"]);
      expect(await t.db.select().from(lectureContent)).toHaveLength(2);

      const [exam] = await t.db.select().from(exams).where(eq(exams.userId, r.userId));
      expect(exam.targetPct).toBe(72);
      expect(exam.gradeTarget).toEqual({ grade: 4, examPointsNeeded: 31, of: 40, assumes: "invented" });

      const sameName = (await t.db.select().from(concepts).where(eq(concepts.userId, r.userId))).filter((c) => c.name === examSeed.concepts[0].name);
      expect(sameName.map((c) => c.slug).sort()).toEqual(["moving-average", "moving-average-again"]);

      const items = await t.db.select().from(gradeItems).where(eq(gradeItems.userId, r.userId));
      const final = items.find((g) => g.name === "Final exam")!;
      expect(Number(final.weight)).toBeCloseTo(0.6);
      expect(Number(final.max)).toBe(40);
      expect(Number(items.find((g) => g.name === "Assignments")!.weight)).toBeCloseTo(0.4);

      // A second run still changes nothing.
      const again = await applySeed(t.db, planSeed(await loadSeed(ACCOUNT, real)), { name: "Testi", now: NOW });
      expect(touched(again)).toBe(0);
    },
    T,
  );
});

describe("an account file pulled by hand (M3-57 follow-up 2)", () => {
  it(
    "reads due, cutoff, opens and at as Helsinki local time, and names a course as the sync would",
    async () => {
      const dir = path.join(tmp, "hand-pulled");
      const account = JSON.parse(await readFile(path.join(ACCOUNT, "account.json"), "utf8"));
      account.courses[0].name = `${account.courses[0].code} - Intro to Forecasting, Contact teaching, 21.10.2026-2.12.2026`;
      account.courses[0].assignments = [
        { name: "Winter essay", due: "2026-11-20 23:59", cutoff: "2026-11-27 23:59", opens: "2026-11-01 08:00", maxFiles: 1 },
        { name: "Summer essay", due: "2026-06-15 12:00", status: "new" },
        { name: "Zoned essay", due: "2026-11-20T23:59:00+02:00" },
        { name: "No date essay" },
      ];
      account.courses[0].calendarNext60Days = [{ name: "Guest lecture", at: "2026-11-26 10:15", module: "", type: "course" }];
      await cp(ACCOUNT, dir, { recursive: true });
      await write(path.join(dir, "account.json"), account);

      const r = await applySeed(t.db, planSeed(await loadSeed(dir, bundles)), { name: "Testi", now: NOW });
      const rows = await t.db.select().from(assignments).where(eq(assignments.userId, r.userId));
      const byName = (n: string) => rows.find((a) => a.name === n)!;
      // November is UTC+2 in Helsinki, June is UTC+3.
      expect(byName("Winter essay").dueAt?.toISOString()).toBe("2026-11-20T21:59:00.000Z");
      expect(byName("Winter essay").cutoffAt?.toISOString()).toBe("2026-11-27T21:59:00.000Z");
      expect(byName("Winter essay").opensAt?.toISOString()).toBe("2026-11-01T06:00:00.000Z");
      expect(byName("Summer essay").dueAt?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
      expect(byName("Zoned essay").dueAt?.toISOString()).toBe("2026-11-20T21:59:00.000Z");
      expect(byName("No date essay").dueAt).toBeNull();

      const [event] = (await t.db.select().from(events).where(eq(events.userId, r.userId))).filter((e) => e.title === "Guest lecture");
      expect(event.startsAt.toISOString()).toBe("2026-11-26T08:15:00.000Z");

      const [course] = (await t.db.select().from(courses).where(eq(courses.userId, r.userId))).filter((c) => c.code === account.courses[0].code);
      expect(course.name).toBe("Intro to Forecasting, Contact teaching, 21.10.2026-2.12.2026");
      // On screen she sees the short name (the assignment page's loader cuts the rest off).
      expect((await getAssignmentPage(r.userId, byName("Winter essay").id, t.db))?.course).toBe("Intro to Forecasting");

      // A second run on a corrected file updates the same rows in place.
      account.courses[0].assignments[0].due = "2026-11-21 23:59";
      await write(path.join(dir, "account.json"), account);
      const before = await rowCounts();
      const again = await applySeed(t.db, planSeed(await loadSeed(dir, bundles)), { name: "Testi", now: NOW });
      expect(again.userId).toBe(r.userId);
      expect(await rowCounts()).toEqual(before);
      const [moved] = (await t.db.select().from(assignments).where(eq(assignments.userId, r.userId))).filter((a) => a.name === "Winter essay");
      expect(moved.id).toBe(byName("Winter essay").id);
      expect(moved.dueAt?.toISOString()).toBe("2026-11-21T21:59:00.000Z");

      // A time that does not exist is refused with its path.
      account.courses[0].assignments[0].due = "2026-13-40 25:00";
      await write(path.join(dir, "account.json"), account);
      const err = await loadSeed(dir, bundles).catch((e: unknown) => e);
      expect((err as SeedInvalid).problems.join("\n")).toContain("courses.0.assignments.0.due");
    },
    T,
  );
});

describe("past-due assignments with no known hand-in status (M3-57 follow-up 3)", () => {
  const HAND = [
    { name: "Old essay", due: "2026-10-01 23:59" },
    { name: "Old quiz prep", due: "2026-10-10 23:59" },
    { name: "Old lab", due: "2026-10-20 23:59" },
    { name: "Coming essay", due: "2026-11-25 23:59" },
    { name: "No date task" },
  ];
  async function handDir(name: string) {
    const dir = path.join(tmp, name);
    const account = JSON.parse(await readFile(path.join(ACCOUNT, "account.json"), "utf8"));
    account.courses[0].assignments = HAND;
    await cp(ACCOUNT, dir, { recursive: true });
    await write(path.join(dir, "account.json"), account);
    return { dir, code: account.courses[0].code as string };
  }
  const namesOf = async (userId: string) =>
    (await t.db.select().from(assignments).where(eq(assignments.userId, userId))).map((a) => a.name).sort();

  it(
    "skips them and says how many; upcoming and undated ones come in as open",
    async () => {
      const { dir } = await handDir("past-unknown");
      const r = await applySeed(t.db, planSeed(await loadSeed(dir, bundles)), { name: "Testi", now: NOW });
      const mine = (await namesOf(r.userId)).filter((n) => HAND.some((h) => h.name === n));
      expect(mine).toEqual(["Coming essay", "No date task"]);
      expect(r.skipped.join("\n")).toContain("3 assignments due before the files were pulled, with no hand-in status known: not created");
    },
    T,
  );

  it(
    "uses the status files of account-status.mjs: handed in, graded and known-open ones are stored; only the unknown one is skipped",
    async () => {
      const { dir, code } = await handDir("past-known");
      await write(path.join(dir, `${code}.json`), {
        course: { id: 1, shortname: `${code}_invented-instance`, fullname: "Invented" },
        assignments: [
          { id: 1, name: "Old essay", status: "submitted", graded: false, submittedAt: "2026-09-30T10:00:00.000Z" },
          { id: 2, name: "old quiz  prep", status: "submitted", graded: true },
          { id: 3, name: "Old lab", status: null, graded: false, error: "accessexception: invented" },
          { id: 4, name: "Coming essay", status: "new", graded: false },
        ],
        grades: [],
        errors: [],
      });
      // Another course's file must not lend its statuses to this one.
      await write(path.join(dir, "OTHER.json"), { course: { shortname: "OTHER-X1", fullname: "Other" }, assignments: [{ name: "Old lab", status: "submitted" }] });

      const r = await applySeed(t.db, planSeed(await loadSeed(dir, bundles)), { name: "Testi", now: NOW });
      const rows = await t.db.select().from(assignments).where(eq(assignments.userId, r.userId));
      const stateOf = (n: string) => rows.find((a) => a.name === n)?.state;
      expect(stateOf("Old essay")).toBe("submitted");
      expect(rows.find((a) => a.name === "Old essay")?.submittedAt?.toISOString()).toBe("2026-09-30T10:00:00.000Z");
      expect(stateOf("Old quiz prep")).toBe("graded");
      expect(stateOf("Old lab")).toBeUndefined();
      expect(stateOf("Coming essay")).toBe("open");
      expect(r.skipped.join("\n")).toContain("1 assignment due before the files were pulled");
    },
    T,
  );

  it(
    "a rerun removes the past-due rows an earlier run of the seed created, and nothing a sync wrote",
    async () => {
      const { dir } = await handDir("past-rerun");
      // An earlier run, from before this rule: everything came in as open.
      const input = await loadSeed(dir, bundles);
      const longAgo = new Date("2026-01-01T00:00:00Z");
      const early = planSeed({ ...input, account: { ...input.account, pulledAt: "2026-01-01T00:00:00.000Z" } }, longAgo);
      const first = await applySeed(t.db, { ...early, pulledAt: input.account.pulledAt ?? null }, { name: "Testi", now: NOW });
      expect((await namesOf(first.userId)).filter((n) => n.startsWith("Old"))).toHaveLength(3);
      // A row a real sync wrote (a real, positive Moodle id) with the same kind of past date.
      const [course] = await t.db.select().from(courses).where(eq(courses.userId, first.userId)).limit(1);
      await t.db.insert(assignments).values({ userId: first.userId, courseId: course.id, moodleId: 555001, name: "Synced old task", dueAt: new Date("2026-10-05T10:00:00Z") });

      const r = await applySeed(t.db, planSeed(input), { name: "Testi", now: NOW });
      expect(r.userId).toBe(first.userId);
      const left = await namesOf(r.userId);
      expect(left.filter((n) => n.startsWith("Old"))).toEqual([]);
      expect(left).toContain("Synced old task");
      expect(left).toContain("Coming essay");
      expect(r.notes.join("\n")).toContain("Removed 3 past-due assignments an earlier run created");

      // And once more: nothing left to remove, nothing changes.
      const before = await rowCounts();
      const again = await applySeed(t.db, planSeed(input), { name: "Testi", now: NOW });
      expect(await rowCounts()).toEqual(before);
      expect(again.notes.join("\n")).not.toContain("Removed");
      expect(touched(again)).toBe(0);
    },
    T,
  );
});

describe("CLI", () => {
  it("parses its arguments", () => {
    expect(parseArgs(["a", "b", "--name", "Testi", "--dry-run"])).toMatchObject({ ok: true, args: { name: "Testi", dryRun: true, linkOnly: false, origin: "http://localhost:3000" } });
    expect(parseArgs(["a", "--link", "--origin", "https://preview.example.test/x"])).toMatchObject({ ok: true, args: { linkOnly: true, bundlesDir: null, origin: "https://preview.example.test" } });
    expect(parseArgs(["a"])).toMatchObject({ ok: false });
    expect(parseArgs(["a", "b", "--origin", "ftp://x"])).toMatchObject({ ok: false });
    expect(parseArgs(["a", "--link", "--dry-run"])).toMatchObject({ ok: false });
    // M5-14: a username, and a password asked at a prompt: never taken as an argument.
    expect(parseArgs(["a", "b", "--username", "Test.Student"])).toMatchObject({ ok: true, args: { username: "Test.Student", setPassword: false } });
    expect(parseArgs(["a", "--link", "--set-password"])).toMatchObject({ ok: true, args: { setPassword: true } });
    expect(parseArgs(["a", "b", "--username"])).toMatchObject({ ok: false });
    expect(parseArgs(["a", "b", "--username", "no spaces allowed"])).toMatchObject({ ok: false });
    expect(parseArgs(["a", "b", "--password", "correct horse"])).toMatchObject({ ok: false, error: "Unknown option --password." });
    expect(parseArgs(["a", "b", "--set-password", "--dry-run"])).toMatchObject({ ok: false });
  });

  it(
    "--username asks for the password at the prompt, stores only its hash, and --set-password changes it later (M5-14)",
    async () => {
      // Invented name and passwords only.
      const lines: string[] = [];
      const answers: string[] = [];
      const asked: string[] = [];
      const io = {
        out: (l: string) => lines.push(l),
        err: (l: string) => lines.push(l),
        askHidden: async (q: string) => {
          asked.push(q);
          return answers.shift() ?? "";
        },
      };

      answers.push("correct horse", "correct horse");
      expect(await run([ACCOUNT, bundles, "--name", "Testi", "--username", "Test.Student"], t.db, io)).toBe(0);
      expect(asked).toHaveLength(2);
      expect(lines.join("\n")).toContain("Log in: username test.student, password set.");
      expect(lines.join("\n")).not.toContain("correct horse");
      const [user] = await t.db.select().from(users).where(eq(users.username, "test.student"));
      expect(user.passwordHash).toMatch(/^scrypt\$/);
      expect(user.passwordHash).not.toContain("correct horse");
      expect((await logIn("test.student", "correct horse", { db: t.db })).ok).toBe(true);

      // A rerun with the same username keeps the password and asks nothing.
      asked.length = 0;
      expect(await run([ACCOUNT, "--link", "--username", "test.student"], t.db, io)).toBe(0);
      expect(asked).toHaveLength(0);

      // --set-password changes it; two different answers change nothing.
      answers.push("a new password", "not the same");
      expect(await run([ACCOUNT, "--link", "--set-password"], t.db, io)).toBe(1);
      expect((await logIn("test.student", "correct horse", { db: t.db })).ok).toBe(true);
      answers.push("a new password", "a new password");
      expect(await run([ACCOUNT, "--link", "--set-password"], t.db, io)).toBe(0);
      expect((await logIn("test.student", "correct horse", { db: t.db })).ok).toBe(false);
      expect((await logIn("test.student", "a new password", { db: t.db })).ok).toBe(true);
      expect(lines.join("\n")).not.toContain("a new password");

      // Too short: refused at the first answer.
      answers.push("four");
      expect(await run([ACCOUNT, "--link", "--set-password"], t.db, io)).toBe(1);
      expect(lines.join("\n")).toContain("Use at least 5 characters. Nothing was set.");
    },
    T,
  );

  it(
    "seeds, prints a one-time link that works once, and --link prints a fresh one",
    async () => {
      const lines: string[] = [];
      const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
      expect(await run([ACCOUNT, bundles, "--name", "Testi", "--origin", "https://preview.example.test"], t.db, io)).toBe(0);
      const text = lines.join("\n");
      expect(text).toMatch(/Skipped:[\s\S]*"Lab exam"/);
      const link = /https:\/\/preview\.example\.test\/open\?code=([A-Za-z0-9_-]{43})/.exec(text);
      expect(link).not.toBeNull();
      const [stored] = await t.db.select().from(confirmCodes);
      expect(stored.purpose).toBe("open");
      expect(stored.payloadHash).not.toContain(link![1]);

      lines.length = 0;
      expect(await run([ACCOUNT, "--link"], t.db, io)).toBe(0);
      const fresh = /\/open\?code=([A-Za-z0-9_-]{43})/.exec(lines.join("\n"))![1];
      // The fresh link retires the old one.
      expect(await redeemOpenCode(t.db, link![1])).toBeNull();
      const opened = await redeemOpenCode(t.db, fresh);
      expect(opened).not.toBeNull();
      expect(await redeemOpenCode(t.db, fresh)).toBeNull();
      expect(await t.db.select().from(sessions).where(eq(sessions.userId, opened!.userId))).toHaveLength(1);
    },
    T,
  );
});

describe("upload: the same seed sent in parts (M3-58)", () => {
  /** A size that makes the sample course folder take several requests. */
  const SMALL = 4_000;

  /** The sample bundles, with cards a plan leaves out: one not valid, one repeated, one reusing an id. */
  async function trickyBundles(): Promise<string> {
    const dir = path.join(tmp, "tricky-bundles");
    await rm(dir, { recursive: true, force: true });
    await cp(bundles, dir, { recursive: true });
    const deckFile = path.join(dir, "TST-E0001", "deck-1.json");
    const deck = JSON.parse(await readFile(deckFile, "utf8")) as Record<string, unknown>[];
    deck.splice(2, 0, { type: "basic", concept: "moving-average" }); // not a card
    for (let i = 1; i <= 60; i++) deck.push({ id: `more-${i}`, type: "basic", concept: "moving-average", q: `Invented question ${i}?`, a: `Invented answer ${i}.`, source: "Lecture 1, slide 9" });
    deck.push({ ...deck[0], id: "tf-copy" }); // the first card again
    deck.push({ id: deck[1].id, type: "basic", concept: "moving-average", q: "An invented question?", a: "An invented answer.", source: "Lecture 1, slide 9" }); // an id used twice
    await write(deckFile, deck);
    return dir;
  }

  const newUser = async (db = t.db) => (await db.insert(users).values({}).returning({ id: users.id }))[0].id;

  /** Sends every part as the route would get it: through JSON, then `readSeedPart`. */
  async function upload(userId: string, input: SeedInput, maxBytes = UPLOAD_PART_BYTES, db = t.db): Promise<SeedAnswer[]> {
    const answers: SeedAnswer[] = [];
    for (const sent of seedPartsOf(input, maxBytes)) {
      const part = readSeedPart(JSON.parse(serialisePart(sent)));
      answers.push(part.part === "account" ? await applyAccountPart(db, userId, part, { now: NOW }) : await applyBundlePart(db, userId, part, { now: NOW }));
    }
    return answers;
  }

  /** Every row the seed writes for one user, without ids and creation times. */
  async function snapshot(db: TestDb["db"], userId: string) {
    const sorted = <R>(rows: R[]) => rows.map((r) => JSON.stringify(r)).sort();
    const mine = await db.select().from(courses).where(eq(courses.userId, userId));
    const codeOf = new Map(mine.map((c) => [c.id, c.code]));
    const a = await db.select().from(assignments).where(eq(assignments.userId, userId));
    const e = await db.select().from(events).where(eq(events.userId, userId));
    const g = await db.select().from(gradeItems).where(eq(gradeItems.userId, userId));
    const x = await db.select().from(exams).where(eq(exams.userId, userId));
    const c = await db.select().from(concepts).where(eq(concepts.userId, userId));
    const l = await db.select().from(lectures).where(eq(lectures.userId, userId));
    const lc = await db.select().from(lectureContent);
    const k = await db.select().from(cards).where(eq(cards.userId, userId));
    const ks = await db.select().from(cardStates);
    const d = await db.select().from(examDocuments).where(eq(examDocuments.userId, userId));
    return {
      courses: sorted(mine.map((r) => [r.code, r.name, r.moodleId, r.color, r.aiAssignments, r.aiStudy])),
      assignments: sorted(a.map((r) => [codeOf.get(r.courseId), r.moodleId, r.cmid, r.name, r.dueAt, r.cutoffAt, r.opensAt, r.state, r.submittedAt, r.needsSubmitButton])),
      events: sorted(e.map((r) => [codeOf.get(r.courseId ?? ""), r.moodleRef, r.source, r.kind, r.title, r.startsAt])),
      gradeItems: sorted(g.map((r) => [codeOf.get(r.courseId), r.moodleRef, r.name, r.weight, r.weightSource, r.max, r.position])),
      exams: sorted(x.map((r) => [codeOf.get(r.courseId), r.title, r.kind, r.at, r.targetPct, r.studyMap, r.startNewOn, r.gradeTarget])),
      concepts: sorted(c.map((r) => [r.slug, r.name, r.lecture, r.position, r.weight])),
      lectures: sorted(l.map((r) => [codeOf.get(r.courseId), r.n, r.title])),
      pages: sorted(lc.map((r) => [r.sourceHash, r.breath, r.minutes, r.sections, r.slideTitles])),
      cards: sorted(k.map((r) => [r.contentHash, r.importId, r.type, r.rung, r.boss, r.body, r.why, r.source, r.origin])),
      cardStates: sorted(ks.map((r) => [r.dueAt, r.lapses])),
      cardConcepts: (await db.select().from(cardConcepts)).length,
      lectureConcepts: (await db.select().from(lectureConcepts)).length,
      documents: sorted(d.map((r) => [r.slug, r.title, r.bodyMd, r.position])),
    };
  }

  /** What `printResult` prints of a result, without the user line (an upload never makes a user). */
  const printed = (r: Pick<SeedResult, "counts" | "skipped" | "notStored" | "notes"> & { imports: object[] }) => ({
    counts: { ...r.counts, user: null },
    imports: r.imports.map((i) => {
      const { courseId: _c, examId: _e, dryRun: _d, ...rest } = i as Record<string, unknown>;
      void [_c, _e, _d];
      return rest;
    }),
    skipped: r.skipped,
    notStored: r.notStored,
    notes: r.notes,
  });

  it(
    "splits a course folder into batches under the size, account first, with only the cards the plan keeps",
    async () => {
      const input = await loadSeed(ACCOUNT, await trickyBundles());
      const one = seedPartsOf(input);
      expect(one.map((p) => (p.part === "account" ? "account" : `${p.kind} ${p.courseCode} ${p.batch.n}/${p.batch.of}`))).toEqual([
        "account",
        "exam TST-E0001 1/1",
        "studyOnly TST-E0003 1/1",
      ]);

      const exam = input.bundles.find((b) => b.kind === "exam")!;
      const batches = bundlePartsOf(exam, SMALL) as ExamBundlePart[];
      expect(batches.length).toBeGreaterThanOrEqual(3);
      expect(batches.map((b) => b.batch)).toEqual(batches.map((_, i) => ({ n: i + 1, of: batches.length })));
      for (const b of batches) expect(Buffer.byteLength(serialisePart(b))).toBeLessThanOrEqual(SMALL);
      // Every batch carries what concepts are planned from; the exam documents go once.
      for (const b of batches) expect([b.seed, b.map]).toEqual([batches[0].seed, batches[0].map]);
      expect(batches.map((b) => b.documents.length)).toEqual([1, ...batches.slice(1).map(() => 0)]);
      expect(batches.flatMap((b) => b.pages.map((p) => p.lecture))).toEqual([1]);
      // The cards: each kept one once, by its place in the deck file; the bad, the repeated and the reused-id one never.
      const sent = batches.flatMap((b) => b.decks.flatMap((d) => d.indexes));
      expect(sent).toEqual(exam.kind === "exam" ? exam.plan.cards.map((c) => c.index) : []);
      expect(sent).toEqual([1, 2, 4, 5, 6, ...Array.from({ length: 60 }, (_, i) => i + 9)]);
      expect(exam.plan.problems.filter((p) => p.index !== undefined).map((p) => p.index)).toEqual([3, 7, 8, 69, 70]);
      expect(batches.filter((b) => b.decks.length).length).toBeGreaterThanOrEqual(2);

      // A part survives the trip through JSON and the server's schemas.
      for (const p of seedPartsOf(input, SMALL)) expect(() => readSeedPart(JSON.parse(serialisePart(p)))).not.toThrow();
      // One card that cannot fit is said so, by file and place, never by its text.
      const err = (() => {
        try {
          return bundlePartsOf(exam, 1_200);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(SeedInvalid);
      expect((err as SeedInvalid).message).toMatch(/TST-E0001\): .* does not fit in one request \(1200 bytes\)/);
    },
    T,
  );

  it(
    "an upload in several batches gives the rows and the summary of one direct run, and a second upload changes nothing",
    async () => {
      const input = await loadSeed(ACCOUNT, await trickyBundles());
      const plan = planSeed(input);
      const direct = await applySeed(t.db, plan, { now: NOW });

      const other = await createTestDb();
      try {
        const userId = await newUser(other.db);
        const answers = await upload(userId, input, SMALL, other.db);
        expect(answers.length).toBeGreaterThanOrEqual(5);
        expect(await snapshot(other.db, userId)).toEqual(await snapshot(t.db, direct.userId));

        const summary = combineAnswers(plan, answers);
        expect(printed(summary)).toEqual(printed(direct));
        expect(summary.counts.user).toEqual({ created: 0, skipped: 0, updated: 1 });
        // The account is marked as filled from files (Home stays), with no key a direct run could find it by.
        const [user] = await other.db.select().from(users).where(eq(users.id, userId));
        const marker = user.settings.seededFrom as Record<string, unknown>;
        expect(marker.key).toBeUndefined();
        expect(marker.pulledAt).toBe("2026-11-15T08:00:00.000Z");
        expect(await other.db.select().from(users)).toHaveLength(1);

        const before = await snapshot(other.db, userId);
        const again = combineAnswers(plan, await upload(userId, input, SMALL, other.db));
        expect(await snapshot(other.db, userId)).toEqual(before);
        const rerun = await applySeed(t.db, plan, { now: NOW });
        expect(printed(again)).toEqual(printed(rerun));
        expect([...Object.values(again.counts), ...again.imports.flatMap((i) => Object.values(i.counts))].reduce((s, c) => s + c.created + c.updated, 0)).toBe(0);
      } finally {
        await other.close();
      }
    },
    T,
  );

  it(
    "writes only into the account it is given, and takes no user or key from a part",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const [mine, hers] = [await newUser(), await newUser()];
      await upload(mine, input);
      expect(await t.db.select().from(courses).where(eq(courses.userId, hers))).toHaveLength(0);
      expect((await t.db.select().from(courses).where(eq(courses.userId, mine))).length).toBe(3);

      const part = JSON.parse(serialisePart(seedPartsOf(input)[0])) as Record<string, unknown>;
      for (const extra of [{ userId: hers }, { user_id: hers }, { user: { id: hers } }, { key: "0".repeat(64) }, { seededFrom: { key: "k" } }]) {
        expect(() => readSeedPart({ ...part, ...extra })).toThrow(SeedInvalid);
      }
      // A direct run of the same files does not take the uploaded account for its own.
      const direct = await applySeed(t.db, planSeed(input), { now: NOW });
      expect(direct.userId).not.toBe(mine);
      expect(direct.counts.user.created).toBe(1);
    },
    T,
  );

  it(
    "names the path of what does not fit, and never the value",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const [account, exam] = seedPartsOf(input).map((p) => JSON.parse(serialisePart(p)) as Record<string, never>);
      (account.account as { courses: { assignments: { dueAt: string }[] }[] }).courses[0].assignments[0].dueAt = "a secret day";
      (exam.seed as { concepts: { slug: string }[] }).concepts[1].slug = (exam.seed as { concepts: { slug: string }[] }).concepts[0].slug;
      (exam.pages as { page: { breath: number } }[])[0].page.breath = 7;
      const problemsOf = (body: unknown) => {
        try {
          readSeedPart(body);
          return [];
        } catch (e) {
          return (e as SeedInvalid).problems;
        }
      };
      expect(problemsOf(account).join("\n")).toContain("account.courses.0.assignments.0.dueAt: must be a date and time");
      const text = problemsOf(exam).join("\n");
      expect(text).toContain("pages.0.page.breath: breath must be text.");
      expect(text).toContain('Concept slug "…" is used twice.');
      expect(`${problemsOf(account).join("\n")}\n${text}`).not.toMatch(/a secret day|moving-average/);
      expect(problemsOf({ part: "plan" })[0]).toMatch(/^part: must be/);
      expect(problemsOf([1])[0]).toMatch(/^The body must be one part/);
      expect(problemsOf({ ...exam, courseCode: "TST-E0002", seed: undefined })[0]).toMatch(/^seed/);
    },
    T,
  );

  it(
    "once she has connected MyCourses: the account part is refused, a course folder still goes in",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const userId = await newUser();
      await t.db.insert(moodleConnections).values({ userId, siteUrl: "https://moodle.example.test", moodleUserId: 1, tokenSealed: "not-a-real-sealed-key" });
      // A course as the sync writes it: a real, positive Moodle id.
      await t.db.insert(courses).values({ userId, moodleId: 4401, code: "TST-E0001", name: "Intro to Forecasting" });
      const [account, exam, study] = seedPartsOf(input).map((p) => readSeedPart(JSON.parse(serialisePart(p))));
      if (account.part !== "account" || exam.part !== "bundle" || study.part !== "bundle") throw new Error("unexpected parts");

      await expect(applyAccountPart(t.db, userId, account, { now: NOW })).rejects.toBeInstanceOf(SeedRefused);
      expect(await t.db.select().from(assignments)).toHaveLength(0);
      expect((await t.db.select().from(users).where(eq(users.id, userId)))[0].settings.seededFrom).toBeUndefined();

      const went = await applyBundlePart(t.db, userId, exam, { now: NOW });
      expect(went).toMatchObject({ imported: true, counts: { exam: { created: 1 }, cards: { created: 5 } } });
      // A folder whose course she does not have is said so, and nothing of it is written.
      const not = await applyBundlePart(t.db, userId, study, { now: NOW });
      expect(not).toMatchObject({ imported: false, courseCode: "TST-E0003" });
      expect(combineAnswers(planSeed(input), [went, not]).skipped.join("\n")).toContain("Bundle folder TST-E0003 (TST-E0003): not imported. No course with code TST-E0003");
    },
    T,
  );

  it(
    "a second upload removes the past-due rows the first one wrote, and never a row a sync wrote",
    async () => {
      const dir = path.join(tmp, "upload-past");
      await cp(ACCOUNT, dir, { recursive: true });
      const raw = JSON.parse(await readFile(path.join(dir, "account.json"), "utf8"));
      raw.courses[0].assignments = [
        { id: 700001, name: "Old essay", due: "2026-10-01 23:59" },
        { id: 700002, name: "Synced old task", due: "2026-10-05 23:59" },
        { name: "Old lab", due: "2026-10-20 23:59" },
        { id: 700003, name: "Coming essay", due: "2026-11-25 23:59" },
      ];
      // First as pulled long ago (nothing is past yet), without the task only the sync knows.
      const early = structuredClone(raw);
      early.pulledAt = "2026-01-01T00:00:00.000Z";
      early.courses[0].assignments.splice(1, 1);
      await write(path.join(dir, "account.json"), early);
      const userId = await newUser();
      await upload(userId, await loadSeed(dir, bundles));
      const names = async () => (await t.db.select().from(assignments).where(eq(assignments.userId, userId))).map((a) => a.name).sort();
      expect(await names()).toEqual(expect.arrayContaining(["Old essay", "Old lab", "Coming essay"]));
      // The same Moodle id as a past-due entry of the files, but written by a sync, not by the seed.
      const [course] = await t.db.select().from(courses).where(eq(courses.userId, userId)).limit(1);
      await t.db.insert(assignments).values({ userId, courseId: course.id, moodleId: 700002, name: "Synced old task", dueAt: new Date("2026-10-05T10:00:00Z") });

      await write(path.join(dir, "account.json"), raw);
      const [answer] = await upload(userId, await loadSeed(dir, bundles));
      const left = await names();
      expect(left).not.toContain("Old essay");
      expect(left).not.toContain("Old lab");
      expect(left).toContain("Synced old task");
      expect(left).toContain("Coming essay");
      expect(answer.part === "account" ? answer.notes.join("\n") : "").toContain("Removed 2 past-due assignments an earlier run created");
    },
    T,
  );
});
