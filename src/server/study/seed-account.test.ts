// @vitest-environment node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import { cards, cardStates, concepts, exams } from "@/server/db/schema/study";
import { confirmCodes, sessions, users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { parseArgs, run } from "../../../scripts/study/seed-account";
import { getAssignmentPage } from "@/server/data/assignment";
import { syncNow } from "@/server/sync/run";
import type { ImportResult } from "./import-bundle";
import {
  applySeed,
  assignmentMoodleId,
  courseMoodleId,
  loadSeed,
  planSeed,
  redeemOpenCode,
  SeedInvalid,
  SeedRefused,
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
        { name: "Summer essay", due: "2026-06-15 12:00" },
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

describe("CLI", () => {
  it("parses its arguments", () => {
    expect(parseArgs(["a", "b", "--name", "Testi", "--dry-run"])).toMatchObject({ ok: true, args: { name: "Testi", dryRun: true, linkOnly: false, origin: "http://localhost:3000" } });
    expect(parseArgs(["a", "--link", "--origin", "https://preview.example.test/x"])).toMatchObject({ ok: true, args: { linkOnly: true, bundlesDir: null, origin: "https://preview.example.test" } });
    expect(parseArgs(["a"])).toMatchObject({ ok: false });
    expect(parseArgs(["a", "b", "--origin", "ftp://x"])).toMatchObject({ ok: false });
    expect(parseArgs(["a", "--link", "--dry-run"])).toMatchObject({ ok: false });
  });

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
