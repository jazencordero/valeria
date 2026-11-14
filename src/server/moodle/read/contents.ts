// Reads one course's sections and the files in them (core_course_get_contents).
// Files come only from `resource` and `folder` modules; every other module is
// listed by name with no files.
// Cut: no page or book content, no videos, no links followed.

import { z } from "zod";
import { callMoodle, type MoodleConn } from "../client";
import { parseAnswer } from "./site";

const FN = "core_course_get_contents";

// One entry of a module's `contents`. Only "file" entries are read, so only
// they must carry what we need. Other types ("url" for a link, "content" for
// book chapters, or anything newer) pass with just their type.
const FileEntry = z.object({
  type: z.literal("file"),
  filename: z.string(),
  filepath: z.string().optional(),
  fileurl: z.string(),
  filesize: z.number().int().nonnegative(),
  mimetype: z.string().optional(),
  // Unix seconds; 0 or null for "not known".
  timemodified: z.number().int().nonnegative().nullable().optional(),
});
const OtherEntry = z.object({ type: z.string().refine((t) => t !== "file") });

const ContentsAnswer = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    section: z.number().int(),
    modules: z.array(
      z.object({
        id: z.number().int(),
        name: z.string(),
        modname: z.string(),
        // False when the module is on the page but closed to her (dates, restrictions).
        uservisible: z.boolean().optional(),
        // Missing for modules with nothing to download, and often for ones she cannot open.
        contents: z.array(z.union([FileEntry, OtherEntry])).optional(),
      }),
    ),
  }),
);

export type ModuleKind = "resource" | "folder" | "url" | "page" | "quiz" | "assign" | "other";

const KNOWN: readonly ModuleKind[] = ["resource", "folder", "url", "page", "quiz", "assign"];
const WITH_FILES: readonly ModuleKind[] = ["resource", "folder"];

export type CourseFile = {
  /** File name; inside a folder's subfolder it keeps the subfolder, for example "extra/notes.pdf". */
  name: string;
  /** Moodle's file URL without the token. Add it only at download time, with `fileUrl` from ../client. */
  url: string;
  mime: string;
  size: number;
  modifiedAt: Date | null;
};

export type CourseModule = {
  /** `cm:<course module id>`, stable across syncs. */
  moodleRef: string;
  name: string;
  kind: ModuleKind;
  /** Empty for every kind but `resource` and `folder`, and for modules she cannot open. */
  files: CourseFile[];
};

export type CourseSection = {
  /** The section's name as Moodle shows it, for example "Week 2: Smoothing". */
  section: string;
  /** Moodle's section number: 0 is the top "General" section, then in page order. */
  position: number;
  modules: CourseModule[];
};

function kindOf(modname: string): ModuleKind {
  return (KNOWN as readonly string[]).includes(modname) ? (modname as ModuleKind) : "other";
}

function fileName(filepath: string | undefined, filename: string): string {
  const dir = (filepath ?? "/").replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${filename}` : filename;
}

/**
 * Every section of the course in Moodle's order, each with its modules.
 *
 * Which modules are kept:
 * - `resource` and `folder` with their files (only `contents` entries of type "file").
 * - `url`, `page`, `quiz`, `assign` by name, with no files.
 * - Any other kind (forum, lesson, h5p, ...) by name as `other`, with no files:
 *   it is still something on her course page, and dropping it would hide it
 *   without a trace. Callers that only want files can filter on `files.length`.
 * - Except `label`: a label is text shown on the course page, not an item,
 *   and its "name" is that text cut short, so it is dropped.
 * - A module she cannot open (`uservisible` false) is kept by name but its files
 *   are skipped: Moodle would refuse the download anyway.
 */
export async function getCourseContents(conn: MoodleConn, courseMoodleId: number): Promise<CourseSection[]> {
  const raw = await callMoodle(conn, FN, { courseid: courseMoodleId });
  return parseAnswer(FN, ContentsAnswer, raw).map((s) => ({
    section: s.name,
    position: s.section,
    modules: s.modules
      .filter((m) => m.modname !== "label")
      .map((m) => {
        const kind = kindOf(m.modname);
        const readFiles = WITH_FILES.includes(kind) && m.uservisible !== false;
        const files: CourseFile[] = readFiles
          ? (m.contents ?? [])
              .filter((c): c is z.output<typeof FileEntry> => c.type === "file")
              .map((f) => ({
                name: fileName(f.filepath, f.filename),
                url: f.fileurl,
                mime: f.mimetype || "application/octet-stream",
                size: f.filesize,
                modifiedAt: f.timemodified ? new Date(f.timemodified * 1000) : null,
              }))
          : [];
        return { moodleRef: `cm:${m.id}`, name: m.name, kind, files };
      }),
  }));
}
