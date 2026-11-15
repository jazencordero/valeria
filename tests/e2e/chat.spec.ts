/**
 * Whole-flow check (M2-23): chat to a draft to hand-in.
 *
 * Runs on the phone and laptop projects against `next dev` with the fake Moodle and the fake
 * AI. The fake AI is started by ./global-setup.ts; the dev server sends every AI call to it
 * (AI_FAKE_URL, src/server/ai/router.ts) and the tests script its replies over HTTP. No test
 * here talks to a real provider.
 *
 * One demo user per project for the whole file. GET /demo makes at most 20 demo users an hour
 * in total (M2-25) and the local database outlives a test run, so a fresh demo user per test
 * would use that up in two runs. Instead `beforeAll` opens the demo once and keeps its session
 * cookie; every test puts the cookie into its own fresh browser context and starts with
 * /demo?reset=1, which replaces that demo user with a newly seeded one (the count does not
 * grow). So each test still starts from the seed: no chat, no draft, nothing handed in, and a
 * course whose AI rule (M2-27) has not been answered yet, so the page shows the policy card.
 * Sharing one user means the tests of this file must not overlap: they run in order, in one
 * worker per project (`mode: "default"`, not "serial": a failure does not skip the rest).
 *
 * Scripted replies and the two projects: the dev server's provider routes are fixed ("groq",
 * "openrouter", "cloudflare"), so two tests scripting replies at once would take each other's.
 * The phone and the laptop project run this file side by side, so a test that scripts the fake
 * holds the fake's lock while it runs (`script` below) and the other project's copy waits for
 * it. Tests that expect no AI call need no lock.
 * The busy test answers 429 with `retry-after: 0`, so the cool-down the router writes for each
 * provider is over at once and the next test finds them all usable.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { connectFakeAi, toolCallBody, type FakeAiClient } from "../fake-ai/server";

const OFF_LINE = "This course does not allow AI help on assignments. Hand-in works as usual.";
const UNKNOWN_LINE = "We don't know this course's rule on AI help yet. Hand-in works as usual.";
const EXPLAIN_LINE = "Explain-only: this course does not allow AI-written homework.";
const BUSY_LINE = "AI is busy. Try again in a few minutes.";

const DRAFT_TITLE = "Forecast memo";
const DRAFT_MD = [
  "# Forecast memo",
  "",
  "## What the data shows",
  "",
  "Demand rose in each of the last three quarters, as you said in the chat.",
  "",
  "## Method",
  "",
  "A moving average over four quarters, compared with a simple trend line.",
  "",
  "## Conclusion",
  "",
  "[Your conclusion goes here. Write it in your own words.]",
].join("\n");

/** How long one scripted test may take once it holds the lock, and how long it may wait for it. */
const RUN_MS = 90_000;
const WAIT_MS = 120_000;

const ai = connectFakeAi(process.env.AI_FAKE_URL ?? "");
let held: string | null = null;

/** Takes the fake AI for this test (waiting for the other project's copy), reset and empty. */
async function script(): Promise<FakeAiClient> {
  const info = test.info();
  const owner = `${info.project.name}:${info.titlePath.join(" > ")}:${info.retry}`;
  test.setTimeout(WAIT_MS + RUN_MS);
  const started = Date.now();
  await ai.lock(owner, { waitMs: WAIT_MS, ttlMs: RUN_MS + 15_000 });
  held = owner;
  test.setTimeout(Date.now() - started + RUN_MS);
  return ai;
}

test.describe.configure({ mode: "default" });

/** The demo session this worker's tests share: the cookies /demo set. */
let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/demo`);
    expect(
      response?.status(),
      "GET /demo was refused. 503 means 20 demo users were made in the past hour (M2-25): wait, then run again.",
    ).toBe(200);
    await expect(page).toHaveURL(/\/home$/);
    session = await context.cookies();
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context, baseURL }) => {
  // READY_FAST makes every animation instant (src/lib/motion/fast.ts).
  await context.addCookies([...session, { name: "READY_FAST", value: "1", url: baseURL! }]);
});

test.afterEach(async () => {
  if (!held) return;
  const owner = held;
  held = null;
  await ai.unlock(owner);
});

/** Seeds the demo again and opens its Assignment 3. Its course has not said what it allows yet. */
async function openDemoAssignment(page: Page) {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);
  const hero = page.getByRole("region", { name: "DO FIRST" }).getByRole("article", { name: "Assignment 3" });
  await hero.getByRole("link", { name: "Start" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Assignment 3" })).toBeVisible();
  // Not answered yet counts as off: the question, and no chat. The line says the rule is not
  // known; it never says the course does not allow AI help.
  await expect(page.getByTestId("ai-policy").getByText(/allow AI help on homework\?/)).toBeVisible();
  await expect(page.getByTestId("ai-policy").getByText(/Check the syllabus\./)).toBeVisible();
  for (const label of ["Yes", "Only to explain", "No", "Not sure"]) {
    await expect(page.getByTestId("ai-policy").getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("ai-policy-unknown")).toHaveText(UNKNOWN_LINE);
  await expect(page.getByText(OFF_LINE)).toHaveCount(0);
  await expect(page.getByRole("log", { name: "Conversation" })).toHaveCount(0);
}

const answerPolicy = (page: Page, label: string) =>
  page.getByTestId("ai-policy").getByRole("button", { name: label, exact: true }).click();

const chat = (page: Page) => page.getByRole("log", { name: "Conversation" });
const messageBox = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("chat, ask for a draft, read it and hand it in", async ({ page }) => {
  const fake = await script();
  await fake.queue(
    "groq",
    { text: "The brief asks for a short memo that compares two forecasts." },
    { rawBody: toolCallBody("write_draft", { title: DRAFT_TITLE, markdown: DRAFT_MD }) },
    { text: "Your draft is ready. Remember to say that you used AI." },
  );

  await openDemoAssignment(page);
  await answerPolicy(page, "Yes");
  await expect(chat(page)).toBeVisible();
  await expect(page.getByTestId("ai-policy")).toHaveCount(0);

  // Turn 1: the suggestion, and the streamed answer.
  await page.getByRole("button", { name: "What exactly is asked?", exact: true }).click();
  await expect(chat(page).getByText("What exactly is asked?")).toBeVisible();
  await expect(chat(page).getByText("The brief asks for a short memo that compares two forecasts.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft it with me", exact: true })).toBeVisible();

  // Turn 2: she asks for a draft (the word "draft" is what lets write_draft save, M2-26).
  await messageBox(page).fill("Write a draft from what I said");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const card = page.getByTestId("draft-card");
  await expect(card).toHaveAttribute("data-state", "outline");
  await expect(card.getByText("Forecast_memo.pdf")).toBeVisible();
  const outline = card.getByTestId("draft-outline").getByRole("listitem");
  await expect(outline).toHaveText(["Forecast memo", "What the data shows", "Method", "Conclusion"]);
  await expect(chat(page).getByText("Your draft is ready. Remember to say that you used AI.")).toBeVisible();

  // The model was asked three times: the answer, the tool call, the reply after the tool ran.
  const calls = await fake.calls();
  expect(calls.map((c) => c.route)).toEqual(["groq", "groq", "groq"]);
  expect(JSON.stringify(calls[2].body.messages)).toContain('\\"saved\\":true');

  // Read it.
  await card.getByRole("button", { name: "Read it", exact: true }).click();
  await expect(card).toHaveAttribute("data-state", "expanded");
  await expect(card.getByTestId("draft-preview").getByText("A moving average over four quarters")).toBeVisible();

  // Hand in, then her tap on Submit.
  await card.getByRole("button", { name: "Hand in", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: /^Hand in to / })).toBeVisible();
  await expect(sheet.getByText(/\.pdf$/)).toBeVisible();
  await sheet.getByRole("button", { name: /^Submit to / }).click();

  // The receipt, and the receipt line in the chat.
  await expect(sheet.getByRole("heading", { name: "Handed in", exact: true })).toBeVisible();
  await expect(page.getByTestId("receipt-line")).toHaveText(/^Handed in to .+ at \d{1,2}[:.]\d{2}\.$/);
  await expect(page.getByTestId("work-due")).toHaveText(/^Handed in /);
});

test('"No" turns assignment help off: no chat, only the line and the hand-in', async ({ page }) => {
  await openDemoAssignment(page);
  await answerPolicy(page, "No");

  // The question is gone; the line and the way back stay.
  const policy = page.getByTestId("ai-policy");
  await expect(policy.getByRole("button", { name: "Change answer" })).toBeVisible();
  await expect(page.getByTestId("ai-policy-off")).toContainText(OFF_LINE);
  await expect(page.getByTestId("ai-policy-unknown")).toHaveCount(0);
  await expect(policy.getByText(/allow AI help on homework\?/)).toHaveCount(0);

  // No chat at all: no conversation, no message box, no suggestion.
  await expect(chat(page)).toHaveCount(0);
  await expect(messageBox(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft it with me" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "What exactly is asked?" })).toHaveCount(0);

  // Hand-in works as usual.
  await expect(page.getByRole("region", { name: "Hand in" }).getByRole("button", { name: "Hand in", exact: true })).toBeVisible();

  // It is stored, not just shown: the same after a reload.
  await page.reload();
  await expect(page.getByTestId("ai-policy-off")).toContainText(OFF_LINE);
  await expect(messageBox(page)).toHaveCount(0);
});

test('"Only to explain" shows the chat with the explain-only line and offers no draft', async ({ page }) => {
  await openDemoAssignment(page);
  await answerPolicy(page, "Only to explain");

  await expect(page.getByTestId("ai-policy-explain-only")).toContainText(EXPLAIN_LINE);
  await expect(page.getByText(OFF_LINE)).toHaveCount(0);
  await expect(chat(page)).toBeVisible();
  await expect(chat(page).getByText("I can explain the ideas behind this assignment.")).toBeVisible();
  await expect(messageBox(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft it with me" })).toHaveCount(0);
});

test("every provider busy: the busy sentence, and her text is back in the input", async ({ page }) => {
  const fake = await script();
  for (const route of ["groq", "openrouter", "cloudflare"]) {
    await fake.setDefault(route, { status: 429, retryAfter: 0 });
  }

  await openDemoAssignment(page);
  await answerPolicy(page, "Yes");
  await expect(chat(page)).toBeVisible();

  const text = "Where should I start with the forecast?";
  await messageBox(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByTestId("chat-note")).toHaveText(BUSY_LINE);
  await expect(messageBox(page)).toHaveValue(text);
  // Her bubble was taken out again; the text is hers to send once more.
  await expect(chat(page).getByText(text)).toHaveCount(0);

  // Every provider was tried once, in the config's order.
  expect((await fake.calls()).map((c) => c.route)).toEqual(["groq", "openrouter", "cloudflare"]);
});
