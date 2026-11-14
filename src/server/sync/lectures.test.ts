// @vitest-environment node
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { sectionsFromStored, syncLectures, type StoredFile } from "./lectures";

const DB_TIMEOUT = 30_000;
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
});
