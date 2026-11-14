// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { courseFiles, courses, filePages } from "./schema/courses";
import { users } from "./schema/users";
import { assignments } from "./schema/work";
import { createTestDb, type TestDb } from "./test-db";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

async function seed() {
  const [user] = await t.db.insert(users).values({ displayName: "Test Student" }).returning();
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: 101, name: "Test Course", color: "mint" })
    .returning();
  const [assignment] = await t.db
    .insert(assignments)
    .values({ userId: user.id, courseId: course.id, moodleId: 202, name: "Essay 1" })
    .returning();
  return { user, course, assignment };
}

describe("schema", () => {
  it("stores a user, course and assignment, and deleting the user removes them", async () => {
    const { user, course, assignment } = await seed();

    const [readCourse] = await t.db.select().from(courses).where(eq(courses.id, course.id));
    expect(readCourse).toMatchObject({
      userId: user.id,
      name: "Test Course",
      color: "mint",
      target: 5,
      aiPolicy: "unknown",
      hidden: false,
    });
    expect(readCourse.createdAt).toBeInstanceOf(Date);

    const [readAssignment] = await t.db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignment.id));
    expect(readAssignment).toMatchObject({ courseId: course.id, name: "Essay 1", state: "open" });

    await t.db.delete(users).where(eq(users.id, user.id));

    expect(await t.db.select().from(courses)).toHaveLength(0);
    expect(await t.db.select().from(assignments)).toHaveLength(0);
  });

  it("rejects a value outside a CHECK value set", async () => {
    const { user } = await seed();
    await expect(
      t.db.execute(
        sql`insert into courses (user_id, moodle_id, name, color) values (${user.id}, 9, 'x', 'purple')`,
      ),
    ).rejects.toThrow();
  });

  it("fills the generated tsvector and finds a page by full-text search", async () => {
    const { user, course } = await seed();
    const [file] = await t.db
      .insert(courseFiles)
      .values({
        userId: user.id,
        courseId: course.id,
        moodleRef: "file-1",
        name: "Lecture 1.pdf",
        url: "https://example.test/file-1",
      })
      .returning();
    await t.db.insert(filePages).values([
      { fileId: file.id, page: 1, text: "Photosynthesis turns light into sugar" },
      { fileId: file.id, page: 2, text: "Cell walls and membranes" },
    ]);

    const hits = await t.db
      .select({ page: filePages.page })
      .from(filePages)
      .where(sql`${filePages.tsv} @@ plainto_tsquery('simple', 'photosynthesis')`);
    expect(hits).toEqual([{ page: 1 }]);
  });
});
