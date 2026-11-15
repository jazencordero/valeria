// @vitest-environment node
/*
 * M2-21, M2-27. Runs in node because the action writes to a real PGlite test
 * database (src/server/db/client.ts refuses to load where `window` exists),
 * so the component is checked with server rendering, not clicks.
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCourseAiPolicy, type AiPolicy } from "@/app/(app)/assignments/[id]/policy-actions";
import { courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import {
  AI_CHAT_OFF_LINE,
  AI_OFF_LINE,
  AI_UNKNOWN_LINE,
  AiPolicyCard,
  ANSWER_POLICY,
  chatHidden,
  EXPLAIN_ONLY_LINE,
  isExplainOnly,
  policyLine,
  type PolicyAnswer,
} from "./ai-policy";
import { chatProblem } from "./workspace";

const h = vi.hoisted(() => ({ db: undefined as unknown, userId: null as string | null }));

vi.mock("next/cache", () => ({ refresh: vi.fn() }));

// The action reads the signed-in user from the cookie; here it is whoever h.userId says.
vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    currentUser: vi.fn(async () => {
      if (!h.userId) throw new actual.NotSignedIn();
      return { id: h.userId };
    }),
  };
});

// The action's `db` forwards to this test's PGlite.
vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    db: new Proxy({}, { get: (_target, prop) => Reflect.get(h.db as object, prop) }),
  };
});

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  h.db = t.db;
  h.userId = null;
});

afterEach(async () => {
  await t.close();
});

async function seedCourse(moodleId: number, aiAssignments: AiPolicy = "unknown") {
  const [user] = await t.db.insert(users).values({ displayName: "Student" }).returning();
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId, name: "Sample Course", aiAssignments, aiStudy: "allowed" })
    .returning();
  return { userId: user.id, courseId: course.id };
}

async function storedPolicy(courseId: string) {
  const [row] = await t.db
    .select({ aiAssignments: courses.aiAssignments })
    .from(courses)
    .where(eq(courses.id, courseId));
  return row.aiAssignments;
}

describe("setCourseAiPolicy", () => {
  const cases: [PolicyAnswer, AiPolicy][] = [
    ["yes", "allowed"],
    ["explain", "explain"],
    ["no", "off"],
    ["not_sure", "unknown"],
  ];

  it.each(cases)("answer %s stores %s", async (answer, expected) => {
    // Start from the other side so "Not sure" is seen to write too.
    const { userId, courseId } = await seedCourse(100, answer === "not_sure" ? "allowed" : "unknown");
    h.userId = userId;

    const result = await setCourseAiPolicy(courseId, ANSWER_POLICY[answer]);

    expect(result).toEqual({ ok: true, policy: expected });
    expect(await storedPolicy(courseId)).toBe(expected);
    // The study rule is not asked here and is never touched.
    const [row] = await t.db.select({ aiStudy: courses.aiStudy }).from(courses).where(eq(courses.id, courseId));
    expect(row.aiStudy).toBe("allowed");
  });

  it("refuses another user's course and leaves it alone", async () => {
    const owner = await seedCourse(100);
    const other = await seedCourse(200);
    h.userId = other.userId;

    const result = await setCourseAiPolicy(owner.courseId, "allowed");

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(await storedPolicy(owner.courseId)).toBe("unknown");
  });

  it("refuses when nobody is signed in", async () => {
    const { courseId } = await seedCourse(100);

    expect(await setCourseAiPolicy(courseId, "allowed")).toEqual({ ok: false, reason: "signed_out" });
    expect(await storedPolicy(courseId)).toBe("unknown");
  });

  it("rejects a value that is not a policy, and an id that is not a uuid", async () => {
    const { userId, courseId } = await seedCourse(100);
    h.userId = userId;

    expect(await setCourseAiPolicy(courseId, "sure, why not")).toEqual({ ok: false, reason: "invalid" });
    // The old column's "no" is not a value any more.
    expect(await setCourseAiPolicy(courseId, "not_allowed")).toEqual({ ok: false, reason: "invalid" });
    expect(await setCourseAiPolicy("1; drop table courses", "allowed")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await storedPolicy(courseId)).toBe("unknown");
  });
});

describe("AiPolicyCard", () => {
  const html = (policy: AiPolicy) =>
    renderToStaticMarkup(
      <AiPolicyCard
        courseName="Sample Course"
        policy={policy}
        setPolicy={async (p) => ({ ok: true, policy: p })}
      />,
    );

  it("asks while the answer is unknown, with the four buttons and the unknown line, never 'does not allow'", () => {
    const out = html("unknown");
    expect(out).toContain("Does Sample Course allow AI help on homework?");
    expect(out).toContain("Check the syllabus.");
    for (const label of ["Yes", "Only to explain", "No", "Not sure"]) expect(out).toContain(`>${label}<`);
    expect(out).toContain("We don&#x27;t know this course&#x27;s rule on AI help yet. Hand-in works as usual.");
    expect(out).toContain('data-testid="ai-policy-unknown"');
    expect(out).not.toContain(AI_OFF_LINE);
    expect(out).not.toContain(EXPLAIN_ONLY_LINE);
    expect(out).not.toContain("does not allow");
    // While the question is open there is nothing to change yet.
    expect(out).not.toContain("Change answer");
  });

  it("the lines read exactly as the ticket gives them", () => {
    expect(AI_OFF_LINE).toBe("This course does not allow AI help on assignments. Hand-in works as usual.");
    expect(AI_UNKNOWN_LINE).toBe("We don't know this course's rule on AI help yet. Hand-in works as usual.");
    expect(EXPLAIN_ONLY_LINE).toBe("Explain-only: this course does not allow AI-written homework.");
  });

  it("one line per state, and 'does not allow AI help' only for an answered No", () => {
    expect(policyLine("unknown")).toBe(AI_UNKNOWN_LINE);
    expect(policyLine("off")).toBe(AI_OFF_LINE);
    expect(policyLine("explain")).toBe(EXPLAIN_ONLY_LINE);
    expect(policyLine("allowed")).toBeNull();
    for (const p of ["unknown", "explain", "allowed"] as const) {
      expect(policyLine(p) ?? "").not.toContain("does not allow AI help");
    }
  });

  it("the chat endpoint's 403 reads true for off and unknown alike", () => {
    expect(chatProblem(new Error(JSON.stringify({ error: "ai_off_for_assignments" })))).toBe(AI_CHAT_OFF_LINE);
    expect(AI_CHAT_OFF_LINE).toBe("AI help is off for this course's assignments. Hand-in works as usual.");
    expect(AI_CHAT_OFF_LINE).not.toContain("does not allow");
  });

  it("shows the off line with a way to change the answer for off, and does not ask again", () => {
    const out = html("off");
    expect(out).toContain(AI_OFF_LINE);
    expect(out).toContain('data-testid="ai-policy-off"');
    expect(out).not.toContain("rule on AI help yet");
    expect(out).toContain("Change answer");
    expect(out).not.toContain(EXPLAIN_ONLY_LINE);
    expect(out).not.toContain("allow AI help on homework?");
  });

  it("shows the explain-only line with a way to change it for explain", () => {
    const out = html("explain");
    expect(out).toContain(EXPLAIN_ONLY_LINE);
    expect(out).toContain("Change answer");
    expect(out).not.toContain(AI_OFF_LINE);
    expect(out).not.toContain("rule on AI help yet");
    expect(out).not.toContain("does not allow AI help");
    expect(out).not.toContain("allow AI help on homework?");
  });

  it("shows nothing for allowed", () => {
    const out = html("allowed");
    expect(out).toBe("");
  });

  it("the page shows no chat for off and unknown; explain-only is its own state", () => {
    expect(chatHidden("unknown")).toBe(true);
    expect(chatHidden("off")).toBe(true);
    expect(chatHidden("explain")).toBe(false);
    expect(chatHidden("allowed")).toBe(false);

    expect(isExplainOnly("explain")).toBe(true);
    expect(isExplainOnly("unknown")).toBe(false);
    expect(isExplainOnly("off")).toBe(false);
    expect(isExplainOnly("allowed")).toBe(false);
  });

  it("each button stores its value in ai_assignments", () => {
    expect(ANSWER_POLICY).toEqual({ yes: "allowed", explain: "explain", no: "off", not_sure: "unknown" });
  });
});
