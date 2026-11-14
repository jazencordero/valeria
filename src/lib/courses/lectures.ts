/**
 * Which course files are lectures (M9-02). Pure: no clock, no I/O.
 *
 * `lecturesFrom(sections)` reads a course's contents (the output of
 * `getCourseContents`, ticket M2-07) and returns its lectures in order.
 * `lectureState(lectures, readSet, now)` marks each one done / cur / up / soon.
 *
 * The rules are a first guess (the ticket's Cut): M9-04 re-tests them on a
 * real course. Every rule is written next to the code that applies it.
 *
 * ## Input
 *
 * `CourseSection` is M2-07's planned return type
 * (`[{section, position, modules: [{moodleRef, name, kind, files: [{name, url,
 * mime, size, modifiedAt}]}]}]`) plus three optional restriction fields on a
 * module that M2-07 does not list yet:
 *
 * - `available`: Moodle's `uservisible`. `false` means the student cannot
 *   open it yet.
 * - `opensAt`: a structured opening date, when the caller has one (for example
 *   from the module's `dates` or from the `availability` JSON condition
 *   `{"type":"date","d":">=","t":<unix seconds>}`). Wins over the text below.
 * - `availabilityInfo`: Moodle's `availabilityinfo`, the human sentence (often
 *   HTML) such as "Not available unless: It is on or after <strong>12 December
 *   2026, 10:00</strong>". Parsed only when `opensAt` is missing; see
 *   `parseOpensAt`.
 *
 * Raw `core_course_get_contents` fits after the obvious renames (section
 * `name` -> `section`, module `id` -> `moodleRef`, `modname` -> `kind`,
 * `contents[]` `filename/fileurl/mimetype/timemodified` -> `name/url/mime/
 * modifiedAt`, `uservisible` -> `available`). M2-07 keeps only modules that
 * carry files; for restricted lectures to show up it must also keep a
 * `resource`/`folder` module that has no files but has a restriction.
 */

// ---------------------------------------------------------------------------
// Types

/** A date as Moodle or our reader hands it over. Numbers below 1e12 are unix seconds, otherwise milliseconds. */
export type DateLike = string | number | Date;

export type CourseFile = {
  name: string;
  url: string;
  mime?: string | null;
  size?: number | null;
  modifiedAt?: DateLike | null;
};

export type CourseModule = {
  moodleRef: number | string;
  name: string;
  /** Moodle `modname`: `resource`, `folder`, `url`, `page`, `quiz`, `assign`, ... */
  kind: string;
  files: CourseFile[];
  available?: boolean | null;
  opensAt?: DateLike | null;
  availabilityInfo?: string | null;
};

export type CourseSection = {
  section: string;
  position: number;
  modules: CourseModule[];
};

export type Lecture = {
  /** Lecture number: from the name, else from order. Two files may share one (two parts of lecture 3). */
  n: number;
  /** Name with numbering, generic words ("slides") and extension removed. May be "": the screen then says "Lecture n". */
  title: string;
  /** Stable id for the file: `<moodleRef>/<file name>`. Survives re-uploads (the url does not). null while restricted. */
  fileRef: string | null;
  /** Where to fetch the file. null while restricted. */
  url: string | null;
  /** Section name the lecture sits in. */
  section: string;
  /** ISO time the file was last changed, when known. */
  postedAt: string | null;
  /** ISO time a restricted module opens. null for files that are already there. */
  opensAt: string | null;
};

export type LectureStatus = "done" | "cur" | "up" | "soon";
export type LectureWithState = Lecture & { state: LectureStatus };

// ---------------------------------------------------------------------------
// Rules

/** Rule: only PDFs and slide decks can be lectures. Data files (csv, xlsx, zip, ...) and documents (docx) never are. */
const SLIDE_EXT = new Set(["pdf", "ppt", "pptx", "pps", "ppsx", "key", "odp"]);
const SLIDE_MIME = [
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.apple.keynote",
  "application/x-iwork-keynote",
];

/** Rule: only `resource` and `folder` modules hold lecture files. `assign` (assignment briefs), `url`, `page`, `quiz` never do. */
const FILE_KINDS = new Set(["resource", "folder"]);

// Letters for "not inside a word" checks. \b does not know ä/ö/å.
const L = "a-zäöå";

/**
 * Strong lecture words, in a file, module or section name.
 * English: lecture, lect, lec3, slides. Finnish: luento (any form, also inside
 * compounds like "vierailuluento", "luentokalvot"), luennot, kalvot.
 */
const STRONG = new RegExp(
  `(?<![${L}])(lectures?|lect(?![${L}])|lec(?=\\d)|slides?(?![${L}])|slide deck)|luento|luenno|kalvo`,
  "i",
);
/** L1, L01, L 3, L-02: a lecture number on its own. */
const L_NUM = new RegExp(`(?<![${L}\\d])l[\\s_-]?0*(\\d{1,2})(?![${L}\\d])`, "i");
/** week 3, wk3, viikko 3, vko 3, session 2, sessio 2: a lecture signal too (the ticket lists them). */
const WEEK_SESSION = new RegExp(
  `(?<![${L}])(week|wk|viikko|vko|session|sessio)[\\s_.#:-]*0*(\\d{1,2})(?!\\d)`,
  "i",
);
/** 3. luento, 3. viikko, 3rd lecture: Finnish and English ordinals. */
const ORDINAL = new RegExp(
  `(?<![\\d])0*(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s+(luento|lecture|viikko|week|sessio|session)`,
  "i",
);

/**
 * Hard exclusions: if the file or module name says one of these it is not a
 * lecture, whatever else it says. Finnish words are matched as substrings
 * because Finnish glues words together ("kotitehtävä", "kurssiohjelma").
 */
const HARD_EXCLUDE: { why: string; re: RegExp }[] = [
  {
    why: "assignment",
    re: new RegExp(
      `(?<![${L}])(assignments?|brief|homework|instructions|hand-?in)(?![${L}])|tehtävänanto|tehtävä|palautus|ohjeet`,
      "i",
    ),
  },
  {
    why: "reading",
    re: new RegExp(`(?<![${L}])(readings?|articles?|literature)(?![${L}])|lukemisto|artikkel|luettava|kirjallisuus`, "i"),
  },
  {
    why: "syllabus",
    re: new RegExp(
      `(?<![${L}])(syllabus|course (info|information|outline|guide|description|overview)|schedule|timetable)(?![${L}])|opinto-?opas|kurssiesite|kurssin tiedot|kurssiohjelma|aikataulu`,
      "i",
    ),
  },
  { why: "exam", re: new RegExp(`(?<![${L}])(exams?|midterm)(?![${L}])|tentti|tentit`, "i") },
  { why: "data", re: new RegExp(`(?<![${L}])(data ?sets?)(?![${L}])`, "i") },
];

/**
 * Soft exclusion: exercises and their solutions. Left out unless the same
 * name also carries a strong lecture word ("Lecture 4 exercise walkthrough
 * slides.pdf" stays).
 */
const SOFT_EXCLUDE = new RegExp(
  `(?<![${L}])(exercises?|problem sets?|solutions?|tutorials?|workshop)(?![${L}])|harjoitu|ratkaisu|mallivastau`,
  "i",
);

/** Generic words cut from the edges of a title once the numbering is gone. */
const GENERIC_EDGE = new RegExp(
  `^(lecture slides|lecture notes|lecture|lect|slides?|slide deck|luentokalvot|luentomateriaali|luento|kalvot)(?![${L}])|(?<![${L}])(lecture slides|lecture notes|slides?|slide deck|luentokalvot|kalvot|luento)$`,
  "i",
);

/** Separators trimmed from title edges. */
const EDGE_SEP = /^[\s\-–—_:.,;|/#]+|[\s\-–—_:.,;|/#]+$/g;

// ---------------------------------------------------------------------------
// Small helpers

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

function stripExt(name: string): string {
  return name.trim().replace(/\.[a-z0-9]{1,5}$/i, "");
}

/** Underscores and repeated spaces become one space, so "L01_Intro" reads like "L01 Intro". */
function normalise(name: string): string {
  return name.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
}

/** Rule: a slide file by extension; files with no extension fall back to their mime type. */
function isSlideFile(file: CourseFile): boolean {
  const ext = extOf(file.name);
  if (ext) return SLIDE_EXT.has(ext);
  const mime = (file.mime ?? "").toLowerCase();
  return SLIDE_MIME.some((m) => mime.startsWith(m));
}

function hasLectureSignal(text: string): boolean {
  const t = normalise(text);
  return STRONG.test(t) || L_NUM.test(t) || WEEK_SESSION.test(t) || ORDINAL.test(t);
}

function hardExcluded(text: string): boolean {
  const t = normalise(text);
  return HARD_EXCLUDE.some(({ re }) => re.test(t));
}

function softExcluded(text: string): boolean {
  return SOFT_EXCLUDE.test(normalise(text));
}

function isStrong(text: string): boolean {
  return STRONG.test(normalise(text));
}

/**
 * The lecture number inside a name, and the text with that numbering cut out.
 * Patterns, first match wins:
 *   1. keyword + number: "Lecture 5", "lect07", "Luento 3", "luentokalvot_4",
 *      "Week 3", "Viikko 3", "Session 2", "Slides 6", "Kalvot 2".
 *   2. ordinal + keyword: "3. luento", "2nd lecture".
 *   3. L-number: "L1", "L01".
 *   4. a leading 1-2 digit number followed by a separator: "03 Pricing", "1. Intro".
 *      Years ("2026 ...") are 4 digits and never match.
 */
export function parseNumber(name: string): { n: number | null; rest: string } {
  const t = normalise(stripExt(name));
  const keyword = new RegExp(
    `(?<![${L}])(lectures?|lect|lec|luento[${L}]*|luenno[${L}]*|week|wk|viikko|vko|session|sessio|slides?|kalvot|kalvo)[\\s.#:-]*(?:no\\.?\\s*|nro\\.?\\s*)?0*(\\d{1,3})(?!\\d)`,
    "i",
  );
  const leading = /^0*(\d{1,2})(?=[\s.)\-–—:]|$)\.?/;
  // Finnish compounds: "Vierailuluento 8" is guest lecture 8; keep the word, cut the number.
  const compound = new RegExp(`(?<![\\d])([${L}]+)(luento|luenno[${L}]*|kalvot)[\\s.#:-]*0*(\\d{1,3})(?!\\d)`, "i");
  const c = compound.exec(t);
  if (c && !keyword.test(t)) {
    const rest = t.slice(0, c.index) + c[1] + c[2] + " " + t.slice(c.index + c[0].length);
    return { n: Number(c[3]), rest };
  }
  for (const re of [keyword, ORDINAL, L_NUM, leading]) {
    const m = re.exec(t);
    if (!m) continue;
    const digits = m.slice(1).find((g) => g !== undefined && /^\d+$/.test(g));
    if (digits === undefined) continue;
    const rest = t.slice(0, m.index) + " " + t.slice(m.index + m[0].length);
    return { n: Number(digits), rest };
  }
  return { n: null, rest: t };
}

/** Title: numbering, generic edge words ("slides", "luento") and separators removed. */
export function titleFrom(name: string): string {
  let t = parseNumber(name).rest;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/\s+/g, " ").replace(EDGE_SEP, "").replace(GENERIC_EDGE, "").replace(EDGE_SEP, "");
    if (t === before) break;
  }
  // A dangling "()" or "( )" after cuts.
  return t.replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
}

function toIso(d: DateLike | null | undefined): string | null {
  if (d === null || d === undefined || d === "") return null;
  let date: Date;
  if (d instanceof Date) date = d;
  else if (typeof d === "number") date = new Date(d < 1e12 ? d * 1000 : d);
  else if (/^\d+$/.test(d.trim())) return toIso(Number(d.trim()));
  else date = new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// Restricted dates

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  // Finnish, as Moodle writes them ("12. joulukuuta 2026") and the bare forms.
  tammikuuta: 1, helmikuuta: 2, maaliskuuta: 3, huhtikuuta: 4, toukokuuta: 5, kesäkuuta: 6,
  heinäkuuta: 7, elokuuta: 8, syyskuuta: 9, lokakuuta: 10, marraskuuta: 11, joulukuuta: 12,
  tammikuu: 1, helmikuu: 2, maaliskuu: 3, huhtikuu: 4, toukokuu: 5, kesäkuu: 6,
  heinäkuu: 7, elokuu: 8, syyskuu: 9, lokakuu: 10, marraskuu: 11, joulukuu: 12,
};

/** Words that make a date an opening date ("from", "on or after", "opens", "alkaen", "jälkeen", "lähtien", "myöhemmin"). */
const AFTER_CUE = /\b(from|after|opens?)\b|alkaen|jälkeen|lähtien|myöhemmin|avautuu/i;

const helsinkiParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
});

function helsinkiOffset(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of helsinkiParts.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute);
  return asUtc - Math.floor(ms / 60000) * 60000;
}

/** The instant a Helsinki wall-clock time happens (DST-safe, same method as src/lib/dates.ts). */
function fromHelsinki(y: number, mo: number, d: number, h: number, mi: number): string {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - helsinkiOffset(guess);
  const second = helsinkiOffset(ms);
  if (guess - second !== ms) ms = guess - second;
  return new Date(ms).toISOString();
}

function clockOf(hh?: string, mm?: string, ampm?: string): [number, number] {
  let h = hh ? Number(hh) : 0;
  const m = mm ? Number(mm) : 0;
  if (ampm) {
    const pm = ampm.toLowerCase() === "pm";
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return [h, m];
}

/**
 * Opening date from Moodle's `availabilityinfo` text.
 *
 * - HTML tags and entities are dropped first.
 * - The text must carry an "after" cue (see AFTER_CUE); "until <date>" alone
 *   is a closing date and gives null.
 * - The first date in the text wins (in "on or after X and before Y" that is X).
 * - Formats: "12 December 2026, 10:00 AM", "12. joulukuuta 2026, 10.00",
 *   "December 12, 2026", "12.12.2026 klo 10.00", "2026-12-12 10:00".
 * - Moodle prints the time in the student's profile zone; we read it as
 *   Europe/Helsinki. No time means 00:00.
 * Returns an ISO string, or null when there is no readable opening date.
 */
export function parseOpensAt(info: string | null | undefined): string | null {
  if (!info) return null;
  const text = info
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ");
  if (!AFTER_CUE.test(text)) return null;

  const time = String.raw`(?:,?\s*(?:klo|at|kello)?\s*(\d{1,2})[:.](\d{2})\s*(am|pm)?)?`;
  type Found = { at: number; iso: string };
  const found: Found[] = [];
  const push = (at: number, y: number, mo: number, d: number, hh?: string, mm?: string, ap?: string) => {
    if (!mo || mo > 12 || d < 1 || d > 31) return;
    const [h, mi] = clockOf(hh, mm, ap);
    found.push({ at, iso: fromHelsinki(y, mo, d, h, mi) });
  };

  // 12 December 2026 / 12. joulukuuta 2026
  for (const m of text.matchAll(new RegExp(String.raw`(\d{1,2})\.?\s+([${L}]+)\s+(\d{4})` + time, "gi"))) {
    push(m.index ?? 0, +m[3], MONTHS[m[2].toLowerCase()], +m[1], m[4], m[5], m[6]);
  }
  // December 12, 2026
  for (const m of text.matchAll(new RegExp(String.raw`([${L}]+)\s+(\d{1,2}),?\s+(\d{4})` + time, "gi"))) {
    push(m.index ?? 0, +m[3], MONTHS[m[1].toLowerCase()], +m[2], m[4], m[5], m[6]);
  }
  // 12.12.2026 (Finnish numeric)
  for (const m of text.matchAll(new RegExp(String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})` + time, "gi"))) {
    push(m.index ?? 0, +m[3], +m[2], +m[1], m[4], m[5], m[6]);
  }
  // 2026-12-12
  for (const m of text.matchAll(new RegExp(String.raw`(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?`, "g"))) {
    push(m.index ?? 0, +m[1], +m[2], +m[3], m[4], m[5]);
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a.at - b.at);
  return found[0].iso;
}

/** Rule: a module is restricted when Moodle says it is not visible yet, or it has no files but carries a restriction. */
function isRestricted(mod: CourseModule): boolean {
  if (mod.available === false) return true;
  return mod.files.length === 0 && (mod.opensAt != null || !!mod.availabilityInfo);
}

// ---------------------------------------------------------------------------
// lecturesFrom

type Candidate = {
  parsedN: number | null;
  title: string;
  fileRef: string | null;
  url: string | null;
  section: string;
  postedAt: string | null;
  opensAt: string | null;
  sortName: string;
  order: [number, number, number, number];
};

/**
 * Exclusion check for one name set. Hard words in the file or module name
 * always exclude. Exercise words exclude unless that same name set has a
 * strong lecture word. A section named like an exclusion ("Assignments",
 * "Lukemisto") excludes its files unless the file or module name itself has
 * a strong lecture word.
 */
function excluded(names: string[], sectionName: string): boolean {
  if (names.some(hardExcluded)) return true;
  const strong = names.some(isStrong);
  if (names.some(softExcluded) && !strong) return true;
  if ((hardExcluded(sectionName) || softExcluded(sectionName)) && !strong) return true;
  return false;
}

/**
 * The ordered lectures of one course.
 *
 * Rules, in order:
 * 1. Sections are walked by `position`, modules and files in their listed order.
 * 2. Only `resource`/`folder` modules count (see FILE_KINDS).
 * 3. A file is a lecture when it is a slide file (see SLIDE_EXT) AND its file
 *    name, module name or section name has a lecture signal (lecture, lect,
 *    luento, luennot, slides, kalvot, L1/L01, week 3, viikko 3, session 2,
 *    "3. luento") AND it is not excluded (see `excluded`).
 * 4. A restricted module (see `isRestricted`) whose module or section name has
 *    a lecture signal and is not excluded becomes a lecture with `opensAt`,
 *    no file and no postedAt. The date is the structured `opensAt` when given,
 *    else parsed from `availabilityInfo`. Without a readable date it is left
 *    out: we cannot say when it comes, and the next sync will show it.
 * 5. Number: from the file name, else (for a resource, or a folder with one
 *    slide file) from the module name. Lectures without one get, in course
 *    order, the smallest unused number above the previous lecture's number,
 *    so [Intro, Lecture 2, Lecture 3] numbers Intro 1.
 * 6. Title: for a resource, the module name (people name modules for humans,
 *    files for machines) with numbering removed; if that leaves nothing, the
 *    file name. For a folder, the file name. May end up "".
 * 7. Output sorted by number, then section order, then name, then listed order.
 * Nothing matches: []. No guessing.
 */
export function lecturesFrom(sections: readonly CourseSection[]): Lecture[] {
  const ordered = sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.position - b.s.position || a.i - b.i);

  const found: Candidate[] = [];

  for (const { s, i: si } of ordered) {
    const sectionName = s.section ?? "";
    const sectionSignal = hasLectureSignal(sectionName);

    s.modules.forEach((mod, mi) => {
      if (!FILE_KINDS.has(mod.kind)) return;
      const isFolder = mod.kind === "folder";

      if (isRestricted(mod)) {
        if (!(sectionSignal || hasLectureSignal(mod.name))) return;
        if (excluded([mod.name], sectionName)) return;
        const opensAt = toIso(mod.opensAt ?? null) ?? parseOpensAt(mod.availabilityInfo);
        if (!opensAt) return;
        found.push({
          parsedN: parseNumber(mod.name).n,
          title: titleFrom(mod.name),
          fileRef: null,
          url: null,
          section: sectionName,
          postedAt: null,
          opensAt,
          sortName: mod.name,
          order: [s.position, si, mi, 0],
        });
        return;
      }

      const slides = mod.files.filter(isSlideFile);
      slides.forEach((file, fi) => {
        const names = [file.name, mod.name];
        const signal = sectionSignal || names.some(hasLectureSignal);
        if (!signal) return;
        // For a folder, the folder name alone does not excuse a file named "exercise".
        if (excluded(isFolder ? [file.name] : names, sectionName)) return;
        if (isFolder && hardExcluded(mod.name)) return;

        const moduleNameCounts = !isFolder || slides.length === 1;
        const parsedN = parseNumber(file.name).n ?? (moduleNameCounts ? parseNumber(mod.name).n : null);
        let title = isFolder ? titleFrom(file.name) : titleFrom(mod.name);
        if (!title) title = isFolder ? "" : titleFrom(file.name);

        found.push({
          parsedN,
          title,
          fileRef: `${mod.moodleRef}/${file.name}`,
          url: file.url,
          section: sectionName,
          postedAt: toIso(file.modifiedAt ?? null),
          opensAt: null,
          sortName: isFolder ? file.name : mod.name,
          order: [s.position, si, mi, fi],
        });
      });
    });
  }

  if (found.length === 0) return [];

  // Rule 5: fill missing numbers from order.
  const taken = new Set(found.map((c) => c.parsedN).filter((n): n is number => n !== null));
  let last = 0;
  const numbered = found.map((c) => {
    let n = c.parsedN;
    if (n === null) {
      n = last + 1;
      while (taken.has(n)) n++;
      taken.add(n);
    }
    last = n;
    return { c, n };
  });

  numbered.sort((a, b) => {
    if (a.n !== b.n) return a.n - b.n;
    const oa = a.c.order;
    const ob = b.c.order;
    if (oa[0] !== ob[0]) return oa[0] - ob[0];
    if (oa[1] !== ob[1]) return oa[1] - ob[1];
    if (a.c.sortName !== b.c.sortName) return a.c.sortName < b.c.sortName ? -1 : 1;
    return oa[2] - ob[2] || oa[3] - ob[3];
  });

  return numbered.map(({ c, n }) => ({
    n,
    title: c.title,
    fileRef: c.fileRef,
    url: c.url,
    section: c.section,
    postedAt: c.postedAt,
    opensAt: c.opensAt,
  }));
}

// ---------------------------------------------------------------------------
// lectureState

/**
 * Each lecture with its state, in the given order.
 *
 * - `done`: its fileRef is in `readSet`.
 * - posted: `opensAt` is null or `opensAt <= now`. This needs `now`, so it is
 *   a parameter (default: the clock, for callers that do not care; tests and
 *   screens should pass it).
 * - `cur`: the first posted lecture that is not done.
 * - `up`: every later posted lecture that is not done.
 * - `soon`: not posted yet. A lecture whose date has passed but whose file has
 *   not synced yet (fileRef null) counts as posted; it cannot be done until
 *   the file arrives.
 */
export function lectureState(
  lectures: readonly Lecture[],
  readSet: ReadonlySet<string>,
  now: Date | string | number = new Date(),
): LectureWithState[] {
  const nowMs = new Date(now).getTime();
  let curGiven = false;
  return lectures.map((l) => {
    const posted = l.opensAt === null || new Date(l.opensAt).getTime() <= nowMs;
    let state: LectureStatus;
    if (l.fileRef !== null && readSet.has(l.fileRef)) state = "done";
    else if (!posted) state = "soon";
    else if (!curGiven) {
      state = "cur";
      curGiven = true;
    } else state = "up";
    return { ...l, state };
  });
}
