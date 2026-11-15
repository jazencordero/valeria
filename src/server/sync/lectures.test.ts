// @vitest-environment node
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { planLectures, sectionsFromStored, syncLectures, type StoredFile } from "./lectures";

const DB_TIMEOUT = 90_000;
const PLUGINFILE = "https://moodle.example.edu/webservice/pluginfile.php";
const SEPT = new Date("2026-09-02T08:00:00Z");

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
}, DB_TIMEOUT);
afterEach(async () => {
  await t.close();
});

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  return u.id;
}

async function makeCourse(userId: string, moodleId: number, hidden = false): Promise<string> {
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId, name: `Course ${moodleId}`, hidden })
    .returning();
  return c.id;
}

type FileSpec = { ref: string; section: string; assignmentId?: string; modifiedAt?: Date };

async function addFiles(userId: string, courseId: string, specs: FileSpec[]) {
  for (const s of specs) {
    const name = s.ref.split(":").slice(2).join(":") || s.ref;
    await t.db.insert(courseFiles).values({
      userId,
      courseId,
      moodleRef: s.ref,
      section: s.section,
      name,
      mime: name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
      size: 1000,
      url: `${PLUGINFILE}/1/${name}`,
      modifiedAt: s.modifiedAt ?? SEPT,
      assignmentId: s.assignmentId ?? null,
    });
  }
}

async function lecturesOf(userId: string, courseId: string) {
  return t.db
    .select()
    .from(lectures)
    .where(and(eq(lectures.userId, userId), eq(lectures.courseId, courseId)))
    .orderBy(asc(lectures.n));
}

function stored(ref: string, section: string | null): StoredFile {
  const name = ref.split(":").slice(2).join(":");
  return { id: `id-${ref}`, moodleRef: ref, section, name, mime: null, size: 1, url: `u/${name}`, modifiedAt: null };
}

describe("sectionsFromStored", () => {
  it("rebuilds sections ordered by their smallest module id, resources from one file and folders from several", () => {
    const { sections, fileIdOf } = sectionsFromStored([
      stored("cm:7201:lecture-02_smoothing.pdf", "Week 2"),
      stored("cm:7101:lecture-01.pdf", "Week 1"),
      stored("cm:7203:b.pdf", "Week 2"),
      stored("cm:7203:a.pdf", "Week 2"),
      stored("assign:7101:intro:brief.pdf", "Week 1"),
      stored("cm:7001:notes.pdf", null),
    ]);
    expect(sections.map((s) => [s.section, s.position])).toEqual([
      ["", 0],
      ["Week 1", 1],
      ["Week 2", 2],
    ]);
    expect(sections[2].modules).toEqual([
      {
        moodleRef: "cm:7201",
        name: "lecture 02 smoothing",
        kind: "resource",
        files: [{ name: "lecture-02_smoothing.pdf", url: "u/lecture-02_smoothing.pdf", mime: null, size: 1, modifiedAt: null }],
      },
      {
        moodleRef: "cm:7203",
        name: "",
        kind: "folder",
        files: [
          expect.objectContaining({ name: "a.pdf" }),
          expect.objectContaining({ name: "b.pdf" }),
        ],
      },
    ]);
    // Brief attachments are not course-page files.
    expect(sections[1].modules.map((m) => m.moodleRef)).toEqual(["cm:7101"]);
    expect(fileIdOf.get("cm:7101/lecture-01.pdf")).toBe("id-cm:7101:lecture-01.pdf");
    expect(fileIdOf.has("assign:7101/intro:brief.pdf")).toBe(false);
  });
});

describe("syncLectures", () => {
  it("makes one lecture per number from the stored files, and a second sync keeps read_at", async () => {
    const her = await makeUser();
    const course = await makeCourse(her, 3101);
    await addFiles(her, course, [
      { ref: "cm:7101:lecture-01-why-forecast.pdf", section: "Week 1: Introduction" },
      // The same lecture as PowerPoint: shares number 1; the PDF is the row's file, whatever the names.
      { ref: "cm:7102:lecture-01-why-forecast.pptx", section: "Week 1: Introduction" },
      { ref: "cm:7201:lecture-02-exponential-smoothing.pdf", section: "Week 2: Smoothing" },
      { ref: "cm:7202:weekly-sales.csv", section: "Week 2: Smoothing" },
      { ref: "cm:7203:exercises-1.pdf", section: "Week 2: Smoothing" },
    ]);

    expect(await syncLectures(her, t.db)).toEqual({ added: 2, updated: 0, kept: 0 });
    const first = await lecturesOf(her, course);
    const [pdf1] = await t.db.select().from(courseFiles).where(eq(courseFiles.moodleRef, "cm:7101:lecture-01-why-forecast.pdf"));
    expect(first.map((l) => [l.n, l.title, l.opensAt, l.readAt])).toEqual([
      [1, "why forecast", null, null],
      [2, "exponential smoothing", null, null],
    ]);
    expect(first[0].fileId).toBe(pdf1.id);

    const readAt = new Date("2026-11-10T09:00:00Z");
    await t.db.update(lectures).set({ readAt }).where(eq(lectures.id, first[0].id));

    // Nothing changed: nothing written, the read mark stays.
    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 0, kept: 0 });
    let again = await lecturesOf(her, course);
    expect(again[0]).toEqual({ ...first[0], readAt });

    // The teacher renames the file: the title changes on the same row, read_at still stays.
    await t.db
      .update(courseFiles)
      .set({ moodleRef: "cm:7101:lecture-01-why-we-forecast.pdf", name: "lecture-01-why-we-forecast.pdf" })
      .where(eq(courseFiles.id, pdf1.id));
    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 1, kept: 0 });
    again = await lecturesOf(her, course);
    expect(again[0]).toMatchObject({ id: first[0].id, title: "why we forecast", fileId: pdf1.id, readAt });
  }, DB_TIMEOUT);

  it("keeps a lecture whose number no longer comes out, with its read mark", async () => {
    const her = await makeUser();
    const course = await makeCourse(her, 3101);
    await addFiles(her, course, [
      { ref: "cm:7101:lecture-01.pdf", section: "Week 1" },
      { ref: "cm:7201:lecture-02.pdf", section: "Week 2" },
    ]);
    await syncLectures(her, t.db);
    const [, two] = await lecturesOf(her, course);
    const readAt = new Date("2026-11-11T09:00:00Z");
    await t.db.update(lectures).set({ readAt }).where(eq(lectures.id, two.id));

    // Lecture 2's file is renamed to something that is not a lecture any more.
    await t.db
      .update(courseFiles)
      .set({ moodleRef: "cm:7201:reading-list.pdf", name: "reading-list.pdf" })
      .where(eq(courseFiles.moodleRef, "cm:7201:lecture-02.pdf"));

    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 0, kept: 1 });
    const after = await lecturesOf(her, course);
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual({ ...two, readAt });
  }, DB_TIMEOUT);

  it("skips hidden courses, brief attachments and other users' files", async () => {
    const her = await makeUser();
    const other = await makeUser();
    const course = await makeCourse(her, 3101);
    const hidden = await makeCourse(her, 3102, true);
    const theirs = await makeCourse(other, 3101);
    const [brief] = await t.db
      .insert(assignments)
      .values({ userId: her, courseId: course, moodleId: 9001, name: "Assignment 1" })
      .returning();
    await addFiles(her, course, [
      { ref: "cm:7101:lecture-01.pdf", section: "Week 1" },
      { ref: "assign:9001:intro:lecture-05.pdf", section: "Week 1", assignmentId: brief.id },
    ]);
    await addFiles(her, hidden, [{ ref: "cm:8101:lecture-01.pdf", section: "Week 1" }]);
    await addFiles(other, theirs, [
      { ref: "cm:7101:lecture-01.pdf", section: "Week 1" },
      { ref: "cm:7201:lecture-02.pdf", section: "Week 2" },
    ]);

    expect(await syncLectures(her, t.db)).toEqual({ added: 1, updated: 0, kept: 0 });
    expect((await lecturesOf(her, course)).map((l) => l.n)).toEqual([1]);
    expect(await lecturesOf(her, hidden)).toEqual([]);
    expect(await lecturesOf(other, theirs)).toEqual([]);
  }, DB_TIMEOUT);

  it("a deck added above three read lectures leaves each read mark on its file, numbered 2 to 4", async () => {
    const her = await makeUser();
    const course = await makeCourse(her, 3101);
    await addFiles(her, course, [
      { ref: "cm:7101:lecture-why-forecast.pdf", section: "Week 1" },
      { ref: "cm:7201:lecture-smoothing.pdf", section: "Week 2" },
      { ref: "cm:7301:lecture-arima.pdf", section: "Week 3" },
    ]);
    await syncLectures(her, t.db);
    const before = await lecturesOf(her, course);
    expect(before.map((l) => [l.n, l.title])).toEqual([
      [1, "why forecast"],
      [2, "smoothing"],
      [3, "arima"],
    ]);
    const read = [new Date("2026-11-01T09:00:00Z"), new Date("2026-11-02T09:00:00Z"), new Date("2026-11-03T09:00:00Z")];
    for (const [i, l] of before.entries()) {
      await t.db.update(lectures).set({ readAt: read[i], lastOpenedAt: read[i] }).where(eq(lectures.id, l.id));
    }
    await t.db.insert(lectureContent).values({ lectureId: before[1].id, breath: "Smoothing.", sourceHash: "h-smoothing" });

    // The teacher adds a deck in a new section at the top of the page.
    await addFiles(her, course, [{ ref: "cm:7001:lecture-course-intro.pdf", section: "Before we start" }]);
    expect(await syncLectures(her, t.db)).toEqual({ added: 1, updated: 3, kept: 0 });

    const after = await lecturesOf(her, course);
    expect(after.map((l) => [l.n, l.title, l.readAt])).toEqual([
      [1, "course intro", null],
      [2, "why forecast", read[0]],
      [3, "smoothing", read[1]],
      [4, "arima", read[2]],
    ]);
    // Same rows, same files, only the number moved.
    for (const [i, l] of before.entries()) {
      expect(after[i + 1]).toEqual({ ...l, n: l.n + 1, readAt: read[i], lastOpenedAt: read[i] });
    }
    const [content] = await t.db.select().from(lectureContent);
    expect(content.lectureId).toBe(before[1].id);

    // A second sync writes nothing.
    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 0, kept: 0 });
    expect(await lecturesOf(her, course)).toEqual(after);
  }, DB_TIMEOUT);

  it("swapping two decks swaps their numbers and nothing else", async () => {
    const her = await makeUser();
    const course = await makeCourse(her, 3101);
    // The data files only anchor each section's place on the page (sections go by their smallest module id).
    await addFiles(her, course, [
      { ref: "cm:7001:data-week-1.csv", section: "Week 1" },
      { ref: "cm:7002:data-week-2.csv", section: "Week 2" },
      { ref: "cm:7003:data-week-3.csv", section: "Week 3" },
      { ref: "cm:7101:lecture-why-forecast.pdf", section: "Week 1" },
      { ref: "cm:7201:lecture-smoothing.pdf", section: "Week 2" },
      { ref: "cm:7301:lecture-arima.pdf", section: "Week 3" },
    ]);
    await syncLectures(her, t.db);
    const before = await lecturesOf(her, course);
    const readAt = new Date("2026-11-05T09:00:00Z");
    await t.db.update(lectures).set({ readAt }).where(eq(lectures.id, before[0].id));
    before[0] = { ...before[0], readAt };

    // The teacher moves the first deck to week 2 and the second to week 1.
    await t.db.update(courseFiles).set({ section: "Week 2" }).where(eq(courseFiles.moodleRef, "cm:7101:lecture-why-forecast.pdf"));
    await t.db.update(courseFiles).set({ section: "Week 1" }).where(eq(courseFiles.moodleRef, "cm:7201:lecture-smoothing.pdf"));
    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 2, kept: 0 });

    const after = await lecturesOf(her, course);
    expect(after).toEqual([
      { ...before[1], n: 1 },
      { ...before[0], n: 2 },
      before[2],
    ]);
  }, DB_TIMEOUT);

  it("a removed file's row survives with its read mark, after the live lectures", async () => {
    const her = await makeUser();
    const course = await makeCourse(her, 3101);
    await addFiles(her, course, [
      { ref: "cm:7101:lecture-01.pdf", section: "Week 1" },
      { ref: "cm:7201:lecture-02.pdf", section: "Week 2" },
      { ref: "cm:7301:lecture-03.pdf", section: "Week 3" },
      { ref: "cm:7401:lecture-04.pdf", section: "Week 4" },
    ]);
    await syncLectures(her, t.db);
    const [one, two, three, four] = await lecturesOf(her, course);
    const readTwo = new Date("2026-11-06T09:00:00Z");
    const readThree = new Date("2026-11-07T09:00:00Z");
    await t.db.update(lectures).set({ readAt: readTwo }).where(eq(lectures.id, two.id));
    await t.db.update(lectures).set({ readAt: readThree }).where(eq(lectures.id, three.id));
    await t.db.insert(lectureContent).values({ lectureId: two.id, breath: "Two.", sourceHash: "h-two" });

    // Lecture 2's file row goes (the foreign key sets the lecture's file_id to null),
    // and lecture 3's file is renamed into something that is not a lecture.
    await t.db.delete(courseFiles).where(eq(courseFiles.moodleRef, "cm:7201:lecture-02.pdf"));
    await t.db
      .update(courseFiles)
      .set({ moodleRef: "cm:7301:reading-list.pdf", name: "reading-list.pdf" })
      .where(eq(courseFiles.moodleRef, "cm:7301:lecture-03.pdf"));

    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 1, kept: 2 });
    const after = await lecturesOf(her, course);
    expect(after).toEqual([
      one,
      { ...four, n: 2 },
      { ...two, n: 3, fileId: null, readAt: readTwo },
      { ...three, n: 4, readAt: readThree },
    ]);
    const [content] = await t.db.select().from(lectureContent);
    expect(content.lectureId).toBe(two.id);

    // Stable: a second sync moves nothing.
    expect(await syncLectures(her, t.db)).toEqual({ added: 0, updated: 0, kept: 2 });
    expect(await lecturesOf(her, course)).toEqual(after);
  }, DB_TIMEOUT);

  it("hand-made rows without a file keep their number; one on a new lecture's number is taken over", async () => {
    const her = await makeUser();
    const course = await makeCourse(her, 3101);
    const readAt = new Date("2026-11-08T09:00:00Z");
    // Imported before Moodle was synced: lecture 1 (read), and a guest talk she numbered 10.
    const [imported, guest] = await t.db
      .insert(lectures)
      .values([
        { userId: her, courseId: course, n: 1, title: "Why forecast", readAt },
        { userId: her, courseId: course, n: 10, title: "Guest talk" },
      ])
      .returning();
    await addFiles(her, course, [
      { ref: "cm:7101:lecture-why-forecast.pdf", section: "Week 1" },
      { ref: "cm:7201:lecture-smoothing.pdf", section: "Week 2" },
    ]);

    // Lecture 1 takes over the imported row (same number, no file); the guest talk stays on 10.
    expect(await syncLectures(her, t.db)).toEqual({ added: 1, updated: 1, kept: 1 });
    let rows = await lecturesOf(her, course);
    const [pdf1] = await t.db.select().from(courseFiles).where(eq(courseFiles.moodleRef, "cm:7101:lecture-why-forecast.pdf"));
    expect(rows.map((l) => [l.id, l.n, l.title, l.fileId, l.readAt])).toEqual([
      [imported.id, 1, "why forecast", pdf1.id, readAt],
      [rows[1].id, 2, "smoothing", rows[1].fileId, null],
      [guest.id, 10, "Guest talk", null, null],
    ]);

    // A deck added above shifts the Moodle lectures; the guest talk keeps 10, the read mark stays on its file.
    await addFiles(her, course, [{ ref: "cm:7001:lecture-course-intro.pdf", section: "Before we start" }]);
    expect(await syncLectures(her, t.db)).toEqual({ added: 1, updated: 2, kept: 1 });
    rows = await lecturesOf(her, course);
    expect(rows.map((l) => [l.n, l.title, l.readAt])).toEqual([
      [1, "course intro", null],
      [2, "why forecast", readAt],
      [3, "smoothing", null],
      [10, "Guest talk", null],
    ]);
    expect(rows[1].id).toBe(imported.id);
    expect(rows[3]).toEqual(guest);
  }, DB_TIMEOUT);
});

describe("planLectures", () => {
  const w = (n: number, fileId: string | null) => ({ n, title: `t${n}`, fileId, opensAt: null });
  const row = (id: string, n: number, fileId: string | null) => ({ id, n, title: `t${n}`, fileId, opensAt: null });

  it("moves a row with no file off a number a file-matched lecture needs, and leaves free ones alone", () => {
    const plan = planLectures(
      [row("a", 1, "fa"), row("h", 2, null), row("g", 5, null), row("gone", 3, "fx")],
      [w(1, "fb"), w(2, "fa")],
    );
    // fb is new on 1; a moves to 2; h (no file) was on 2 and goes after the live ones, before the gone file; g stays on 5.
    expect(plan.inserts).toEqual([w(1, "fb")]);
    expect(plan.updates).toEqual([
      { id: "a", from: 1, values: { ...w(2, "fa"), title: "t2" }, produced: true },
      { id: "h", from: 2, values: { n: 3, title: "t2", fileId: null, opensAt: null }, produced: false },
      { id: "gone", from: 3, values: { n: 4, title: "t3", fileId: "fx", opensAt: null }, produced: false },
    ]);
    expect(plan.kept).toBe(3);
  });
});
