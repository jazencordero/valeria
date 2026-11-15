/**
 * Whole-flow check (M1-39): connect, see, hand in.
 *
 * Runs on the phone and laptop projects against `next dev` with the fake
 * Moodle (MOODLE_FAKE=1), which /demo needs. Every test gets a fresh browser
 * context, so a fresh session cookie and its own demo user; the hand-in test
 * still opens /demo?reset=1 so a reused session starts from the seed too.
 * The READY_FAST cookie makes every animation instant (src/lib/motion/fast.ts).
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SAMPLE_PDF = path.join(__dirname, "..", "fixtures", "files", "sample.pdf");

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "READY_FAST", value: "1", url: baseURL! }]);
});

/** Home's DO FIRST section. */
const doFirst = (page: Page) => page.getByRole("region", { name: "DO FIRST" });

test("hand in Assignment 3 from the demo and see it done", async ({ page }) => {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);

  // Do first is Assignment 3.
  const first = doFirst(page);
  const hero = first.getByRole("article", { name: "Assignment 3" });
  await expect(hero).toBeVisible();

  // Open it.
  await hero.getByRole("link", { name: "Start" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Assignment 3" })).toBeVisible();

  // Attach the PDF and hand it in.
  const handIn = page.getByRole("region", { name: "Hand in" });
  await handIn.locator('input[type="file"]').setInputFiles(SAMPLE_PDF);
  await expect(handIn.getByText("sample.pdf")).toBeVisible();
  await handIn.getByRole("button", { name: "Hand in", exact: true }).click();

  // The review sheet, then her tap on Submit.
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: /^Hand in to / })).toBeVisible();
  await expect(sheet.getByText("sample.pdf")).toBeVisible();
  await sheet.getByRole("button", { name: /^Submit to / }).click();

  // The receipt.
  await expect(sheet.getByRole("heading", { name: "Handed in", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Back to home" }).or(sheet.getByRole("link", { name: "Back to home" })).click();

  // Home: the done row on top, then the next one.
  await expect(page).toHaveURL(/\/home$/);
  await expect(first.getByText("Assignment 3 handed in")).toBeVisible();
  await expect(first.getByRole("article", { name: "Case memo 2" })).toBeVisible();
  await expect(first.getByRole("article", { name: "Assignment 3" })).toHaveCount(0);

  // Assignments: under DONE.
  await page.goto("/assignments");
  const done = page.getByRole("heading", { name: "DONE", exact: true }).locator("xpath=following-sibling::ul[1]");
  await expect(done.getByRole("listitem").filter({ hasText: "Assignment 3 handed in" })).toBeVisible();
});

test("a bad key on /connect shows the error sentence", async ({ page }) => {
  await page.goto("/connect");
  // M5-08: the key field is one step in, under "Paste a key instead".
  await page.getByRole("button", { name: "Paste a key instead" }).click();
  await page.getByLabel("Your key").fill("not-a-real-key");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "did not accept that key. Copy it again." })).toBeVisible();
  await expect(page).toHaveURL(/\/connect$/);
});
