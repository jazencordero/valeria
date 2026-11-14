import { describe, expect, it } from "vitest";
import {
  lectureState,
  lecturesFrom,
  parseNumber,
  parseOpensAt,
  titleFrom,
  type CourseFile,
  type CourseModule,
  type CourseSection,
  type Lecture,
} from "./lectures";

// Invented courses only. No real course data.

let ref = 1000;
function file(name: string, extra: Partial<CourseFile> = {}): CourseFile {
  return { name, url: `https://moodle.example/pluginfile.php/${name}`, modifiedAt: "2026-09-01T08:00:00Z", ...extra };
}
function resource(name: string, fileName: string, extra: Partial<CourseModule> = {}): CourseModule {
  return { moodleRef: ++ref, name, kind: "resource", files: [file(fileName)], ...extra };
}
function folder(name: string, fileNames: string[]): CourseModule {
  return { moodleRef: ++ref, name, kind: "folder", files: fileNames.map((f) => file(f)) };
}
function section(name: string, position: number, modules: CourseModule[]): CourseSection {
  return { section: name, position, modules };
}
/** One neutral section, one resource whose module name is the file name minus extension. */
function single(fileName: string, sectionName = "Materials"): Lecture[] {
  return lecturesFrom([section(sectionName, 1, [resource(fileName.replace(/\.[^.]+$/, ""), fileName)])]);
}

describe("file names: which are lectures, their number and title", () => {
  const cases: [string, number, string][] = [
    // English
    ["Lecture 5 Sourcing.pdf", 5, "Sourcing"],
    ["Lecture 1 - Introduction.pptx", 1, "Introduction"],
    ["lect07-strategy.odp", 7, "strategy"],
    ["L01_Supply chains.pdf", 1, "Supply chains"],
    ["L3 Pricing.key", 3, "Pricing"],
    ["Week 3 - Demand forecasting.pdf", 3, "Demand forecasting"],
    ["Session 2: Negotiation.pptx", 2, "Negotiation"],
    ["Lecture slides 6 - Risk.pdf", 6, "Risk"],
    ["Slides 4 Logistics.pdf", 4, "Logistics"],
    // Finnish
    ["Luento 3 – Markkinointi.pptx", 3, "Markkinointi"],
    ["luentokalvot_4_tuotanto.pdf", 4, "tuotanto"],
    ["3. luento Kysyntä.pdf", 3, "Kysyntä"],
    ["Viikko 2 Hinnoittelu.pdf", 2, "Hinnoittelu"],
    ["Luento02_Johdanto.pdf", 2, "Johdanto"],
    ["Kalvot 5 Laskentatoimi.ppt", 5, "Laskentatoimi"],
    ["Vierailuluento 8 Yrittäjyys.pdf", 8, "Vierailuluento Yrittäjyys"],
  ];
  it.each(cases)("%s -> lecture %i, %s", (name, n, title) => {
    const out = single(name);
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(n);
    expect(out[0].title).toBe(title);
  });
});

describe("exclusions", () => {
  const notLectures = [
    "Assignment 1 brief.pdf",
    "Lecture 3 reading.pdf",
    "Syllabus.pdf",
    "Course info.pdf",
    "Opinto-opas 2026.pdf",
    "Tehtävänanto 2.pdf",
    "Lukemisto viikko 3.pdf",
    "Week 4 exercises.pdf",
    "Harjoitus 2 viikko 2.pdf",
    "Week 2 article.pdf",
    "Old exam week 6.pdf",
    "Tentti viikko 7.pdf",
  ];
  it.each(notLectures)("%s is left out", (name) => {
    expect(single(name)).toEqual([]);
  });

  it("data files are never lectures, even in a lecture section", () => {
    const out = lecturesFrom([
      section("Lectures", 1, [
        resource("Lecture 1 data", "lecture1-data.csv"),
        resource("Lecture 2 sales", "lecture2.xlsx"),
        resource("Lecture 3 notes", "lecture3.docx"),
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("exercise words are kept when the name is clearly a lecture", () => {
    const out = single("Lecture 4 exercise walkthrough slides.pdf");
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(4);
  });

  it("an exclusion section drops its files unless the file is clearly a lecture", () => {
    const out = lecturesFrom([
      section("Assignments", 1, [resource("Case brief", "case.pdf"), resource("Week 2 instructions", "w2.pdf")]),
      section("Readings", 2, [resource("Lecture 2 slides", "lecture2.pdf")]),
    ]);
    expect(out.map((l) => l.n)).toEqual([2]);
  });

  it("assign, url, page and quiz modules are never lectures", () => {
    const out = lecturesFrom([
      section("Lecture 1", 1, [
        { moodleRef: 1, name: "Lecture 1 assignment", kind: "assign", files: [file("lecture1.pdf")] },
        { moodleRef: 2, name: "Lecture 1 recording", kind: "url", files: [] },
        { moodleRef: 3, name: "Lecture 1 quiz", kind: "quiz", files: [] },
      ]),
    ]);
    expect(out).toEqual([]);
  });
});

describe("signals from module and section", () => {
  it("a slide file in a lecture section counts, numbered from order", () => {
    const out = lecturesFrom([
      section("Luennot", 1, [resource("Johdanto", "johdanto.pdf"), resource("Kysyntä ja tarjonta", "kt.pdf")]),
    ]);
    expect(out.map((l) => [l.n, l.title])).toEqual([
      [1, "Johdanto"],
      [2, "Kysyntä ja tarjonta"],
    ]);
  });

  it("a neutral PDF in a neutral section is not a lecture", () => {
    expect(single("Pricing.pdf")).toEqual([]);
  });

  it("week sections count, and the title comes from the module name", () => {
    const out = lecturesFrom([section("Week 1", 1, [resource("Strategy basics", "s1.pdf")])]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ n: 1, title: "Strategy basics", section: "Week 1" });
  });

  it("a folder of slides gives one lecture per file", () => {
    const out = lecturesFrom([
      section("Materials", 1, [folder("Lecture slides", ["01 Intro.pdf", "02 Markets.pdf", "data.csv"])]),
    ]);
    expect(out.map((l) => [l.n, l.title])).toEqual([
      [1, "Intro"],
      [2, "Markets"],
    ]);
    expect(out[0].fileRef).toMatch(/\/01 Intro\.pdf$/);
  });

  it("uses the file name when the module name is only numbering", () => {
    const out = lecturesFrom([section("Week 2", 1, [resource("Lecture 2 slides", "Lecture 2 Sourcing.pdf")])]);
    expect(out[0]).toMatchObject({ n: 2, title: "Sourcing" });
  });

  it("title may be empty when nothing but numbering is left", () => {
    const out = lecturesFrom([section("Week 1", 1, [resource("Lecture 1 slides", "lecture1.pdf")])]);
    expect(out[0]).toMatchObject({ n: 1, title: "" });
  });
});

describe("numbering and order", () => {
  it("fills missing numbers from order, around named ones", () => {
    const out = lecturesFrom([
      section("Lectures", 1, [
        resource("Introduction", "intro.pdf"),
        resource("Lecture 2 Markets", "l2.pdf"),
        resource("Guest talk", "guest.pdf"),
        resource("Lecture 3 Pricing", "l3.pdf"),
      ]),
    ]);
    expect(out.map((l) => [l.n, l.title])).toEqual([
      [1, "Introduction"],
      [2, "Markets"],
      [3, "Pricing"],
      [4, "Guest talk"],
    ]);
  });

  it("orders by number, then section position, then name, whatever the input order", () => {
    const sections = [
      section("Week 2", 2, [resource("Lecture 3 Pricing", "c.pdf")]),
      section("Week 1", 1, [resource("Lecture 2 Markets", "b.pdf"), resource("Lecture 1 Intro", "a.pdf")]),
      section("Extra", 3, [resource("Lecture 2 Markets (part b)", "b2.pdf")]),
    ];
    const out = lecturesFrom(sections);
    expect(out.map((l) => [l.n, l.section, l.title])).toEqual([
      [1, "Week 1", "Intro"],
      [2, "Week 1", "Markets"],
      [2, "Extra", "Markets (part b)"],
      [3, "Week 2", "Pricing"],
    ]);
    expect(lecturesFrom([...sections].reverse())).toEqual(out);
  });

  it("does not read a year as a lecture number", () => {
    expect(parseNumber("2026 Lecture notes").n).toBeNull();
    expect(parseNumber("Lecture 4 2026").n).toBe(4);
  });

  it("parseNumber and titleFrom on their own", () => {
    expect(parseNumber("L01_Intro.pdf")).toMatchObject({ n: 1 });
    expect(titleFrom("Week 03 — Risk management.pdf")).toBe("Risk management");
  });
});

describe("restricted modules", () => {
  it("a lecture restricted until a date becomes a lecture with opensAt and no file", () => {
    const out = lecturesFrom([
      section("Lectures", 1, [
        resource("Lecture 1 Intro", "l1.pdf"),
        {
          moodleRef: 77,
          name: "Lecture 2 Markets",
          kind: "resource",
          files: [],
          available: false,
          availabilityInfo:
            'Not available unless: <ul><li>It is on or after <strong>12 December 2026, 10:00 AM</strong></li></ul>',
        },
      ]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      n: 2,
      title: "Markets",
      fileRef: null,
      url: null,
      section: "Lectures",
      postedAt: null,
      opensAt: "2026-12-12T08:00:00.000Z", // 10:00 Helsinki (UTC+2 in winter)
    });
  });

  it("a structured opensAt wins over the text", () => {
    const out = lecturesFrom([
      section("Luennot", 1, [
        {
          moodleRef: 78,
          name: "Luento 4 Rahoitus",
          kind: "resource",
          files: [],
          available: false,
          opensAt: 1796112000, // unix seconds
          availabilityInfo: "Ei saatavilla, ellei: On 1. tammikuuta 2027 tai myöhemmin",
        },
      ]),
    ]);
    expect(out[0]).toMatchObject({ n: 4, title: "Rahoitus", opensAt: new Date(1796112000 * 1000).toISOString() });
  });

  it("a restricted module without a readable date is left out", () => {
    const out = lecturesFrom([
      section("Lectures", 1, [
        { moodleRef: 79, name: "Lecture 5", kind: "resource", files: [], available: false, availabilityInfo: "Not available unless: You complete Quiz 1" },
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("a restricted assignment brief stays out", () => {
    const out = lecturesFrom([
      section("Week 3", 1, [
        { moodleRef: 80, name: "Assignment 2 brief", kind: "resource", files: [], available: false, availabilityInfo: "Available from 1 December 2026" },
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("parseOpensAt reads English and Finnish Moodle text", () => {
    expect(parseOpensAt("It is on or after <strong>12 December 2026, 10:00 AM</strong>")).toBe("2026-12-12T08:00:00.000Z");
    expect(parseOpensAt("Available from 3 March 2027, 2:30 PM")).toBe("2027-03-03T12:30:00.000Z");
    expect(parseOpensAt("Ei saatavilla, ellei: On <strong>12. joulukuuta 2026, 10.00</strong> tai myöhemmin")).toBe(
      "2026-12-12T08:00:00.000Z",
    );
    expect(parseOpensAt("Saatavilla 1.9.2026 klo 9.15 alkaen")).toBe("2026-09-01T06:15:00.000Z"); // summer UTC+3
    expect(parseOpensAt("It is on or after 1 May 2027 and before 1 June 2027")).toBe("2027-04-30T21:00:00.000Z");
    expect(parseOpensAt("It is before 12 December 2026")).toBeNull();
    expect(parseOpensAt("You complete Quiz 1")).toBeNull();
    expect(parseOpensAt(null)).toBeNull();
  });
});

describe("nothing matches", () => {
  it("returns [] for an empty course", () => {
    expect(lecturesFrom([])).toEqual([]);
  });

  it("returns [] when no file looks like a lecture", () => {
    const out = lecturesFrom([
      section("General", 0, [resource("Course info", "info.pdf"), resource("Grades", "grades.xlsx")]),
      section("Project", 1, [resource("Final report template", "template.docx"), resource("Team list", "teams.pdf")]),
    ]);
    expect(out).toEqual([]);
  });
});

describe("lectureState", () => {
  const NOW = "2026-11-14T12:00:00Z";
  const lec = (n: number, opensAt: string | null = null): Lecture => ({
    n,
    title: `T${n}`,
    fileRef: opensAt && opensAt > NOW ? null : `m/${n}.pdf`,
    url: null,
    section: "Lectures",
    postedAt: null,
    opensAt,
  });

  it("done when read, first unread posted cur, later posted up, unposted soon", () => {
    const lectures = [lec(1), lec(2), lec(3), lec(4), lec(5, "2026-12-01T08:00:00Z")];
    const out = lectureState(lectures, new Set(["m/1.pdf", "m/3.pdf"]), NOW);
    expect(out.map((l) => l.state)).toEqual(["done", "cur", "done", "up", "soon"]);
  });

  it("an opening date in the past counts as posted", () => {
    const out = lectureState([lec(1, "2026-11-01T08:00:00Z"), lec(2, "2026-11-20T08:00:00Z")], new Set(), NOW);
    expect(out.map((l) => l.state)).toEqual(["cur", "soon"]);
  });

  it("all read: no cur", () => {
    const out = lectureState([lec(1), lec(2)], new Set(["m/1.pdf", "m/2.pdf"]), NOW);
    expect(out.map((l) => l.state)).toEqual(["done", "done"]);
  });

  it("empty list stays empty and keeps the lecture fields", () => {
    expect(lectureState([], new Set(), NOW)).toEqual([]);
    expect(lectureState([lec(1)], new Set(), NOW)[0]).toMatchObject({ n: 1, title: "T1", state: "cur" });
  });
});
