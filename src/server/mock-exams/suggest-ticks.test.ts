// @vitest-environment node
// "Check my answer": who may use it, and what happens before any AI call. An invented part and
// the fake AI; this file sits outside src/server/ai/, so it never imports the router.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { tutorMessages } from "@/server/db/schema/learn";
import { aiCalls } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { startFakeAi, type FakeAi } from "../../../tests/fake-ai/server";
import { EMPTY_LINES, PER_MINUTE, suggestTicksForPart, type SuggestOptions, type SuggestPart } from "./suggest-ticks";

const PART: SuggestPart = {
  text: "INVENTED-Q: What is the average of 2, 4 and 9?",
  points: 2,
  modelAnswer: "INVENTED-MODEL: (2 + 4 + 9) / 3 = 5.",
  ticks: [
    { text: "Adds the three numbers to 15", points: 1 },
    { text: "Divides by 3 to get 5", points: 1 },
  ],
  commonWrong: null,
};
const GOOD = "MY-ANSWER: 2 + 4 + 9 = 15, and 15 / 3 = 5.";

let ai: FakeAi;
let t: TestDb;

beforeAll(async () => {
  ai = await startFakeAi();
});
afterAll(async () => {
  await ai.close();
});
beforeEach(async () => {
  ai.reset();
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

type Setup = { tutor?: boolean; study?: "unknown" | "allowed" | "not_allowed"; useFiles?: boolean };

async function student(s: Setup = {}) {
  const settings: Record<string, unknown> = { tutor: { enabled: s.tutor ?? true } };
  if (s.useFiles === false) settings.ai = { useFiles: false };
  const [user] = await t.db.insert(users).values({ settings }).returning();
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: 1, name: "Statistics 1", aiStudy: s.study ?? "allowed" })
    .returning();
  return { user, course };
}

function opts(extra: Partial<SuggestOptions> = {}): SuggestOptions {
  return {
    db: t.db,
    ai: { env: { GROQ_API_KEY: "fake-groq-key" }, baseUrlFor: (entry) => `${ai.url}/${entry.provider}/v1` },
    ...extra,
  };
}

describe("suggestTicksForPart", () => {
  it("a good answer gets the ticks the model gives, through the tutor's chain", async () => {
    const { user, course } = await student();
    ai.queue("groq", { text: JSON.stringify({ ticks: [1, 0, 5], missing: ["Both steps are there.", "Clear working."] }) });
    const r = await suggestTicksForPart(user.id, course.id, PART, GOOD, opts());
    expect(r).toEqual({ status: "ok", ticks: [0, 1], missing: ["Both steps are there.", "Clear working."], model: "groq:openai/gpt-oss-120b" });
    expect(ai.calls).toHaveLength(1);
    expect(await t.db.select().from(tutorMessages)).toHaveLength(1);
  });

  it("an empty or whitespace answer: no ticks, two fixed lines, no AI call", async () => {
    const { user, course } = await student();
    for (const answer of ["", "   \n\t "]) {
      expect(await suggestTicksForPart(user.id, course.id, PART, answer, opts())).toEqual({ status: "ok", ticks: [], missing: [...EMPTY_LINES], model: "none" });
    }
    expect(ai.calls).toHaveLength(0);
    expect(await t.db.select().from(tutorMessages)).toHaveLength(0);
  });

  it.each<[string, Setup]>([
    ["the tutor switch is off", { tutor: false }],
    ["the study rule is unknown", { study: "unknown" }],
    ["the study rule is not_allowed", { study: "not_allowed" }],
    ["her files switch is off", { useFiles: false }],
  ])("unavailable with no AI call when %s", async (_why, setup) => {
    const { user, course } = await student(setup);
    expect(await suggestTicksForPart(user.id, course.id, PART, GOOD, opts())).toEqual({ status: "unavailable" });
    expect(ai.calls).toHaveLength(0);
  });

  it("unavailable with no AI call when the course is not hers, or an id is malformed", async () => {
    const me = await student();
    const other = await student();
    expect(await suggestTicksForPart(me.user.id, other.course.id, PART, GOOD, opts())).toEqual({ status: "unavailable" });
    expect(await suggestTicksForPart(me.user.id, crypto.randomUUID(), PART, GOOD, opts())).toEqual({ status: "unavailable" });
    expect(await suggestTicksForPart("not-a-uuid", me.course.id, PART, GOOD, opts())).toEqual({ status: "unavailable" });
    expect(ai.calls).toHaveLength(0);
  });

  it("abuse guard: 30 tutor calls in the last minute make it unavailable without a call", async () => {
    const { user, course } = await student();
    await t.db.insert(aiCalls).values(Array.from({ length: PER_MINUTE }, () => ({ provider: "groq", model: "m", job: "tutor", ok: true, ms: 1, userId: user.id })));
    expect(await suggestTicksForPart(user.id, course.id, PART, GOOD, opts())).toEqual({ status: "unavailable" });
    expect(ai.calls).toHaveLength(0);
  });

  it("AI trouble is unavailable, never thrown", async () => {
    const { user, course } = await student();
    ai.queue("groq", { status: 503 });
    await expect(suggestTicksForPart(user.id, course.id, PART, GOOD, opts())).resolves.toEqual({ status: "unavailable" });
  });
});
