/*
 * The pure weekly summary, plus the usage beacon (`@/components/usage/beacon`).
 * The beacon test lives here because the ticket lists no test file of its
 * own; this file runs in jsdom for it, so the database client (server-only)
 * is mocked out. The database query `usageSummary` is tested in `log.test.ts`.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ db: {} }));

const nav = vi.hoisted(() => ({ pathname: "/home" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { helsinkiDay, isoWeek, median, summarize } = await import("./summary");
const { Beacon } = await import("@/components/usage/beacon");

const open = (iso: string) => ({ kind: "open", at: new Date(iso), ms: null });
const start = (iso: string, ms: number | null = null) => ({ kind: "start", at: new Date(iso), ms });

describe("summarize", () => {
  it("gives days opened and the median open-to-start per ISO week (Helsinki)", () => {
    const log = [
      // Week 46 of 2026: Mon 9 November to Sun 15 November.
      open("2026-11-09T07:00:00Z"),
      start("2026-11-09T07:00:04Z"), // 4 s
      start("2026-11-09T07:05:00Z"), // a second start in the same visit: not counted
      open("2026-11-09T12:00:00Z"), // same day again: still one day
      start("2026-11-09T12:00:30Z", 12_000), // stored ms wins
      { kind: "hand_in", at: new Date("2026-11-09T12:30:00Z"), ms: null },
      open("2026-11-11T18:00:00Z"),
      start("2026-11-11T18:00:08Z"), // 8 s
      open("2026-11-15T21:30:00Z"), // Sunday 23:30 Helsinki: still week 46, no start
      // Sunday 22:30 UTC is Monday 00:30 Helsinki: week 47.
      open("2026-11-15T22:30:00Z"),
      start("2026-11-15T22:30:02Z"),
    ];
    expect(summarize([...log].reverse())).toEqual([
      { week: "2026-W46", weekStart: "2026-11-09", daysOpened: 3, opens: 4, starts: 3, medianStartMs: 8_000 },
      { week: "2026-W47", weekStart: "2026-11-16", daysOpened: 1, opens: 1, starts: 1, medianStartMs: 2_000 },
    ]);
  });

  it("an even number of starts gives the mean of the middle two", () => {
    expect(
      summarize([
        open("2026-11-10T08:00:00Z"),
        start("2026-11-10T08:00:03Z"),
        open("2026-11-10T09:00:00Z"),
        start("2026-11-10T09:00:06Z"),
      ])[0].medianStartMs,
    ).toBe(4_500);
  });

  it("a start before any open counts for nothing; no opens, no weeks", () => {
    expect(summarize([start("2026-11-10T08:00:00Z", 100)])).toEqual([]);
    expect(summarize([])).toEqual([]);
  });
});

describe("date helpers", () => {
  it("uses the Helsinki calendar day", () => {
    expect(helsinkiDay(new Date("2026-11-15T22:30:00Z"))).toBe("2026-11-16");
    expect(helsinkiDay(new Date("2026-07-01T20:59:00Z"))).toBe("2026-07-01"); // summer time, UTC+3
    expect(helsinkiDay(new Date("2026-07-01T21:00:00Z"))).toBe("2026-07-02");
  });

  it("numbers ISO weeks across a year end", () => {
    expect(isoWeek("2026-11-15")).toEqual({ week: "2026-W46", weekStart: "2026-11-09" });
    expect(isoWeek("2027-01-01")).toEqual({ week: "2026-W53", weekStart: "2026-12-28" });
    expect(isoWeek("2025-12-29")).toEqual({ week: "2026-W01", weekStart: "2025-12-29" });
  });

  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe("Beacon", () => {
  afterEach(() => {
    cleanup();
    nav.pathname = "/home";
  });

  it("calls the action once per mount, with the path, and renders nothing", async () => {
    const send = vi.fn(async (path: string) => {
      void path;
    });
    const { container, rerender } = render(createElement(Beacon, { send }));
    rerender(createElement(Beacon, { send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("/home");
    expect(container.innerHTML).toBe("");
  });

  it("sends again when the path changes inside the same template", () => {
    const send = vi.fn(async () => {});
    const { rerender } = render(createElement(Beacon, { send }));
    nav.pathname = "/assignments/a1";
    rerender(createElement(Beacon, { send }));
    expect(send.mock.calls).toEqual([["/home"], ["/assignments/a1"]]);
  });

  it("a failing action does not throw into the page", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    render(createElement(Beacon, { send }));
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
  });
});
