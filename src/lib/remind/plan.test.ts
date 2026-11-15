import { describe, expect, it } from "vitest";
import { grade, newCard } from "@/lib/study/memory";
import {
  dayBeforeAt,
  dueReminders,
  isQuiet,
  nudge,
  nudgeText,
  type NudgeExam,
  type RemindItem,
  type SentEntry,
} from "./plan";

// Helsinki is UTC+2 in winter (EET) and UTC+3 in summer (EEST).
// 2026-11-15 is winter: 18:00 Helsinki = 16:00Z.
const at = (iso: string) => new Date(iso);

const deadline = (over: Partial<RemindItem> = {}): RemindItem => ({
  id: "a1",
  kind: "deadline",
  title: "Exercise 3",
  course: "MS-E2177",
  at: at("2026-11-16T21:59:00Z"), // Mon 16 Nov 23:59 Helsinki
  ...over,
});

describe("dueReminders: the day before", () => {
  it("sends at 18:00 Helsinki the day before, within the hour", () => {
    const due = dueReminders([deadline()], at("2026-11-15T16:07:00Z"), []);
    expect(due).toEqual([
      {
        ref: "a1",
        kind: "day_before",
        at: at("2026-11-15T16:00:00Z"),
        title: "Exercise 3",
        body: "MS-E2177 · Due tomorrow at 23:59.",
        url: "/calendar",
      },
    ]);
  });

  it("does not send before 18:00, nor more than an hour after", () => {
    expect(dueReminders([deadline()], at("2026-11-15T15:59:00Z"), [])).toEqual([]);
    expect(dueReminders([deadline()], at("2026-11-15T17:00:00Z"), [])).toEqual([]);
  });

  it("uses Helsinki time on DST days (spring forward and fall back)", () => {
    // DST starts Sun 29 Mar 2026 at 03:00: 18:00 that day is EEST, 15:00Z.
    expect(dayBeforeAt(at("2026-03-30T07:00:00Z"))).toEqual(at("2026-03-29T15:00:00Z"));
    // The day before the change is still EET: 18:00 is 16:00Z.
    expect(dayBeforeAt(at("2026-03-29T12:00:00Z"))).toEqual(at("2026-03-28T16:00:00Z"));
    // DST ends Sun 25 Oct 2026 at 04:00: 18:00 that day is EET, 16:00Z.
    expect(dayBeforeAt(at("2026-10-26T08:00:00Z"))).toEqual(at("2026-10-25T16:00:00Z"));
    // An item just after Helsinki midnight belongs to that Helsinki day, not the UTC one.
    expect(dayBeforeAt(at("2026-10-25T22:30:00Z"))).toEqual(at("2026-10-25T16:00:00Z")); // Mon 00:30
    expect(dayBeforeAt(at("2026-10-25T21:30:00Z"))).toEqual(at("2026-10-24T15:00:00Z")); // Sun 23:30

    const exam: RemindItem = { id: "e1", kind: "exam", title: "Midterm", course: "", at: at("2026-03-30T07:00:00Z") };
    expect(dueReminders([exam], at("2026-03-29T15:10:00Z"), []).map((r) => [r.kind, r.body])).toEqual([
      ["day_before", "Starts tomorrow at 10:00."],
    ]);
    expect(dueReminders([exam], at("2026-03-29T16:10:00Z"), [])).toEqual([]);
  });
});

describe("dueReminders: 3 hours before", () => {
  it("sends 3 h before, with the time left, within the hour", () => {
    // 22:00 Helsinki (20:00Z) - 3 h = 19:00 Helsinki = 17:00Z.
    const ten = deadline({ at: at("2026-11-16T20:00:00Z") });
    expect(dueReminders([ten], at("2026-11-16T17:07:00Z"), []).map((r) => [r.kind, r.at, r.body])).toEqual([
      ["3h", at("2026-11-16T17:00:00Z"), "MS-E2177 · Due at 22:00 · 2 h 53 min left."],
    ]);
    expect(dueReminders([ten], at("2026-11-16T16:59:00Z"), [])).toEqual([]);
    expect(dueReminders([ten], at("2026-11-16T18:00:00Z"), [])).toEqual([]);
  });

  it("moves a 20:xx reminder to 20:00, so a 23:59 deadline is still told before quiet hours", () => {
    // 23:59 Helsinki - 3 h = 20:59, which the hourly run would only reach after 21:00.
    const due = dueReminders([deadline()], at("2026-11-16T18:07:00Z"), []);
    expect(due.map((r) => [r.kind, r.at, r.body])).toEqual([
      ["3h", at("2026-11-16T18:00:00Z"), "MS-E2177 · Due at 23:59 · 3 h 52 min left."],
    ]);
  });

  it("drops a 3 h reminder that falls in quiet hours (the day-before one covers it)", () => {
    // 09:00 Helsinki deadline: 3 h before is 06:00, quiet.
    const morning = deadline({ at: at("2026-11-17T07:00:00Z") });
    for (let h = 0; h < 48; h++) {
      const now = new Date(at("2026-11-16T00:00:00Z").getTime() + h * 3_600_000 + 5 * 60_000);
      for (const r of dueReminders([morning], now, [])) expect(r.kind).toBe("day_before");
    }
  });
});

describe("dueReminders: never for a handed-in item, never twice, never in quiet hours", () => {
  it("sends nothing for a handed-in item", () => {
    expect(dueReminders([deadline({ done: true })], at("2026-11-15T16:07:00Z"), [])).toEqual([]);
    expect(dueReminders([deadline({ done: true })], at("2026-11-16T18:07:00Z"), [])).toEqual([]);
  });

  it("sends nothing for an item whose time has passed", () => {
    const past = deadline({ at: at("2026-11-15T16:30:00Z") });
    expect(dueReminders([past], at("2026-11-15T16:40:00Z"), [])).toEqual([]);
  });

  it("never sends the same reminder twice", () => {
    const now = at("2026-11-15T16:07:00Z");
    const first = dueReminders([deadline()], now, []);
    expect(first).toHaveLength(1);
    const log: SentEntry[] = first.map((r) => ({ ref: r.ref, kind: r.kind }));
    expect(dueReminders([deadline()], now, log)).toEqual([]);
    expect(dueReminders([deadline()], at("2026-11-15T16:45:00Z"), log)).toEqual([]);
    // The other kind for the same item is still its own reminder.
    expect(dueReminders([deadline()], at("2026-11-16T18:07:00Z"), log).map((r) => r.kind)).toEqual(["3h"]);
    // Every hour of two days, replaying the log: each kind at most once.
    const sent: SentEntry[] = [];
    for (let h = 0; h < 72; h++) {
      const t = new Date(at("2026-11-14T00:00:00Z").getTime() + h * 3_600_000 + 7 * 60_000);
      for (const r of dueReminders([deadline()], t, sent)) sent.push({ ref: r.ref, kind: r.kind });
    }
    expect(sent).toEqual([
      { ref: "a1", kind: "day_before" },
      { ref: "a1", kind: "3h" },
    ]);
  });

  it("sends nothing between 21:00 and 08:00 Helsinki", () => {
    // 23:30 Helsinki deadline: its 3 h reminder is at 20:00; past 21:00 it is not sent.
    const late = deadline({ at: at("2026-11-16T21:30:00Z") });
    expect(dueReminders([late], at("2026-11-16T18:40:00Z"), []).map((r) => r.kind)).toEqual(["3h"]);
    expect(dueReminders([late], at("2026-11-16T19:20:00Z"), [])).toEqual([]);
    expect(isQuiet(at("2026-11-16T19:00:00Z"))).toBe(true); // 21:00
    expect(isQuiet(at("2026-11-16T05:59:00Z"))).toBe(true); // 07:59
    expect(isQuiet(at("2026-11-16T06:00:00Z"))).toBe(false); // 08:00
    expect(isQuiet(at("2026-11-16T18:59:00Z"))).toBe(false); // 20:59
    // Over a week of items at every hour, nothing is ever sent in quiet hours.
    const items: RemindItem[] = Array.from({ length: 24 }, (_, i) =>
      deadline({ id: `d${i}`, at: new Date(at("2026-11-18T00:00:00Z").getTime() + i * 3_600_000) }),
    );
    for (let m = 0; m < 7 * 24 * 4; m++) {
      const now = new Date(at("2026-11-15T00:00:00Z").getTime() + m * 15 * 60_000);
      if (dueReminders(items, now, []).length > 0) expect(isQuiet(now)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The nudge

const T0 = at("2026-11-10T10:00:00Z");
/** A card she graded once at T0; due again soon after. */
const graded = (dueAt: Date) => ({ fsrs: { ...grade(newCard(T0), 3, T0), dueAt: dueAt.getTime() }, dueAt });

function examOf(slipping: number, fresh = 0, over: Partial<NudgeExam["exam"]> = {}): NudgeExam {
  return {
    exam: { id: "x1", title: "Forecasting exam", at: at("2026-12-01T08:00:00Z"), ...over },
    concepts: [
      { id: "c1", name: "Holt-Winters", },
      { id: "c2", name: "ARIMA" },
    ],
    cards: [
      ...Array.from({ length: slipping }, () => ({ conceptIds: ["c1"], memory: graded(at("2026-11-14T10:00:00Z")) })),
      ...Array.from({ length: fresh }, () => ({ conceptIds: ["c2"], memory: null })),
    ],
  };
}

// 17:00 Helsinki on 15 Nov is 15:00Z.
const FIVE_PM = at("2026-11-15T15:05:00Z");

describe("nudge", () => {
  it("names the concept and the minutes", () => {
    expect(nudge([examOf(3, 4)], FIVE_PM, false)).toEqual({
      ref: "2026-11-15",
      kind: "nudge",
      at: at("2026-11-15T15:00:00Z"),
      title: "Forecasting exam",
      body: "3 Holt-Winters cards are slipping. 2 minutes.",
      url: "/exams",
    });
  });

  it("says card is for one card, and grows the minutes with the count", () => {
    expect(nudgeText("Holt-Winters", 1)).toBe("1 Holt-Winters card is slipping. 2 minutes.");
    expect(nudgeText("Holt-Winters", 3)).toBe("3 Holt-Winters cards are slipping. 2 minutes.");
    expect(nudgeText("ARIMA", 10)).toBe("10 ARIMA cards are slipping. 6 minutes.");
    expect(nudge([examOf(1)], FIVE_PM, false)?.body).toBe("1 Holt-Winters card is slipping. 2 minutes.");
  });

  it("sends at most one a day", () => {
    expect(nudge([examOf(3)], FIVE_PM, true)).toBeNull();
    // The same day keeps the same ref, which reminder_log holds once.
    expect(nudge([examOf(3)], at("2026-11-15T15:55:00Z"), false)?.ref).toBe("2026-11-15");
    expect(nudge([examOf(3)], at("2026-11-16T15:05:00Z"), false)?.ref).toBe("2026-11-16");
  });

  it("only at 17:00, and never in quiet hours", () => {
    expect(nudge([examOf(3)], at("2026-11-15T14:59:00Z"), false)).toBeNull(); // 16:59
    expect(nudge([examOf(3)], at("2026-11-15T16:00:00Z"), false)).toBeNull(); // 18:00
    for (let h = 0; h < 24; h++) {
      const now = new Date(at("2026-11-15T00:00:00Z").getTime() + h * 3_600_000 + 5 * 60_000);
      const n = nudge([examOf(3)], now, false);
      if (h === 15) expect(n).not.toBeNull();
      else expect(n).toBeNull();
      if (n) expect(isQuiet(now)).toBe(false);
    }
  });

  it("stays quiet when nothing is slipping", () => {
    expect(nudge([examOf(0, 5)], FIVE_PM, false)).toBeNull(); // only new cards
    expect(nudge([], FIVE_PM, false)).toBeNull();
    // Graded just before, due later, recall still high: not slipping.
    const fresh = grade(newCard(at("2026-11-15T14:50:00Z")), 3, at("2026-11-15T14:50:00Z"));
    const ok: NudgeExam = {
      ...examOf(0),
      cards: [{ conceptIds: ["c1"], memory: { fsrs: { ...fresh, dueAt: at("2026-11-20T00:00:00Z").getTime() }, dueAt: at("2026-11-20T00:00:00Z") } }],
    };
    expect(nudge([ok], FIVE_PM, false)).toBeNull();
    // An exam that has started does not count.
    expect(nudge([examOf(3, 0, { at: at("2026-11-15T10:00:00Z") })], FIVE_PM, false)).toBeNull();
  });

  it("never says we miss you", () => {
    for (const n of [1, 2, 5, 12]) expect(nudgeText("X", n).toLowerCase()).not.toContain("miss");
  });

  it("picks the concept with the most slipping cards, ties to the sooner exam", () => {
    const later = examOf(2, 0, { id: "x2", title: "Later exam", at: at("2026-12-20T08:00:00Z") });
    const sooner = examOf(2, 0, { id: "x1", title: "Sooner exam" });
    expect(nudge([later, sooner], FIVE_PM, false)?.title).toBe("Sooner exam");
    const bigger = examOf(4, 0, { id: "x2", title: "Later exam", at: at("2026-12-20T08:00:00Z") });
    expect(nudge([sooner, bigger], FIVE_PM, false)?.body).toBe("4 Holt-Winters cards are slipping. 2 minutes.");
  });
});
