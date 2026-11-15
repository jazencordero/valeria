// @vitest-environment node
/*
 * M9-10. Runs in node because the action writes to a real PGlite test
 * database (src/server/db/client.ts refuses to load where `window` exists).
 * The hook tests install a jsdom window of their own for their block only,
 * after the action (and so the db client) has been imported.
 */
import { eq } from "drizzle-orm";
import type * as RTL from "@testing-library/react";
// @ts-expect-error jsdom ships no types (no @types/jsdom here); only `window` and `close` are used.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { markLectureRead } from "@/app/(app)/courses/[id]/lectures/[n]/actions";
import { courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import type { LectureView } from "./reader";
import { SHORT_PAGE_MS, useReadProgress } from "./use-read-progress";

const h = vi.hoisted(() => ({ db: undefined as unknown, userId: null as string | null }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));

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

// ---------------------------------------------------------------------------
// The hook

describe("useReadProgress", () => {
  let dom: { window: Window & typeof globalThis & { close(): void } };
  let rtl: typeof RTL;
  const added: string[] = [];

  beforeAll(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    const g = globalThis as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (key in g) continue;
      try {
        g[key] = (dom.window as unknown as Record<string, unknown>)[key];
        added.push(key);
      } catch {
        // e.g. localStorage on an opaque origin; the hook needs none of these.
      }
    }
    g.window = dom.window;
    g.document = dom.window.document;
    added.push("window", "document");
    // One frame is 16 ms of (fake) time.
    g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id);
    added.push("requestAnimationFrame", "cancelAnimationFrame");
    g.IS_REACT_ACT_ENVIRONMENT = true;
    rtl = await import("@testing-library/react");
  });

  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of added) delete g[key];
    delete g.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    rtl.cleanup();
    vi.useRealTimers();
  });

  /** A scroll container with a fixed layout: `max` px of scrolling (0: it fits). */
  function column(max: number) {
    const el = document.createElement("main");
    let top = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 800 + max });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    document.body.append(el);
    const scrollTo = (fraction: number) =>
      rtl.act(() => {
        el.scrollTop = fraction * max;
        el.dispatchEvent(new window.Event("scroll"));
        vi.advanceTimersByTime(20);
      });
    return { ref: { current: el }, scrollTo };
  }

  function mount(ref: { current: HTMLElement }, view: LectureView, enabled = true) {
    const onRead = vi.fn();
    const hook = rtl.renderHook((p: { view: LectureView; enabled: boolean }) => useReadProgress({ ref, onRead, ...p }), {
      initialProps: { view, enabled },
    });
    return { onRead, hook };
  }

  const wait = (ms: number) =>
    rtl.act(() => {
      vi.advanceTimersByTime(ms);
    });

  it("fires once at 97%, not at 96%, and never again for the same mount", () => {
    const { ref, scrollTo } = column(1000);
    const { onRead, hook } = mount(ref, "read");
    expect(hook.result.current).toBe(0);

    scrollTo(0.5);
    expect(hook.result.current).toBeCloseTo(0.5);
    scrollTo(0.96);
    expect(onRead).not.toHaveBeenCalled();
    scrollTo(0.97);
    expect(onRead).toHaveBeenCalledTimes(1);

    scrollTo(0.2);
    scrollTo(1);
    hook.rerender({ view: "slides", enabled: true });
    hook.rerender({ view: "read", enabled: true });
    scrollTo(0.5);
    scrollTo(1);
    expect(hook.result.current).toBe(1);
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it("fires after 2.5 s on a page that does not scroll, once", () => {
    const { ref } = column(0);
    const { onRead, hook } = mount(ref, "read");
    expect(hook.result.current).toBe(1);
    wait(SHORT_PAGE_MS - 1);
    expect(onRead).not.toHaveBeenCalled();
    wait(1);
    expect(onRead).toHaveBeenCalledTimes(1);
    wait(10_000);
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it.each<LectureView>(["slides", "notes"])("never fires in the %s view", (view) => {
    const long = column(1000);
    const a = mount(long.ref, view);
    long.scrollTo(1);
    expect(a.hook.result.current).toBe(1);

    const short = column(0);
    const b = mount(short.ref, view);
    wait(10_000);

    expect(a.onRead).not.toHaveBeenCalled();
    expect(b.onRead).not.toHaveBeenCalled();
  });

  it("switching away from Read cancels the wait; coming back starts it over", () => {
    const { ref } = column(0);
    const { onRead, hook } = mount(ref, "read");
    wait(2000);
    hook.rerender({ view: "notes", enabled: true });
    wait(10_000);
    expect(onRead).not.toHaveBeenCalled();

    hook.rerender({ view: "read", enabled: true });
    wait(SHORT_PAGE_MS - 1);
    expect(onRead).not.toHaveBeenCalled();
    wait(1);
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it("never fires when not enabled", () => {
    const long = column(1000);
    const a = mount(long.ref, "read", false);
    long.scrollTo(1);
    const short = column(0);
    const b = mount(short.ref, "read", false);
    wait(10_000);
    expect(a.onRead).not.toHaveBeenCalled();
    expect(b.onRead).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The action

describe("markLectureRead", () => {
  let t: TestDb;
  let her: string;
  let other: string;
  let course: string;
  /** Her lecture ids by number. */
  let L: Record<number, string>;
  let theirs: string;

  beforeEach(async () => {
    t = await createTestDb();
    h.db = t.db;
    h.userId = null;
    [{ id: her }, { id: other }] = await t.db.insert(users).values([{}, {}]).returning();
    [{ id: course }] = await t.db
      .insert(courses)
      .values({ userId: her, moodleId: 3101, name: "Sample Course" })
      .returning();
    const rows = await t.db
      .insert(lectures)
      .values([1, 2, 3].map((n) => ({ userId: her, courseId: course, n, title: `Topic ${n}` })))
      .returning();
    L = Object.fromEntries(rows.map((r) => [r.n, r.id]));
    const [theirCourse] = await t.db
      .insert(courses)
      .values({ userId: other, moodleId: 3101, name: "Their course" })
      .returning();
    [{ id: theirs }] = await t.db
      .insert(lectures)
      .values({ userId: other, courseId: theirCourse.id, n: 1, title: "Theirs" })
      .returning();
  });

  afterEach(async () => {
    await t.close();
  });

  it("marks the current lecture read and moves the current stop", async () => {
    h.userId = her;
    const r = await markLectureRead(L[1]);
    expect(r).toMatchObject({
      ok: true,
      courseId: course,
      lectureId: L[1],
      current: { lectureId: L[2], n: 2 },
      advanced: { from: 1, to: 2 },
    });
    const [row] = await t.db.select().from(lectures).where(eq(lectures.id, L[1]));
    expect(row.readAt).toBeInstanceOf(Date);
  });

  it("is idempotent: marking twice does not advance twice or move the first time", async () => {
    h.userId = her;
    const first = await markLectureRead(L[1]);
    const again = await markLectureRead(L[1]);
    expect(again).toMatchObject({ ok: true, current: { n: 2 }, advanced: null });
    if (!first.ok || !again.ok) throw new Error("expected ok");
    expect(again.readAt.getTime()).toBe(first.readAt.getTime());
  });

  it("reading a later lecture keeps the current stop; reading the last unread one leaves none", async () => {
    h.userId = her;
    expect(await markLectureRead(L[3])).toMatchObject({ ok: true, current: { n: 1 }, advanced: null });
    await markLectureRead(L[1]);
    expect(await markLectureRead(L[2])).toMatchObject({ ok: true, current: null, advanced: { from: 2, to: null } });
  });

  it("another user's lecture, or one that does not exist, is not_found and stays unread", async () => {
    h.userId = her;
    expect(await markLectureRead(theirs)).toEqual({ ok: false, reason: "not_found" });
    expect(await markLectureRead("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, reason: "not_found" });
    const [row] = await t.db.select().from(lectures).where(eq(lectures.id, theirs));
    expect(row.readAt).toBeNull();
  });

  it("checks its input and the session", async () => {
    h.userId = her;
    expect(await markLectureRead("not-a-uuid")).toEqual({ ok: false, reason: "invalid" });
    expect(await markLectureRead(42)).toEqual({ ok: false, reason: "invalid" });
    h.userId = null;
    expect(await markLectureRead(L[1])).toEqual({ ok: false, reason: "signed_out" });
  });
});
