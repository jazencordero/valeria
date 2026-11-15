import { describe, expect, it } from "vitest";
import { buildQueue } from "../queue";
import { greeting, type GreetingAssignment, type GreetingInput } from "./greeting";

const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;

// Saturday 14 November 2026, 15:48 in Helsinki (UTC+2).
const NOW = d("2026-11-14T13:48:00Z");

const TONIGHT = d("2026-11-14T21:59:00Z"); // Sat 23:59
const TODAY_4PM = d("2026-11-14T14:00:00Z"); // Sat 16:00
const TOMORROW = d("2026-11-15T21:59:00Z"); // Sun 23:59
const YESTERDAY = d("2026-11-13T21:59:00Z"); // Fri 13, 23:59
const TUESDAY = d("2026-11-17T21:59:00Z"); // Tue 17, 23:59
const THURSDAY = d("2026-11-19T21:59:00Z"); // Thu 19, 23:59
const FRIDAY_EXAM = d("2026-11-20T07:00:00Z"); // Fri 20, 09:00
const NEXT_TUESDAY = d("2026-11-24T21:59:00Z"); // Tue 24, 10 days out

function a(id: string, title: string, due_at: Date | null, submitted_at: Date | null = null): GreetingAssignment {
  return {
    id,
    title,
    due_at,
    submitted_at,
    first_seen_at: d("2026-10-01T00:00:00Z"),
    seen_at: null,
    from_first_sync: false,
  };
}

function say(list: GreetingAssignment[], over: Partial<GreetingInput> = {}): string {
  return greeting({ firstName: "Aino", queue: buildQueue(list, NOW), now: NOW, ...over });
}

describe("greeting: the six cases", () => {
  it("just handed in: timing, next task and the exam bite", () => {
    const out = say([a("memo", "memo", TUESDAY), a("done", "Essay", d("2026-11-14T18:48:00Z"), NOW)], {
      justHandedIn: { title: "Essay", submittedAt: NOW, dueAt: d("2026-11-14T18:56:00Z") },
      nextExam: { at: FRIDAY_EXAM },
    });
    expect(out).toBe("Handed in, 5 hours early. Next up is Tuesday's memo, or a 5-minute bite for Friday's exam.");
  });

  it("just studied: the exam forecast", () => {
    expect(say([a("memo", "memo", TONIGHT)], { justStudied: { forecast: 67.6, examAt: FRIDAY_EXAM } })).toBe(
      "Nice. Friday's exam forecast is up to 68%.",
    );
  });

  it("something due today: count, tonight, and clear until", () => {
    expect(say([a("x", "Quiz", TONIGHT), a("memo", "memo", TUESDAY)])).toBe(
      "Hi Aino. Quiz is due tonight, then you are clear until Tuesday.",
    );
  });

  it("nothing due for 2 or more days", () => {
    expect(say([a("x", "Quiz", THURSDAY)])).toBe("Hi Aino. Nothing is due before Thursday. A good day for a bite.");
  });

  it("something late", () => {
    expect(say([a("m2", "Case memo 2", YESTERDAY), a("memo", "memo", TUESDAY)])).toBe(
      "Hi Aino. Case memo 2 was due yesterday. Start there.",
    );
  });

  it("nothing at all", () => {
    expect(say([])).toBe("Hi Aino. Nothing open. Enjoy it.");
  });
});

describe("greeting: counts", () => {
  it("one thing due tonight is named", () => {
    expect(say([a("x", "Quiz", TONIGHT)])).toBe("Hi Aino. Quiz is due tonight, then you are clear.");
  });

  it("plural: Two things are", () => {
    expect(say([a("x", "Quiz", TONIGHT), a("y", "Lab", TONIGHT), a("z", "memo", TUESDAY)])).toBe(
      "Hi Aino. Two things are due tonight, then you are clear until Tuesday.",
    );
  });

  it("11 and up in digits", () => {
    const many = Array.from({ length: 11 }, (_, i) => a(`t${i}`, `Task ${i}`, TONIGHT));
    expect(say(many)).toBe("Hi Aino. 11 things are due tonight, then you are clear.");
  });
});

describe("greeting: priority", () => {
  it("handed in beats just studied", () => {
    const out = say([], {
      justHandedIn: { title: "Essay", submittedAt: NOW, dueAt: d("2026-11-16T13:48:00Z") },
      justStudied: { forecast: 70, examAt: FRIDAY_EXAM },
    });
    expect(out).toBe("Handed in, 2 days early. Nothing else is open.");
  });

  it("just studied beats something late", () => {
    expect(say([a("m2", "Case memo 2", YESTERDAY)], { justStudied: { forecast: 50, examAt: FRIDAY_EXAM } })).toBe(
      "Nice. Friday's exam forecast is up to 50%.",
    );
  });

  it("late beats due today", () => {
    expect(say([a("m2", "Case memo 2", YESTERDAY), a("x", "Quiz", TONIGHT)])).toBe(
      "Hi Aino. Case memo 2 was due yesterday. Start there.",
    );
  });

  it("late beats nothing due for 2+ days", () => {
    expect(say([a("m2", "Case memo 2", YESTERDAY), a("x", "Quiz", THURSDAY)])).toBe(
      "Hi Aino. Case memo 2 was due yesterday. Start there.",
    );
  });
});

describe("greeting: edges", () => {
  it("no first name says Hi there", () => {
    expect(say([], { firstName: undefined })).toBe("Hi there. Nothing open. Enjoy it.");
    expect(say([], { firstName: "  " })).toBe("Hi there. Nothing open. Enjoy it.");
  });

  it("due today before 17:00 says today, not tonight", () => {
    expect(say([a("x", "Quiz", TODAY_4PM)])).toBe("Hi Aino. Quiz is due today, then you are clear.");
  });

  it("due tomorrow uses the same pattern", () => {
    expect(say([a("x", "Quiz", TOMORROW), a("memo", "memo", TUESDAY)])).toBe(
      "Hi Aino. Quiz is due tomorrow, then you are clear until Tuesday.",
    );
  });

  it("7+ days out adds the date", () => {
    expect(say([a("x", "Quiz", NEXT_TUESDAY)])).toBe(
      "Hi Aino. Nothing is due before Tuesday 24 Nov. A good day for a bite.",
    );
  });

  it("late by several days names the weekday", () => {
    expect(say([a("m2", "Case memo 2", d("2026-11-10T21:59:00Z"))])).toBe(
      "Hi Aino. Case memo 2 was due on Tuesday. Start there.",
    );
  });

  it("open items without due dates", () => {
    expect(say([a("x", "Reading", null)])).toBe("Hi Aino. Nothing has a due date. A good day for a bite.");
  });

  it("handed in late, one hour, no exam, next task far out uses the title alone", () => {
    const out = say([a("x", "Quiz", NEXT_TUESDAY)], {
      justHandedIn: { title: "Essay", submittedAt: NOW, dueAt: new Date(NOW.getTime() - 1.5 * HOUR) },
    });
    expect(out).toBe("Handed in, 1 hour late. Next up is Quiz.");
  });

  it("handed in on time, exam only", () => {
    const out = say([], {
      justHandedIn: { title: "Essay", submittedAt: NOW, dueAt: NOW },
      nextExam: { at: FRIDAY_EXAM },
    });
    expect(out).toBe("Handed in, on time. Next up is a 5-minute bite for Friday's exam.");
  });

  it("just studied for a far exam uses its title", () => {
    expect(
      say([], { justStudied: { examTitle: "Strategy exam", forecast: 72, examAt: d("2026-12-10T08:00:00Z") } }),
    ).toBe("Nice. Strategy exam forecast is up to 72%.");
  });
});
