/**
 * Whole-flow check (M5-12): first run.
 *
 * A brand-new visitor (fresh browser context, so no session cookie and no
 * user row): `/` sends her to Welcome; Get started; pick Aalto; Continue;
 * "Continue with Aalto"; tick the box and upload the sample QR
 * (tests/fixtures/files/sample-qr.png, which the fake Moodle swaps for the
 * demo key, src/server/moodle/fake-inline.ts); the sorting screen with at
 * least one course chip; then Home with a DO FIRST card.
 *
 * The walk to the QR step runs with the READY_FAST cookie (every animation
 * instant, src/lib/motion/fast.ts), as the other whole-flow tests do. Before
 * the upload the switch is turned off and reduced motion emulated
 * (`calmFromHere`), so the sorting scene plays its calm script (at least
 * 6 s, fades only). Instant, it cannot be tested: a quick first sync ends
 * the scene and leaves for Home before Skip can be pressed, and the wipe
 * calls `onDone` without ever showing its line
 * (src/components/first-run/wipe.tsx).
 *
 * Test 1 presses Skip. Test 2 waits for the end: the wipe shows "Here's
 * your study OS, all set up.", then Home.
 *
 * Cut (ticket): no camera test. Runs on the phone and laptop projects; see
 * handin.spec.ts for the setup.
 */
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const SAMPLE_QR = path.join(__dirname, "..", "fixtures", "files", "sample-qr.png");
const LAST_LINE = "Here's your study OS, all set up.";

/** Home's DO FIRST section. */
const doFirst = (page: Page) => page.getByRole("region", { name: "DO FIRST" });

async function fastOn(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: "READY_FAST", value: "1", url: baseURL }]);
}

/** Welcome, school, connect: up to the QR step, ready to upload. */
async function walkToQr(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole("link", { name: "Get started" }).click();

  await expect(page).toHaveURL(/\/school$/);
  // The page is prerendered: a tap before it hydrates does nothing, so tap until it holds.
  const aalto = page.getByRole("radio", { name: /Aalto/ });
  await expect(async () => {
    await aalto.click();
    await expect(aalto).toHaveAttribute("aria-checked", "true", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page).toHaveURL(/\/connect$/);
  const qrHeading = page.getByRole("heading", { name: "Use the QR code" });
  await expect(async () => {
    await page.getByRole("button", { name: "Continue with Aalto" }).click({ timeout: 2_000 });
    await expect(qrHeading).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("checkbox").check();
}

/**
 * Turns READY_FAST off for the rest of the run and emulates reduced motion, so the sorting
 * scene plays its calm script (at least 6 s, fades only). Instant, a fast first sync can end
 * the scene and leave for Home before Skip can be pressed, and the wipe never shows its line.
 */
async function calmFromHere(page: Page, context: BrowserContext) {
  await context.clearCookies({ name: "READY_FAST" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    delete document.documentElement.dataset.fast;
  });
}

async function uploadQr(page: Page) {
  await page.getByLabel("Screenshot of the code").setInputFiles(SAMPLE_QR);
}

/** The sorting screen with at least one course chip. */
async function expectSorting(page: Page) {
  await expect(page).toHaveURL(/\/sorting$/);
  const chips = page.getByRole("list", { name: "Courses so far" }).getByRole("listitem");
  await expect(chips.first()).toBeVisible({ timeout: 30_000 });
}

/** Home, built, with a card under DO FIRST. */
async function expectHomeWithDoFirst(page: Page) {
  await expect(page).toHaveURL(/\/home(\?arrive=1)?$/);
  await expect(doFirst(page).getByRole("article").first()).toBeVisible({ timeout: 30_000 });
}

// A first visit compiles every first-run page on the dev server; give it room.
test.describe.configure({ timeout: 120_000 });

test("first run: welcome to Home through the sample QR, with Skip", async ({ page, context, baseURL }) => {
  await fastOn(context, baseURL!);
  await walkToQr(page);
  await calmFromHere(page, context);
  await uploadQr(page);

  await expectSorting(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();

  await expectHomeWithDoFirst(page);
});

test("first run: the wipe says it is all set up, then Home", async ({ page, context, baseURL }) => {
  await fastOn(context, baseURL!);
  await walkToQr(page);

  await calmFromHere(page, context);
  await uploadQr(page);

  await expectSorting(page);
  // The live wipe's line (role status); a copy of it stays on top across the move to Home.
  await expect(page.getByRole("status").filter({ hasText: LAST_LINE })).toBeVisible({ timeout: 45_000 });

  await expectHomeWithDoFirst(page);
});
