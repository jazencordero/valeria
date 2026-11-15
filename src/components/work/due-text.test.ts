// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }) }));
vi.mock("@/app/(app)/assignments/[id]/actions", () => ({ confirmHandinAction: vi.fn(), prepareHandinAction: vi.fn() }));

const { dueText, receiptText } = await import("./workspace");

// Sunday 15 November 2026, 13:05 in Helsinki.
const NOW = new Date("2026-11-15T11:05:00Z");
const at = (iso: string) => new Date(iso);

describe("dueText (the assignment page's header line)", () => {
  it("names the month once the day is more than six days away", () => {
    expect(dueText(at("2026-12-06T18:00:00Z"), null, NOW)).toBe("Due SUN 6 DEC · 20:00 · 21 days left");
    expect(dueText(at("2026-11-23T19:00:00Z"), null, NOW)).toBe("Due MON 23 NOV · 21:00 · 8 days left");
  });

  it("keeps the short form within the week, and the time alone today", () => {
    expect(dueText(at("2026-11-18T19:00:00Z"), null, NOW)).toBe("Due WED 18 · 21:00 · 3 days left");
    expect(dueText(at("2026-11-21T19:00:00Z"), null, NOW)).toBe("Due SAT 21 · 21:00 · 6 days left");
    expect(dueText(at("2026-11-15T21:59:00Z"), null, NOW)).toBe("Due 23:59 · 10 h 54 min left");
  });

  it("does the same for a past due date and for the hand-in time", () => {
    expect(dueText(at("2026-11-01T21:59:00Z"), null, NOW)).toBe("Due SUN 1 NOV · 23:59 · late by 13 days");
    expect(dueText(at("2026-12-06T18:00:00Z"), at("2026-11-03T13:52:00Z"), NOW)).toBe("Handed in TUE 3 NOV · 15:52");
    expect(dueText(at("2026-12-06T18:00:00Z"), at("2026-11-12T13:52:00Z"), NOW)).toBe("Handed in THU 12 · 15:52");
    expect(dueText(null, null, NOW)).toBe("No due date");
  });

  it("the receipt line follows the same rule", () => {
    expect(receiptText("Moodle", at("2026-11-15T09:00:00Z"), NOW)).toBe("Handed in to Moodle at 11:00.");
    expect(receiptText("Moodle", at("2026-10-30T09:00:00Z"), NOW)).toBe("Handed in to Moodle at FRI 30 OCT · 11:00.");
  });
});
