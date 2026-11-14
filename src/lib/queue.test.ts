import { describe, expect, it } from "vitest";
import { buildQueue, clearUntil, isNew, type QueueAssignment } from "./queue";

const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Saturday 14 November 2026, 15:48 in Helsinki (UTC+2).
const NOW = d("2026-11-14T13:48:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function a(id: string, over: Partial<QueueAssignment> = {}): QueueAssignment {
  return {
    id,
    due_at: null,
    submitted_at: null,
    first_seen_at: ago(30 * DAY),
    seen_at: null,
    from_first_sync: false,
    ...over,
  };
}

const ids = (list: QueueAssignment[]) => list.map((x) => x.id);

describe("buildQueue ordering", () => {
  it("puts the earliest due open assignment first and the rest in due order", () => {
    const q = buildQueue(
      [
        a("wed", { due_at: d("2026-11-18T21:59:00Z") }),
        a("mon", { due_at: d("2026-11-16T21:59:00Z") }),
        a("tue", { due_at: d("2026-11-17T21:59:00Z") }),
      ],
      NOW,
    );
    expect(q.first?.id).toBe("mon");
    expect(ids(q.then)).toEqual(["tue", "wed"]);
    expect(q.done).toEqual([]);
  });

  it("puts assignments without a due date last", () => {
    const q = buildQueue(
      [
        a("none-b"),
        a("later", { due_at: d("2026-12-01T10:00:00Z") }),
        a("none-a"),
        a("soon", { due_at: d("2026-11-15T10:00:00Z") }),
      ],
      NOW,
    );
    expect(q.first?.id).toBe("soon");
    expect(ids(q.then)).toEqual(["later", "none-a", "none-b"]);
  });

  it("makes an undated assignment first when nothing else is open", () => {
    const q = buildQueue([a("none")], NOW);
    expect(q.first?.id).toBe("none");
    expect(q.then).toEqual([]);
  });

  it("puts overdue open assignments ahead of upcoming ones", () => {
    const q = buildQueue(
      [a("upcoming", { due_at: d("2026-11-15T10:00:00Z") }), a("overdue", { due_at: ago(2 * HOUR) })],
      NOW,
    );
    expect(q.first?.id).toBe("overdue");
    expect(ids(q.then)).toEqual(["upcoming"]);
  });

  it("breaks ties on the same due time by id, whatever the input order", () => {
    const due = d("2026-11-16T21:59:00Z");
    const q1 = buildQueue([a("b", { due_at: due }), a("a", { due_at: due })], NOW);
    const q2 = buildQueue([a("a", { due_at: due }), a("b", { due_at: due })], NOW);
    expect(q1.first?.id).toBe("a");
    expect(q2.first?.id).toBe("a");
  });

  it("does not change the input array", () => {
    const input = [a("2", { due_at: d("2026-11-17T10:00:00Z") }), a("1", { due_at: d("2026-11-16T10:00:00Z") })];
    buildQueue(input, NOW);
    expect(ids(input)).toEqual(["2", "1"]);
  });
});

describe("buildQueue empty and done", () => {
  it("handles the empty list", () => {
    expect(buildQueue([], NOW)).toEqual({ first: null, then: [], done: [] });
  });

  it("when everything is handed in, nothing is open and recent hand-ins are done", () => {
    const q = buildQueue(
      [
        a("old", { due_at: ago(5 * DAY), submitted_at: ago(6 * DAY) }),
        a("new", { due_at: ago(1 * DAY), submitted_at: ago(1 * HOUR) }),
      ],
      NOW,
    );
    expect(q.first).toBeNull();
    expect(q.then).toEqual([]);
    expect(ids(q.done)).toEqual(["new", "old"]);
  });

  it("keeps only hand-ins from the last 7 days, newest first", () => {
    const q = buildQueue(
      [
        a("six-days", { submitted_at: ago(6 * DAY) }),
        a("exactly-seven", { submitted_at: ago(7 * DAY) }),
        a("eight-days", { submitted_at: ago(8 * DAY) }),
        a("just-over-seven", { submitted_at: ago(7 * DAY + 1) }),
        a("today", { submitted_at: ago(HOUR) }),
        a("open", { due_at: d("2026-11-20T10:00:00Z") }),
      ],
      NOW,
    );
    expect(ids(q.done)).toEqual(["today", "six-days", "exactly-seven"]);
    expect(q.first?.id).toBe("open");
    expect(q.then).toEqual([]);
  });

  it("never puts a handed-in assignment in first or then, even if it is old", () => {
    const q = buildQueue([a("handed-in-long-ago", { due_at: d("2026-11-20T10:00:00Z"), submitted_at: ago(30 * DAY) })], NOW);
    expect(q).toEqual({ first: null, then: [], done: [] });
  });
});

describe("isNew", () => {
  it("is new when first seen recently, never opened and not from the first sync", () => {
    expect(isNew(a("x", { first_seen_at: ago(1 * DAY) }), NOW)).toBe(true);
  });

  it("first sync marks nothing as new", () => {
    const all = [
      a("1", { first_seen_at: NOW, from_first_sync: true }),
      a("2", { first_seen_at: ago(HOUR), from_first_sync: true }),
      a("3", { first_seen_at: ago(2 * DAY), from_first_sync: true, due_at: d("2026-11-16T10:00:00Z") }),
    ];
    expect(all.filter((x) => isNew(x, NOW))).toEqual([]);
  });

  it("an opened assignment is not new", () => {
    expect(isNew(a("x", { first_seen_at: ago(HOUR), seen_at: ago(10 * 60 * 1000) }), NOW)).toBe(false);
  });

  it("stops being new at exactly 3 days", () => {
    expect(isNew(a("x", { first_seen_at: ago(3 * DAY - 1) }), NOW)).toBe(true);
    expect(isNew(a("x", { first_seen_at: ago(3 * DAY) }), NOW)).toBe(false);
    expect(isNew(a("x", { first_seen_at: ago(4 * DAY) }), NOW)).toBe(false);
  });

  it("is new right after a later sync sees it", () => {
    expect(isNew(a("x", { first_seen_at: NOW }), NOW)).toBe(true);
  });
});

describe("clearUntil", () => {
  it("gives the Helsinki weekday of the next deadline after first", () => {
    const q = buildQueue(
      [
        a("first", { due_at: d("2026-11-15T21:59:00Z") }), // Sun 23:59
        a("next", { due_at: d("2026-11-17T21:59:00Z") }), // Tue 23:59
        a("later", { due_at: d("2026-11-19T10:00:00Z") }),
      ],
      NOW,
    );
    expect(clearUntil(q, NOW)).toBe("Tuesday");
  });

  it("uses Helsinki time, not UTC, near midnight", () => {
    // 22:30 UTC Monday is 00:30 Tuesday in Helsinki.
    const q = buildQueue(
      [a("first", { due_at: d("2026-11-15T10:00:00Z") }), a("next", { due_at: d("2026-11-16T22:30:00Z") })],
      NOW,
    );
    expect(clearUntil(q, NOW)).toBe("Tuesday");
  });

  it("is null when nothing follows first", () => {
    expect(clearUntil(buildQueue([a("only", { due_at: d("2026-11-16T10:00:00Z") })], NOW), NOW)).toBeNull();
  });

  it("is null when the queue is empty", () => {
    expect(clearUntil(buildQueue([], NOW), NOW)).toBeNull();
  });

  it("is null when everything after first has no due date", () => {
    const q = buildQueue([a("first", { due_at: d("2026-11-16T10:00:00Z") }), a("undated")], NOW);
    expect(clearUntil(q, NOW)).toBeNull();
  });

  it("skips overdue items after first and names the next future deadline", () => {
    const q = buildQueue(
      [
        a("overdue-1", { due_at: ago(2 * DAY) }),
        a("overdue-2", { due_at: ago(DAY) }),
        a("friday", { due_at: d("2026-11-20T10:00:00Z") }),
      ],
      NOW,
    );
    expect(q.first?.id).toBe("overdue-1");
    expect(clearUntil(q, NOW)).toBe("Friday");
  });

  it("ignores handed-in assignments", () => {
    const q = buildQueue(
      [
        a("first", { due_at: d("2026-11-15T10:00:00Z") }),
        a("handed-in", { due_at: d("2026-11-16T10:00:00Z"), submitted_at: ago(HOUR) }),
        a("thursday", { due_at: d("2026-11-19T10:00:00Z") }),
      ],
      NOW,
    );
    expect(clearUntil(q, NOW)).toBe("Thursday");
  });

  it("names the same weekday when the next deadline is on the day of first", () => {
    const q = buildQueue(
      [a("first", { due_at: d("2026-11-15T08:00:00Z") }), a("same-day", { due_at: d("2026-11-15T20:00:00Z") })],
      NOW,
    );
    expect(clearUntil(q, NOW)).toBe("Sunday");
  });
});
