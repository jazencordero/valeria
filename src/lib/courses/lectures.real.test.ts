// @vitest-environment node
// lecturesFrom on her real course page (shape-only copy, tests/fixtures/moodle/), read through
// M2-07's getCourseContents exactly as sync does. Skipped when the fixture is not there.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoodleConn } from "@/server/moodle/client";
import { getCourseContents } from "@/server/moodle/read/contents";
import { lecturesFrom } from "./lectures";

const FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/moodle/core_course_get_contents.json", import.meta.url));
const conn: MoodleConn = { siteUrl: "https://moodle.example.edu", token: "test-token" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function readCourse() {
  const body = readFileSync(FIXTURE, "utf8");
  vi.stubEnv("MOODLE_FAKE", "0");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
  return getCourseContents(conn, 50865);
}

describe.skipIf(!existsSync(FIXTURE))("lecturesFrom on her real course", () => {
  // What the course page shows, read from the fixture:
  // - section 0: a forum and two subsection links (not files).
  // - "Assignments": two assignments, an exam PDF ("Topic M exam.pdf"; probably the results file
  //   the planner saw, the scrubbed name cannot say) and a folder holding one zip.
  // - "Lecture Topic K": six PDFs, one resource each, named by topic with no number (the decks),
  //   five recordings (lti), and a folder "Topic AA" of ten small PDFs named "Lecture 1.pdf" to
  //   "Lecture 10.pdf" (the numbered background readings).
  // A person expects the six decks, in page order, numbered 1 to 6.
  it("finds the six topic-named decks, in page order, numbered 1 to 6", async () => {
    const lectures = lecturesFrom(await readCourse());
    expect(lectures.map((l) => [l.n, l.title])).toEqual([
      [1, "Topic O"],
      [2, "Topic Q"],
      [3, "Topic R"],
      [4, "Topic S"],
      [5, "Topic T, Topic U, Topic V"],
      [6, "Topic X"],
    ]);
    expect(lectures.map((l) => l.fileRef)).toEqual([
      "cm:1528240/TopicP.pdf",
      "cm:1528215/Topic Q.pdf",
      "cm:1528216/Topic R.pdf",
      "cm:1528217/Topic S.pdf",
      "cm:1528218/Topic T, Topic W.pdf",
      "cm:1528219/Topic X.pdf",
    ]);
    for (const l of lectures) {
      expect(l.section).toBe("Lecture Topic K");
      expect(l.opensAt).toBeNull();
      expect(l.postedAt).not.toBeNull();
    }
  });

  it("leaves out the numbered readings folder, the exam file, the zip and the recordings", async () => {
    const refs = lecturesFrom(await readCourse()).map((l) => l.fileRef ?? "");
    expect(refs.some((r) => r.startsWith("cm:1528225/"))).toBe(false); // folder of "Lecture N.pdf" readings
    expect(refs.some((r) => r.startsWith("cm:1555225/"))).toBe(false); // exam file
    expect(refs.some((r) => r.endsWith(".zip"))).toBe(false);
  });
});
