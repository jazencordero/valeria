/**
 * Whole-flow check (M5-14): accounts.
 *
 * A fresh browser context has no session cookie, so it is signed out:
 * - `/home` shows the welcome screen.
 * - Sign up (an invented name, made unique per run, and an invented password) lands on the
 *   school screen. Picking Aalto stores her school, so the account has started its first run.
 * - Settings, Log out: back on the welcome screen, and `/home` shows it again.
 * - Log in with the same name and password lands on Home.
 * - The demo still opens without signing in, and an /open link is still answered by its own
 *   route (a used or wrong code gets its plain refusal, not the welcome screen). A working code
 *   can only be made with the seed tool, which needs the database the dev server holds; the
 *   route's own test covers that path (src/app/open/route.test.ts).
 *
 * Runs with the READY_FAST cookie (every animation instant), on the phone and laptop projects.
 */
import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Invented only: never a real name or password.
const PASSWORD = "correct horse";

async function fastOn(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: "READY_FAST", value: "1", url: baseURL }]);
}

/** The pages are prerendered: a tap before they hydrate does nothing, so retry until it holds. */
async function submit(page: Page, button: string, until: RegExp) {
  await expect(async () => {
    await page.getByRole("button", { name: button, exact: true }).click({ timeout: 2_000 });
    await expect(page).toHaveURL(until, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

async function fillLogin(page: Page, username: string) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
}

/** The form's own error line (not Next's route announcer, which is an alert too). */
const formAlert = (page: Page) => page.locator("form").getByRole("alert");

// A first visit compiles every page on the dev server; give it room.
test.describe.configure({ timeout: 120_000 });

test("sign up, log out, log in", async ({ page, context, baseURL }) => {
  await fastOn(context, baseURL!);
  const username = `test.student.${randomBytes(5).toString("hex")}`;

  await page.goto("/home");
  await expect(page).toHaveURL(/\/welcome$/);

  // Sign up: the school screen.
  await page.goto("/signup");
  await fillLogin(page, username);
  // The show toggle turns the password into plain text and back.
  const password = page.getByLabel("Password", { exact: true });
  await expect(async () => {
    await page.getByRole("button", { name: "Show password" }).click({ timeout: 2_000 });
    await expect(password).toHaveAttribute("type", "text", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("checkbox").check();
  await submit(page, "Sign up", /\/school$/);

  const aalto = page.getByRole("radio", { name: /Aalto/ });
  await expect(async () => {
    await aalto.click();
    await expect(aalto).toHaveAttribute("aria-checked", "true", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/connect$/);

  // A taken name is refused with one sentence (a second browser, signed out).
  const other = await context.browser()!.newContext();
  const second = await other.newPage();
  await second.goto(`${baseURL}/signup`);
  await expect(async () => {
    // A failed try clears the password field (React resets the form), so fill it each time.
    await fillLogin(second, username.toUpperCase());
    await second.getByRole("checkbox").setChecked(false);
    await second.getByRole("checkbox").check();
    await second.getByRole("button", { name: "Sign up", exact: true }).click({ timeout: 2_000 });
    await expect(formAlert(second)).toHaveText("That username is taken. Pick another one.", { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await other.close();

  // Log out from Settings: the welcome screen, and Home is out of reach.
  await page.goto("/settings");
  await expect(page.getByText(`Logged in as ${username}`)).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/welcome$/);

  // A wrong password: the one answer.
  await page.goto("/login");
  await expect(async () => {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("battery staple");
    await page.getByRole("button", { name: "Log in", exact: true }).click({ timeout: 2_000 });
    await expect(formAlert(page)).toHaveText("That username and password do not match.", { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  // Log in: Home.
  await fillLogin(page, username);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  // Home itself, not a stop on the way to /connect: having no Moodle connection is normal.
  await expect(page.getByRole("region", { name: "DO FIRST" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/home$/);
});

test("the demo and an /open link still work signed out", async ({ page, context, baseURL }) => {
  await fastOn(context, baseURL!);
  const response = await page.goto("/demo");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/home$/);

  const fresh = await context.browser()!.newContext();
  const open = await fresh.request.get(`${baseURL}/open?code=${"A".repeat(43)}`, { maxRedirects: 0 });
  expect(open.status()).toBe(403);
  expect(await open.text()).toBe("This link does not work any more. Ask for a new one.");
  await fresh.close();
});
