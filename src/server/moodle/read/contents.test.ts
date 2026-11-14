// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "../../../../tests/fixtures/moodle-sample/core_course_get_contents.json";
import type { MoodleConn } from "../client";
import { getCourseContents } from "./contents";
import { UnexpectedAnswer } from "./site";

const conn: MoodleConn = { siteUrl: "https://moodle.example.edu", token: "test-token" };

// Her real answer, saved by hand during M0 and never committed. Tested only when present.
const REAL = resolve(__dirname, "../../../../tests/fixtures/moodle/core_course_get_contents.json");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Make Moodle answer `body` over (stubbed) HTTP; returns the fetch mock. */
function answerWith(body: unknown) {
  vi.stubEnv("MOODLE_FAKE", "0");
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url;
    void init;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

type Raw = { modules: Record<string, unknown>[] }[];
const PLUGINFILE = "https://moodle.example.edu/webservice/pluginfile.php";

describe("getCourseContents", () => {
  it("sends the course id", async () => {
    const fetchMock = answerWith(sample);
    await getCourseContents(conn, 3101);
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get("wsfunction")).toBe("core_course_get_contents");
    expect(body.get("courseid")).toBe("3101");
  });

  it("reads the sample answer into sections, modules and files", async () => {
    answerWith(sample);
    const sections = await getCourseContents(conn, 3101);
    expect(sections).toEqual([
      {
        section: "General",
        position: 0,
        modules: [
          { moodleRef: "cm:7001", name: "Announcements", kind: "other", files: [] },
          { moodleRef: "cm:7002", name: "Course textbook (online)", kind: "url", files: [] },
        ],
      },
      {
        section: "Week 1: Introduction",
        position: 1,
        modules: [
          {
            moodleRef: "cm:7101",
            name: "Lecture 1: Why forecast?",
            kind: "resource",
            files: [
              {
                name: "lecture-01-why-forecast.pdf",
                url: `${PLUGINFILE}/62101/mod_resource/content/1/lecture-01-why-forecast.pdf?forcedownload=1`,
                mime: "application/pdf",
                size: 2483112,
                modifiedAt: new Date("2026-09-02T08:00:00Z"),
              },
            ],
          },
          { moodleRef: "cm:7102", name: "Reading guide", kind: "page", files: [] },
          { moodleRef: "cm:7103", name: "Warm-up quiz", kind: "quiz", files: [] },
        ],
      },
      {
        section: "Week 2: Smoothing",
        position: 2,
        modules: [
          {
            moodleRef: "cm:7201",
            name: "Lecture 2: Exponential smoothing",
            kind: "resource",
            files: [
              {
                name: "lecture-02-exponential-smoothing.pdf",
                url: `${PLUGINFILE}/62201/mod_resource/content/2/lecture-02-exponential-smoothing.pdf?forcedownload=1`,
                mime: "application/pdf",
                size: 3150775,
                modifiedAt: new Date("2026-09-09T08:00:00Z"),
              },
            ],
          },
          {
            moodleRef: "cm:7202",
            name: "Weekly sales data",
            kind: "resource",
            files: [
              {
                name: "weekly-sales.csv",
                url: `${PLUGINFILE}/62202/mod_resource/content/1/weekly-sales.csv?forcedownload=1`,
                mime: "text/csv",
                size: 18432,
                modifiedAt: new Date("2026-09-08T12:30:00Z"),
              },
            ],
          },
          {
            moodleRef: "cm:7203",
            name: "Exercise set 1",
            kind: "folder",
            files: [
              {
                name: "exercises-1.pdf",
                url: `${PLUGINFILE}/62203/mod_folder/content/0/exercises-1.pdf?forcedownload=1`,
                mime: "application/pdf",
                size: 412880,
                modifiedAt: new Date("2026-09-10T09:15:00Z"),
              },
              {
                name: "templates/smoothing-template.xlsx",
                url: `${PLUGINFILE}/62203/mod_folder/content/0/templates/smoothing-template.xlsx?forcedownload=1`,
                mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                size: 25611,
                modifiedAt: new Date("2026-09-10T09:20:00Z"),
              },
            ],
          },
        ],
      },
      {
        section: "Assignments",
        position: 3,
        modules: [{ moodleRef: "cm:5101", name: "Assignment 3", kind: "assign", files: [] }],
      },
    ]);
  });

  it("lists every file in a folder", async () => {
    answerWith(sample);
    const sections = await getCourseContents(conn, 3101);
    const folder = sections.flatMap((s) => s.modules).find((m) => m.kind === "folder");
    expect(folder?.files.map((f) => f.name)).toEqual(["exercises-1.pdf", "templates/smoothing-template.xlsx"]);
  });

  it("lists url, page, quiz, assign and other kinds by name with no files, and drops labels", async () => {
    answerWith(sample);
    const modules = (await getCourseContents(conn, 3101)).flatMap((s) => s.modules);
    const noFiles = modules.filter((m) => m.kind !== "resource" && m.kind !== "folder");
    expect(noFiles.map((m) => [m.kind, m.name])).toEqual([
      ["other", "Announcements"],
      ["url", "Course textbook (online)"],
      ["page", "Reading guide"],
      ["quiz", "Warm-up quiz"],
      ["assign", "Assignment 3"],
    ]);
    for (const m of noFiles) expect(m.files).toEqual([]);
    expect(modules.some((m) => m.name.startsWith("Bring a laptop"))).toBe(false);
  });

  it("turns Unix seconds into Dates, and 0, null or missing into null", async () => {
    const raw = structuredClone(sample) as unknown as Raw;
    const contents = (raw[2].modules[2].contents as Record<string, unknown>[]);
    contents[0].timemodified = 0;
    contents[1].timemodified = null;
    delete (raw[1].modules[0].contents as Record<string, unknown>[])[0].timemodified;
    answerWith(raw);
    const files = (await getCourseContents(conn, 3101)).flatMap((s) => s.modules).flatMap((m) => m.files);
    expect(files.map((f) => f.modifiedAt)).toEqual([
      null,
      new Date("2026-09-09T08:00:00Z"),
      new Date("2026-09-08T12:30:00Z"),
      null,
      null,
    ]);
    expect(files[1].modifiedAt).toBeInstanceOf(Date);
  });

  it("skips the files of a module she cannot open, but keeps it by name", async () => {
    const raw = structuredClone(sample) as unknown as Raw;
    raw[1].modules[0].uservisible = false;
    answerWith(raw);
    const sections = await getCourseContents(conn, 3101);
    expect(sections[1].modules[0]).toEqual({
      moodleRef: "cm:7101",
      name: "Lecture 1: Why forecast?",
      kind: "resource",
      files: [],
    });
  });

  it("reads a resource with no contents and a file with no mimetype", async () => {
    const raw = structuredClone(sample) as unknown as Raw;
    delete raw[1].modules[0].contents;
    delete (raw[2].modules[1].contents as Record<string, unknown>[])[0].mimetype;
    answerWith(raw);
    const sections = await getCourseContents(conn, 3101);
    expect(sections[1].modules[0].files).toEqual([]);
    expect(sections[2].modules[1].files[0].mime).toBe("application/octet-stream");
  });

  it("throws UnexpectedAnswer with the path, not the data, on a broken answer", async () => {
    const raw = structuredClone(sample) as unknown as Raw;
    raw[2].modules[1].name = 98765;
    answerWith(raw);
    const err = await caught(getCourseContents(conn, 3101));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    const e = err as UnexpectedAnswer;
    expect(e.fn).toBe("core_course_get_contents");
    expect(e.path).toBe("[2].modules[1].name");
    expect(e.message).toContain("core_course_get_contents");
    expect(e.message).toContain("[2].modules[1].name");
    for (const value of ["98765", "7202", "weekly-sales", "Smoothing", "3101"]) {
      expect(e.message).not.toContain(value);
    }
  });

  it("throws UnexpectedAnswer on a file entry with no URL", async () => {
    const raw = structuredClone(sample) as unknown as Raw;
    delete (raw[2].modules[0].contents as Record<string, unknown>[])[0].fileurl;
    answerWith(raw);
    const err = await caught(getCourseContents(conn, 3101));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    expect((err as UnexpectedAnswer).path).toMatch(/^\[2\]\.modules\[0\]\.contents\[0\]/);
    expect((err as UnexpectedAnswer).message).not.toContain("lecture-02");
  });

  it.skipIf(!existsSync(REAL))("reads her real answer", async () => {
    answerWith(JSON.parse(readFileSync(REAL, "utf8")));
    const sections = await getCourseContents(conn, 1);
    expect(Array.isArray(sections)).toBe(true);
    for (const s of sections) {
      for (const m of s.modules) {
        expect(m.moodleRef).toMatch(/^cm:\d+$/);
        if (m.kind !== "resource" && m.kind !== "folder") expect(m.files).toEqual([]);
      }
    }
  });
});
