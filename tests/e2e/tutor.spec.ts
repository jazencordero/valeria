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

// ---------------------------------------------------------------------------
// M2-28 QA (a real account at 390 px): room for the chat, the new answer from its first line,
// the split remembered, and a card's note attached to its exam.

/** A long answer: its first line is the marker, then paragraphs enough to fill the chat twice. */
const FIRST_LINE = "FIRSTLINE of the answer.";
const LONG_REPLY = [FIRST_LINE, ...Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: present value discounts a later amount back to today at the rate.`)].join("\n\n");

test("on a phone at 390 px: a question gives the chat most of the sheet, and the new answer shows from its first line", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 700, "phones only: the sheet");
  const fake = await script();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);
  await openPad(page);

  const sheet = pad(page);
  const chat = sheet.getByTestId("notepad-chat");
  const heightOf = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!.height;
  const before = await heightOf(chat);

  for (const route of ROUTES) await fake.setDefault(route, { text: LONG_REPLY });
  const question = `What is present value? (${test.info().project.name}, room)`;
  await sheet.getByRole("textbox", { name: "Ask the tutor" }).fill(question);
  await sheet.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = sheet.getByTestId("tutor-answer").filter({ hasText: FIRST_LINE });
  await expect(answer).toBeVisible();
  const log = sheet.getByRole("log", { name: "Tutor conversation" });
  await expect(log).toHaveAttribute("aria-busy", "false");
  await expect(answer).toContainText("Paragraph 14");

  // The note folded to its title and quote: the chat has most of the sheet.
  await expect(sheet.getByRole("button", { name: "Show note" })).toHaveAttribute("aria-expanded", "false");
  const after = await heightOf(chat);
  const whole = await heightOf(sheet);
  expect(after, "the chat grew").toBeGreaterThan(before);
  expect(after / whole, `chat ${after}px of a ${whole}px sheet`).toBeGreaterThan(0.6);

  // The answer's first line is inside the chat's visible area, under the handle.
  const line = (await answer.boundingBox())!;
  const area = (await log.boundingBox())!;
  const handle = (await sheet.getByTestId("notepad-split").boundingBox())!;
  expect(line.y, "first line not above the chat's top").toBeGreaterThanOrEqual(area.y - 1);
  expect(line.y, "first line below the handle").toBeGreaterThanOrEqual(handle.y + handle.height - 1);
  expect(line.y + 20, "first line not below the chat's bottom").toBeLessThanOrEqual(area.y + area.height);
  // And the chat is not scrolled to its very end (the answer is longer than the chat).
  const scrolled = await log.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(scrolled.top).toBeLessThan(scrolled.max);

  // One tap shows the whole note again, its words kept.
  await sheet.getByRole("button", { name: "Show note" }).click();
  await expect(sheet.getByRole("textbox", { name: "Note" })).toBeVisible();
});

test("the split handle's place survives a reload", async ({ page }) => {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);
  await openPad(page);
  const split = pad(page).getByRole("separator", { name: "Resize the note and the tutor" });
  await expect(split).toHaveAttribute("aria-valuenow", "45");
  const box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  const moved = await split.getAttribute("aria-valuenow");
  expect(Number(moved)).toBeGreaterThan(45);

  await page.reload();
  await openPad(page);
  await expect(pad(page).getByRole("separator", { name: "Resize the note and the tutor" })).toHaveAttribute("aria-valuenow", moved!);
  const wide = (page.viewportSize()?.width ?? 0) >= 700;
  const key = wide ? "ready-notes-split" : "ready-notes-split-phone";
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe(moved);
});

test('a note made from "Ask about this card" is attached to the card\'s exam, and the chip says so', async ({ page }) => {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole("link", { name: /-minute bite for / }).click();
  await expect(page).toHaveURL(/\/study\/[^/?]+$/);
  await expect(page.getByTestId("session-card")).toBeVisible();
  await answerCard(page);
  await page.getByRole("button", { name: ASK_CARD, exact: true }).click();
  await expect(pad(page)).toBeVisible();

  // The chip names the exam (as the exam's own page does), never General.
  const chip = pad(page).getByTestId("notepad-chip");
  await expect(chip).toHaveText(/\S+ · \S+/);
  await expect(chip).not.toHaveText("General");
  const label = (await chip.textContent())!.trim();
  // The card is still the quote.
  await expect(pad(page).locator(".np-quote")).not.toBeEmpty();

  const words = `Why this answer? (${test.info().project.name}, attach)`;
  await pad(page).getByRole("textbox", { name: "Note" }).fill(words);
  await expect(pad(page).getByTestId("notepad-saved")).toHaveText("Saved");
  await page.keyboard.press("Escape");
  await expect(pad(page)).toHaveCount(0);

  // Stored on the exam: the Notes tab shows it with the exam as its attachment.
  await page.goto("/notes");
  const card = page.locator("[data-note]").filter({ hasText: words });
  await expect(card).toBeVisible();
  // The Notes tab shows the course's short name (the part before the first comma); the chip the full one.
  await expect(card).toContainText(label.split(",")[0]);
  await expect(card).not.toContainText("General");
});

test("on a phone: the folded quote shows two whole lines, never part of a third", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 700, "phones only: the note folds there");
  await page.setViewportSize({ width: 390, height: 844 });
  // The preview page opens the notes panel on a long quote with a chat that already has turns.
  await page.goto("/dev/tutor#mid");
  const quote = page.locator(".np-top.folded .np-quote");
  await expect(quote).toBeVisible();
  const box = await quote.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      inner: el.clientHeight, // the padding box: what the clamp may show
      line: parseFloat(cs.lineHeight),
      padding: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      full: el.scrollHeight,
    };
  });
  expect(box.full, "the quote is longer than two lines, so the clamp is at work").toBeGreaterThan(box.inner + 1);
  expect(box.padding, "no padding for a third line to show through").toBe(0);
  expect(Math.abs(box.inner - 2 * box.line), "exactly two lines tall").toBeLessThanOrEqual(1);
});
