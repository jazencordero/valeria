// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExamOver } from "@/server/study/start-date";

// `redirect` throws in Next; here it throws something the test can read.
class Redirected extends Error {
  constructor(public readonly to: string) {
    super(`redirect ${to}`);
  }
}

const begin = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/server/auth/session", () => ({ currentUser: async () => ({ id: "u1" }), NotSignedIn: class extends Error {} }));
vi.mock("@/server/study/actions", () => ({ beginSession: (...args: unknown[]) => begin.fn(...args) }));
vi.mock("@/server/study/lecture-session", () => ({
  beginLectureSession: async () => null,
  safeReturn: (v: string | null) => (v && v.startsWith("/") && !v.startsWith("//") ? v : null),
}));
vi.mock("@/server/study/store", () => ({ StudyNotFound: class extends Error {} }));

const { GET } = await import("./route");

const EXAM = "11111111-2222-4333-8444-555555555555";

async function go(query: string): Promise<string> {
  const request = { nextUrl: new URL(`http://localhost/study/new?${query}`) } as unknown as Parameters<typeof GET>[0];
  try {
    await GET(request);
  } catch (err) {
    if (err instanceof Redirected) return err.to;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  begin.fn.mockReset();
});

describe("GET /study/new", () => {
  it("starts a session and sends her to it", async () => {
    begin.fn.mockResolvedValue({ sessionId: "s1" });
    expect(await go(`exam=${EXAM}&kind=bite`)).toBe("/study/s1");
    expect(begin.fn).toHaveBeenCalledWith(EXAM, "bite", undefined);
  });

  it("a past exam: no session, and she lands on the exam's page, whatever the kind or the return path", async () => {
    begin.fn.mockRejectedValue(new ExamOver(EXAM));
    for (const query of [
      `exam=${EXAM}&kind=bite`,
      `exam=${EXAM}&kind=extra`,
      `exam=${EXAM}&kind=tile&arg=basic`,
      `exam=${EXAM}&kind=concept&arg=c1`,
      `exam=${EXAM}&kind=bite&return=${encodeURIComponent("/courses/x")}`,
    ]) {
      expect(await go(query)).toBe(`/exams/${EXAM}`);
    }
  });

  it("nothing to study goes back to the exam page or the return path", async () => {
    begin.fn.mockResolvedValue(null);
    expect(await go(`exam=${EXAM}&kind=bite`)).toBe(`/exams/${EXAM}`);
    expect(await go(`exam=${EXAM}&kind=bite&return=${encodeURIComponent("/courses/x")}`)).toBe("/courses/x");
  });
});
