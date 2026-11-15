/**
 * Whole-flow check (M9-20): read, note, cards.
 *
 * Demo account; open Strategic IT Management from the sidebar (the Courses
 * tab on a phone, which has no sidebar); open the current lecture
 * (Sourcing and vendors, from the demo lectures fixture); scroll to the end
 * and see the read mark; write a two-line note; "Turn into cards", "Add 2
 * cards" and the toast; back on the path the next stop says "You are here";
 * the note is on the Notes tab.
 *
 * Cut: no selection-by-touch test.
 * Runs on the phone and laptop projects; see handin.spec.ts for the setup.
 */
import { expect, test, type Page } from "@playwright/test";
import lectures from "../fixtures/study/demo-lectures.json";

const COURSE = "Strategic IT Management";
const sit = lectures.courses.find((c) => c.name === COURSE)!;
const current = sit.lectures.find((l) => l.state === "cur")!;
const next = sit.lectures.find((l) => l.n === current.n + 1)!;

const NOTE_LINES = ["Lock-in: switching costs", "SLA - what is promised"];

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "READY_FAST", value: "1", url: baseURL! }]);
});

/** The nav on screen: the sidebar's from 700 px, else the tab bar's. */
const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" }).filter({ visible: true });

async function openCourse(page: Page) {
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  if (await sidebar.isVisible()) {
    await sidebar.getByRole("list", { name: "COURSES" }).getByRole("link", { name: new RegExp(`^${COURSE}`) }).click();
  } else {
    await mainNav(page).getByRole("link", { name: /^Courses/ }).click();
    await expect(page).toHaveURL(/\/courses$/);
    await page.getByRole("main").getByRole("link", { name: new RegExp(COURSE) }).click();
  }
  await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/);
}

/** A path stop's button, by its spoken name ("Lecture 5, Sourcing and vendors, you are here"). */
const stop = (page: Page, n: number, title: string, words = "") =>
  page.getByRole("button", { name: `Lecture ${n}, ${title}${words}`, exact: true });

test("read a lecture, note it, turn the note into cards", async ({ page }) => {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);

  // The course, then its current lecture.
  await openCourse(page);
  await stop(page, current.n, current.title, ", you are here").click();
  await expect(page).toHaveURL(new RegExp(`/lectures/${current.n}$`));
  await expect(page.getByRole("heading", { level: 1, name: current.title })).toBeVisible();

  // Scroll the page area to the end: the read mark.
  const readMark = page.getByText("READ · MARKED ON YOUR PATH");
  await expect(async () => {
    await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(readMark).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // A two-line note on this lecture.
  await page.getByRole("button", { name: "Notepad" }).click();
  const pad = page.getByRole("dialog", { name: "Notepad" });
  await expect(pad).toBeVisible();
  await pad.getByLabel("Note", { exact: true }).fill(NOTE_LINES.join("\n"));
  await expect(pad.getByText("Saved")).toBeVisible();

  // Turn into cards: two drafts, then the toast.
  await pad.getByRole("button", { name: "Turn into cards" }).click();
  await pad.getByRole("button", { name: "Add 2 cards" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Added to ${COURSE}. First review today.` }),
  ).toBeVisible();
  await pad.getByRole("button", { name: "Done" }).click();
  await expect(pad).toHaveCount(0);

  // Back on the path: the lecture is read and the next stop is where she is.
  await page.getByRole("link", { name: `Back to ${COURSE}` }).click();
  await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/);
  await expect(stop(page, next.n, next.title, ", you are here")).toBeVisible();
  await expect(page.getByText("You are here", { exact: true })).toBeVisible();
  // "…, read", then how many of its cards she has seen.
  await expect(page.getByRole("button", { name: new RegExp(`^Lecture ${current.n}, ${current.title}, read`) })).toBeVisible();

  // Notes: the note is there.
  await mainNav(page).getByRole("link", { name: /^Notes/ }).click();
  await expect(page).toHaveURL(/\/notes$/);
  const card = page.getByRole("button").filter({ hasText: NOTE_LINES[0] }).filter({ hasText: NOTE_LINES[1] });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`Lecture ${current.n} · ${current.title}`);
});
