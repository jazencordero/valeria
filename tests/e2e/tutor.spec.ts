/**
 * Whole-flow check (M2-28): the tutor in a real browser, with the demo account and the fake AI.
 *
 * (a) The study-rule question on a lecture. Open the demo's current lecture and the notes panel:
 *     the question "May Ready use this course's slides ..." shows with Yes / No / Not sure. A
 *     question asked before answering it reaches the fake AI with no lecture text; after "Yes"
 *     the next one carries the lecture's text; after a reload the question is gone.
 * (b) "Ask about this card" in a study session. Before the card is answered there is no entry;
 *     once it is, the entry opens the notes panel over the session; digits typed in the chat box
 *     grade nothing; Escape closes the panel only; and (wide screens, where the session stays
 *     clickable behind the panel) the next card closes it.
 *
 * The tutor switch: a demo user gets `users.settings.tutor.enabled` only on this test server
 * (src/server/demo/seed.ts, `demoTutorOn`: both fakes on, no VERCEL* value, not production).
 *
 * Setup as chat.spec.ts: one demo session per project for the whole file (GET /demo makes at
 * most 20 demo users an hour, M2-25), each test starting from /demo?reset=1, the tests of this
 * file in order in one worker per project. A test that reads the fake AI's calls holds the
 * fake's lock (`script`), so the other project's copy cannot script it or reset its calls
 * meanwhile; the calls are also picked out by this test's own question text.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { connectFakeAi, type FakeAiCall, type FakeAiClient } from "../fake-ai/server";
import deck from "../fixtures/study/demo-deck.json";
import lectures from "../fixtures/study/demo-lectures.json";

const STUDY_ASK_LINE = "May Ready use this course's slides to explain things to you? Check the course's rules on AI.";
const ASK_CARD = "Ask about this card";
const STOP_TEXT = "Stop here? Your progress is saved.";
const ROUTES = ["groq", "openrouter", "cloudflare"];

const COURSE = "Strategic IT Management";
const sit = lectures.courses.find((c) => c.name === COURSE)!;
const current = sit.lectures.find((l) => l.state === "cur")!;

/** Every paragraph of the current lecture's page: whichever section is in view, one of these goes when allowed. */
const LECTURE_PARAGRAPHS: string[] = (current.page?.sections ?? []).flatMap((s) =>
  (s.blocks as unknown[]).filter((b): b is ["p", string] => Array.isArray(b) && b[0] === "p" && typeof b[1] === "string").map((b) => b[1]),
);

type DeckCard = { type: string; q: string; opts?: [string, boolean][]; pairs?: [string, string][] };
const CARDS: DeckCard[] = deck.exams.flatMap((e) => e.cards as DeckCard[]);
const byQuestion = (q: string): DeckCard => {
  const c = CARDS.find((d) => d.q.trim() === q.trim());
  if (!c) throw new Error(`Card not in the demo deck: ${q}`);
  return c;
};

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
  await context.addCookies([...session, { name: "READY_FAST", value: "1", url: baseURL! }]);
});

test.afterEach(async () => {
  if (!held) return;
  const owner = held;
  held = null;
  await ai.unlock(owner);
});

/** Every string in a request body (system prompt, history, question), joined. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(textOf).join("\n");
  return "";
}

/** The one call to the fake that carried `question`. */
async function callWith(fake: FakeAiClient, question: string): Promise<FakeAiCall> {
  const mine = (await fake.calls()).filter((c) => textOf(c.body).includes(question));
  expect(mine, `one AI call carried "${question}"`).toHaveLength(1);
  return mine[0];
}

const hasLectureText = (call: FakeAiCall) => {
  const text = textOf(call.body);
  return LECTURE_PARAGRAPHS.some((p) => text.includes(p));
};

/** The nav on screen: the sidebar's from 700 px, else the tab bar's. */
const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" }).filter({ visible: true });

/** Seeds the demo again and opens the current lecture of Strategic IT Management (as learn.spec.ts). */
async function openDemoLecture(page: Page) {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  if (await sidebar.isVisible()) {
    await sidebar.getByRole("list", { name: "COURSES" }).getByRole("link", { name: new RegExp(`^${COURSE}`) }).click();
  } else {
    await mainNav(page).getByRole("link", { name: /^Courses/ }).click();
    await expect(page).toHaveURL(/\/courses$/);
    await page.getByRole("main").getByRole("link", { name: new RegExp(COURSE) }).click();
  }
  await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: `Lecture ${current.n}, ${current.title}, you are here`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/lectures/${current.n}$`));
  await expect(page.getByRole("heading", { level: 1, name: current.title })).toBeVisible();
}

const pad = (page: Page) => page.getByRole("dialog", { name: "Notepad" });

async function openPad(page: Page) {
  if (!(await pad(page).isVisible())) await page.getByRole("button", { name: "Notes, open the notepad" }).click();
  await expect(pad(page)).toBeVisible();
  await expect(pad(page).getByTestId("tutor-chat")).toBeVisible();
}

/** Asks the tutor `question` and waits for `reply` (the fake's answer) to finish streaming. */
async function ask(page: Page, question: string, reply: string) {
  const box = pad(page).getByRole("textbox", { name: "Ask the tutor" });
  await box.fill(question);
  await pad(page).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(pad(page).getByTestId("tutor-answer").filter({ hasText: reply })).toBeVisible();
  await expect(pad(page).getByRole("log", { name: "Tutor conversation" })).toHaveAttribute("aria-busy", "false");
}

test("on a lecture: the study-rule question, no lecture text before Yes, lecture text after, gone after a reload", async ({ page }) => {
  const fake = await script();
  const who = test.info().project.name;
  const before = `What is vendor lock-in? (${who}, before)`;
  const after = `And how do I reduce it? (${who}, after)`;

  expect(LECTURE_PARAGRAPHS.length, "the demo lecture has paragraphs to look for").toBeGreaterThan(0);
  await openDemoLecture(page);
  await openPad(page);

  // The question, once, with its three answers.
  const question = pad(page).getByTestId("tutor-study-ask");
  await expect(question).toBeVisible();
  await expect(question).toContainText(STUDY_ASK_LINE);
  for (const label of ["Yes", "No", "Not sure"]) {
    await expect(question.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // Asked before she answers: the course's rule is still unknown, so no lecture text goes.
  for (const route of ROUTES) await fake.setDefault(route, { text: "General answer one." });
  await ask(page, before, "General answer one.");
  const first = await callWith(fake, before);
  expect(hasLectureText(first), "no lecture text before Yes").toBe(false);
  // The where-line names the lecture, but none of its words.
  expect(textOf(first.body)).toContain(current.title);

  // Yes: the course's rule is stored as allowed; the question goes.
  await question.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(pad(page).getByTestId("tutor-study-ask")).toHaveCount(0);

  // Asked again: now the lecture's text is in the request.
  for (const route of ROUTES) await fake.setDefault(route, { text: "Course answer two." });
  await ask(page, after, "Course answer two.");
  expect(hasLectureText(await callWith(fake, after)), "lecture text after Yes").toBe(true);

  // Stored, not just shown: after a reload the chat is there and the question is not.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: current.title })).toBeVisible();
  await openPad(page);
  await expect(pad(page).getByTestId("tutor-mine").filter({ hasText: after })).toBeVisible();
  await expect(pad(page).getByTestId("tutor-study-ask")).toHaveCount(0);
  await expect(page.getByText(STUDY_ASK_LINE)).toHaveCount(0);
});

/** The progress bar, found by its label so it is found while a phone's sheet hides the session from the tree. */
const progress = (page: Page) => page.locator('[role="img"][aria-label^="Progress: "]');
const grades = (page: Page) => page.getByRole("group", { name: "How well did you remember?" });

/** Answers (or reveals) the card on screen without grading it: grade buttons or the feedback strip show. */
async function answerCard(page: Page) {
  const card = page.getByTestId("session-card");
  const type = await card.getAttribute("data-card-type");
  switch (type) {
    case "basic":
      await page.keyboard.press("Space");
      await expect(grades(page)).toBeVisible();
      return;
    case "cloze":
      for (let i = 0; i < 6 && !(await grades(page).isVisible()); i++) await page.keyboard.press("Space");
      await expect(grades(page)).toBeVisible();
      return;
    case "mcq":
      await page.keyboard.press("1");
      await expect(page.getByTestId("fb-strip")).toBeVisible();
      return;
    case "explain":
      await expect(card.getByRole("textbox", { name: "From memory. No peeking." })).toBeFocused();
      await page.keyboard.type("Strategy drives IT, and IT can enable strategy.");
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(grades(page)).toBeVisible();
      return;
    case "match": {
      const q = (await card.getByRole("heading", { level: 2 }).textContent()) ?? "";
      for (const [term, meaning] of byQuestion(q).pairs!) {
        await card.getByTestId("match-terms").getByRole("button", { name: term, exact: true }).click();
        await card.getByTestId("match-meanings").getByRole("button", { name: meaning, exact: true }).click();
      }
      await expect(page.getByTestId("fb-strip")).toBeVisible();
      return;
    }
    default:
      throw new Error(`Unknown card type: ${type}`);
  }
}

test('in a study session: "Ask about this card" only once answered; the panel over the session; keys and Escape are the panel\'s; the next card closes it', async ({
  page,
}) => {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole("link", { name: /-minute bite for / }).click();
  await expect(page).toHaveURL(/\/study\/[^/?]+$/);
  await expect(page.getByRole("region", { name: "Study session" })).toBeVisible();

  const card = page.getByTestId("session-card");
  const askCard = page.getByRole("button", { name: ASK_CARD, exact: true });
  await expect(card).toBeVisible();
  const cardId = await card.getAttribute("data-card-id");
  expect(cardId).toBeTruthy();

  // Before the answer: no entry.
  await expect(askCard).toHaveCount(0);

  // Answered or revealed: the entry is there.
  await answerCard(page);
  await expect(askCard).toBeVisible();
  const progressBefore = await progress(page).getAttribute("aria-label");

  // It opens the notes panel over the session, on this card.
  await askCard.click();
  await expect(pad(page)).toBeVisible();
  await expect(pad(page).getByTestId("tutor-chat")).toBeVisible();
  await expect(pad(page).locator(".np-quote")).not.toBeEmpty();
  // The session stays under it (on a phone hidden from the accessibility tree while the sheet is up).
  await expect(card).toHaveAttribute("data-card-id", cardId!);

  // Digits typed in the chat box stay in the box and grade nothing.
  const box = pad(page).getByRole("textbox", { name: "Ask the tutor" });
  await box.click();
  await page.keyboard.type("2 1 3 4");
  await expect(box).toHaveValue("2 1 3 4");
  await expect(card).toHaveAttribute("data-card-id", cardId!);
  await expect(progress(page)).toHaveAttribute("aria-label", progressBefore!);

  // Escape closes the panel only: the same card, no stop question.
  await page.keyboard.press("Escape");
  await expect(pad(page)).toHaveCount(0);
  await expect(page.getByText(STOP_TEXT)).toHaveCount(0);
  await expect(card).toHaveAttribute("data-card-id", cardId!);
  await expect(progress(page)).toHaveAttribute("aria-label", progressBefore!);
  await expect(askCard).toBeVisible();

  // The next card closes it. Only on a wide screen can the session be used with the panel open;
  // a phone's panel is a modal sheet over it.
  const wide = (page.viewportSize()?.width ?? 0) >= 700;
  await askCard.click();
  await expect(pad(page)).toBeVisible();
  if (wide) {
    if (await grades(page).isVisible()) {
      await grades(page).getByRole("button").filter({ hasText: /Got it|Good/ }).first().click();
    } else {
      await page.getByTestId("fb-strip").getByRole("button", { name: "Continue" }).click();
    }
  } else {
    test.info().annotations.push({ type: "phone", description: "the panel is a modal sheet here: closed with Escape before the next card" });
    await page.keyboard.press("Escape");
    await expect(pad(page)).toHaveCount(0);
    if (await grades(page).isVisible()) {
      await grades(page).getByRole("button").filter({ hasText: /Got it|Good/ }).first().click();
    } else {
      await page.getByTestId("fb-strip").getByRole("button", { name: "Continue" }).click();
    }
  }
  await expect(card).not.toHaveAttribute("data-card-id", cardId!);
  await expect(pad(page)).toHaveCount(0);
  // The new card is not answered yet: no entry.
  await expect(askCard).toHaveCount(0);
});
