// @vitest-environment node
import { inflateSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { aiCalls } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { saveDraft } from "./store";
import {
  USE_OF_AI_SENTENCE,
  draftToPdf,
  parseMarkdown,
  pdfFileName,
  withUseOfAi,
} from "./pdf";

// The route reads the app database; point it at this test's fresh PGlite.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({} as Db, {
    get(_t, prop) {
      const target = holder.db as Db;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...real, db };
});

const { GET } = await import("@/app/api/drafts/[assignmentId]/pdf/route");

const SLOW = 120_000;
vi.setConfig({ testTimeout: SLOW, hookTimeout: SLOW });

const MODEL = "openai/gpt-oss-120b";
const DAY = new Date("2026-11-15T10:00:00Z");
const OPTIONS = { studentName: "Valeria", courseName: "Plant Biology", model: MODEL, date: DAY };

/* ------------------------------------------------------------------------- */
/* Reading the PDF back.                                                     */
/* ------------------------------------------------------------------------- */

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Every content stream, inflated when it is FlateDecode. */
function streams(bytes: Uint8Array): string[] {
  const raw = latin1(bytes);
  const out: string[] = [];
  for (const m of raw.matchAll(/<<([\s\S]*?)>>\s*stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    const body = Buffer.from(raw.slice(start, end).replace(/\r?\n$/, ""), "latin1");
    if (/\/FlateDecode/.test(m[1])) {
      try {
        out.push(inflateSync(body).toString("latin1"));
      } catch {
        // a font or image stream we do not need
      }
    } else {
      out.push(body.toString("latin1"));
    }
  }
  return out;
}

/** The text drawn on the pages: every string shown with Tj/TJ, in order, per page stream. */
function pageTexts(bytes: Uint8Array): string[] {
  return streams(bytes)
    .filter((s) => /\bBT\b/.test(s))
    .map((s) => {
      let text = "";
      for (const op of s.matchAll(/(\[[^\]]*\]|<[0-9a-fA-F]*>|\((?:\\.|[^\\)])*\))\s*T[jJ]/g)) {
        for (const str of op[1].matchAll(/<([0-9a-fA-F]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
          if (str[1] !== undefined) text += Buffer.from(str[1], "hex").toString("latin1");
          else text += str[2].replace(/\\([()\\])/g, "$1");
        }
      }
      return text.replace(/\s+/g, " ");
    });
}

function textOf(bytes: Uint8Array): string {
  return pageTexts(bytes).join(" ");
}

function pageObjects(bytes: Uint8Array): number {
  return latin1(bytes).match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

/* ------------------------------------------------------------------------- */

describe("draftToPdf", () => {
  it("makes an A4 PDF whose text ends with Use of AI, the model and the date", async () => {
    const md = [
      "# Osmosis",
      "",
      "Water moves **across** a membrane, *towards* more solute.",
      "",
      "- first point",
      "- second point",
      "",
      "1. step one",
      "2. step two",
      "",
      "| Solution | Effect |",
      "|---|---|",
      "| Hypertonic | Cell shrinks |",
      "| Hypotonic | Cell swells |",
    ].join("\n");
    const { bytes, pages, fileName } = await draftToPdf({ title: "Essay 1: Osmosis", contentMd: md }, OPTIONS);

    expect(latin1(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(pages).toBe(1);
    expect(fileName).toBe("Plant-Biology-Essay-1-Osmosis.pdf");
    expect(latin1(bytes)).toMatch(/\/MediaBox\s*\[\s*0 0 595\.2\d* 841\.8\d*\s*\]/);

    const text = textOf(bytes);
    for (const part of ["Plant Biology", "Essay 1: Osmosis", "Valeria", "Water moves across a membrane", "first point", "2.", "step two", "Hypertonic", "Cell swells"]) {
      expect(text).toContain(part);
    }
    expect(text).toContain("Use of AI");
    expect(text).toContain(`Model: ${MODEL}`);
    expect(text).toContain("Date: 15 November 2026");
    expect(text).toContain(USE_OF_AI_SENTENCE);
    // The section is last: nothing of the draft comes after it.
    expect(text.lastIndexOf("Use of AI")).toBeGreaterThan(text.lastIndexOf("Cell swells"));
    expect(text).not.toContain("**");
  });

  it("gives a long draft several pages, counts them right, and puts Use of AI on the last", async () => {
    const paragraph =
      "Osmosis is the movement of water across a semi-permeable membrane from a region of low solute " +
      "concentration to a region of high solute concentration, until both sides are balanced.";
    const md = Array.from({ length: 40 }, (_, i) => `## Part ${i + 1}\n\n${paragraph}`).join("\n\n");
    const { bytes, pages } = await draftToPdf({ title: "Long essay", contentMd: md }, OPTIONS);

    expect(pages).toBeGreaterThan(1);
    expect(pages).toBe(pageObjects(bytes));
    const perPage = pageTexts(bytes);
    expect(perPage).toHaveLength(pages);
    expect(perPage.at(-1)).toContain("Use of AI");
    expect(perPage.at(-1)).toContain(MODEL);
    expect(perPage[0]).not.toContain("Use of AI");
    expect(perPage.at(-1)).toContain(`${pages} / ${pages}`);
  });

  it("keeps her own wording of Use of AI, moves it to the end, and puts back a missing model", async () => {
    const md = [
      "## Use of AI",
      "",
      "I asked the chat for an outline and rewrote every paragraph myself. Date: 14 November 2026.",
      "",
      "## Results",
      "",
      "Cells swelled.",
    ].join("\n");
    const { bytes } = await draftToPdf({ title: "Essay", contentMd: md }, OPTIONS);
    const text = textOf(bytes);

    expect(text).toContain("I asked the chat for an outline and rewrote every paragraph myself.");
    expect(text).not.toContain(USE_OF_AI_SENTENCE);
    expect(text.match(/Use of AI/g)).toHaveLength(1);
    expect(text.indexOf("Use of AI")).toBeGreaterThan(text.indexOf("Cells swelled."));
    // She left out the model, so it is put back; she gave a date, so hers stands.
    expect(text).toContain(`Model: ${MODEL}`);
    expect(text).not.toContain("Date: 15 November 2026");
  });

  it("never drops the section, even when she emptied it", () => {
    const blocks = withUseOfAi(parseMarkdown("Text.\n\n### use of AI:\n"), MODEL, DAY);
    expect(blocks.at(-4)).toEqual({ kind: "heading", level: 2, text: "Use of AI" });
    expect(blocks.slice(-3)).toEqual([
      { kind: "paragraph", text: `Model: ${MODEL}` },
      { kind: "paragraph", text: "Date: 15 November 2026" },
      { kind: "paragraph", text: USE_OF_AI_SENTENCE },
    ]);
  });

  it("draws characters the built-in font lacks as ?, and names the file safely", async () => {
    const { bytes } = await draftToPdf({ title: "Ääni 😀", contentMd: "Hyvä työ 😀 done." }, OPTIONS);
    expect(textOf(bytes)).toContain("Hyvä työ ? done.");
    expect(pdfFileName("Kemia / Äö: \"1\"", "Työ ../../x")).toBe("Kemia-Ao-1-Tyo-x.pdf");
    expect(pdfFileName("", null)).toBe("draft.pdf");
  });
});

/* ------------------------------------------------------------------------- */
/* The route.                                                                */
/* ------------------------------------------------------------------------- */

describe("GET /api/drafts/[assignmentId]/pdf", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    holder.db = t.db;
  });
  afterEach(async () => {
    await t.close();
  });

  let refs = 0;
  async function signedIn(name: string) {
    const { user, token } = await ensureSessionFor(t.db, newToken());
    await t.db.update(users).set({ displayName: name }).where(eq(users.id, user.id));
    return { userId: user.id, cookie: `other=1; ${SESSION_COOKIE}=${token}` };
  }
  async function assignmentFor(userId: string) {
    const [course] = await t.db
      .insert(courses)
      .values({ userId, moodleId: ++refs, name: "Plant Biology", aiAssignments: "allowed" })
      .returning();
    const [assignment] = await t.db
      .insert(assignments)
      .values({ userId, courseId: course.id, moodleId: ++refs, name: "Essay 1" })
      .returning();
    return assignment.id;
  }
  function get(id: string, cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    return GET(new Request(`http://localhost/api/drafts/${id}/pdf`, { headers }), {
      params: Promise.resolve({ assignmentId: id }),
    });
  }

  it("gives the owner her PDF as an uncached attachment, naming the model that wrote it", async () => {
    const owner = await signedIn("Valeria");
    const id = await assignmentFor(owner.userId);
    const draft = await saveDraft(owner.userId, id, { title: "Osmosis", contentMd: "Water moves." }, t.db);
    // An older call by another model, then the call that wrote the draft (logged when it ended).
    await t.db.insert(aiCalls).values([
      { provider: "groq", model: "qwen/older", job: "assignment-chat", ok: true, ms: 1, userId: owner.userId, createdAt: new Date(draft.updatedAt.getTime() - 60_000) },
      { provider: "groq", model: MODEL, job: "assignment-chat", ok: true, ms: 1, userId: owner.userId, createdAt: new Date(draft.updatedAt.getTime() + 500) },
    ]);

    const res = await get(id, owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Plant-Biology-Osmosis.pdf"; filename*=UTF-8''Plant-Biology-Osmosis.pdf`,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(latin1(bytes.subarray(0, 5))).toBe("%PDF-");
    const text = textOf(bytes);
    expect(text).toContain("Valeria");
    expect(text).toContain("Use of AI");
    expect(text).toContain(`Model: ${MODEL}`);
    expect(text).not.toContain("qwen/older");
  });

  it("answers 404 to another user, without a session, for unknown or malformed ids, and with no draft", async () => {
    const owner = await signedIn("Valeria");
    const id = await assignmentFor(owner.userId);
    await saveDraft(owner.userId, id, { title: "Osmosis", contentMd: "Water moves." }, t.db);
    const empty = await assignmentFor(owner.userId);
    const other = await signedIn("Someone else");

    for (const [assignmentId, cookie] of [
      [id, other.cookie],
      [id, undefined],
      [id, `${SESSION_COOKIE}=not-a-real-session`],
      ["00000000-0000-4000-8000-000000000000", owner.cookie],
      ["not-a-uuid", owner.cookie],
      [empty, owner.cookie],
    ] as const) {
      const res = await get(assignmentId, cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});
