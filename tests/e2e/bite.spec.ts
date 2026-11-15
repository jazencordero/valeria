/**
 * Whole-flow check (M3-45): one bite.
 *
 * Demo account; from Home the bite row's Start; every card played by
 * keyboard, with the first quiz (mcq) card answered wrong on purpose ("Back
 * in the pile" and one more progress segment); the done screen with a
 * forecast delta above 0; "Done for now"; the exam page with a higher
 * forecast than before; Home's bite row offering the second bite.
 *
 * The deck order may vary, so the loop reads each card's type from the
 * player's `data-card-type` and plays whatever it meets. Right answers (mcq
 * options, match pairs) come from the demo deck fixture the seed is made from.
 *
 * Cut: the explain card is checked by the keyword fallback (no AI here).
 * Runs on the phone and laptop projects; see handin.spec.ts for the setup.
 */
import { expect, test, type Page } from "@playwright/test";
import deck from "../fixtures/study/demo-deck.json";

type DeckCard = { type: string; q: string; opts?: [string, boolean][]; pairs?: [string, string][] };

const CARDS: DeckCard[] = deck.exams.flatMap((e) => e.cards as DeckCard[]);
const byQuestion = (q: string): DeckCard => {
  const c = CARDS.find((d) => d.q.trim() === q.trim());
  if (!c) throw new Error(`Card not in the demo deck: ${q}`);
  return c;
};

const MISS_TEXT = "Back in the pile. That is how it sticks.";
const EXPLAIN_ANSWER =
  "Business strategy should shape and drive IT choices, and it works both ways: IT can enable new strategy. Structure and processes have to fit too.";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "READY_FAST", value: "1", url: baseURL! }]);
});

/** Home's bite row: the whole row is one link. */
const biteRow = (page: Page) => page.getByRole("link", { name: /-minute bite for / });

/** The exam page's forecast ring, "53 percent forecast". */
async function examForecast(page: Page): Promise<number> {
  const ring = page.getByRole("img", { name: /^\d+ percent forecast$/ }).first();
  await expect(ring).toBeVisible();
  const name = (await ring.getAttribute("aria-label")) ?? "";
  return Number(name.match(/^(\d+)/)![1]);
}

const progress = (page: Page) => page.getByRole("img", { name: /^Progress: \d+ of \d+ cards$/ });

async function readProgress(page: Page): Promise<{ passed: number; total: number }> {
  const name = (await progress(page).getAttribute("aria-label")) ?? "";
  const m = name.match(/^Progress: (\d+) of (\d+) cards$/)!;
  return { passed: Number(m[1]), total: Number(m[2]) };
}

/** Grades a recall card as a pass by key: "2" is Got it in two-button mode, "3" Good in four. */
async function gradePass(page: Page) {
  const group = page.getByRole("group", { name: "How well did you remember?" });
  await expect(group).toBeVisible();
  const two = await group.getByRole("button", { name: /Got it/ }).count();
  await page.keyboard.press(two ? "2" : "3");
}

test("one bite: Start, eight cards with one miss, done, the exam's forecast is up", async ({ page }) => {
  await page.goto("/demo?reset=1");
  await expect(page).toHaveURL(/\/home$/);

  // Home offers today's bite; it is for the exam.
  const row = biteRow(page);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Start");
  const href = (await row.getAttribute("href")) ?? "";
  const examId = new URL(href, "http://x").searchParams.get("exam");
  expect(examId).toBeTruthy();
  const cardsInBite = Number((await row.textContent())?.match(/(\d+) CARDS/)?.[1]);
  expect(cardsInBite).toBe(8);

  // The exam's forecast before the bite.
  await page.goto(`/exams/${examId}`);
  const before = await examForecast(page);

  // Back on Home, Start.
  await page.goto("/home");
  await biteRow(page).click();
  await expect(page).toHaveURL(/\/study\/[^/?]+$/);
  await expect(page.getByRole("region", { name: "Study session" })).toBeVisible();

  const start = await readProgress(page);
  expect(start).toEqual({ passed: 0, total: 8 });

  const done = page.getByRole("region", { name: "Session done" });
  let missedOne = false;
  let plays = 0;
  const played: (string | null)[] = [];

  const card = page.getByTestId("session-card");
  for (;;) {
    // A card, or the done screen once the last one is saved.
    await expect(card.or(done)).toBeVisible();
    if (await done.isVisible()) break;
    expect(plays, "more plays than a bite with one miss needs").toBeLessThan(12);
    const type = await card.getAttribute("data-card-type");
    const { passed, total } = await readProgress(page);

    switch (type) {
      case "basic":
        await page.keyboard.press("Space");
        await gradePass(page);
        break;

      case "cloze": {
        // Space opens one blank at a time; the grade buttons come after the last.
        const group = page.getByRole("group", { name: "How well did you remember?" });
        for (let i = 0; i < 6 && !(await group.isVisible()); i++) {
          await page.keyboard.press("Space");
        }
        await gradePass(page);
        break;
      }

      case "mcq": {
        const q = (await card.getByRole("heading", { level: 2 }).textContent()) ?? "";
        const right = byQuestion(q).opts!.find(([, ok]) => ok)![0];
        const options = card.getByRole("group", { name: "Options" }).getByRole("button");
        const texts = await options.allTextContents();
        const rightAt = texts.findIndex((t) => t.includes(right));
        expect(rightAt).toBeGreaterThanOrEqual(0);
        const wrongOnPurpose = !missedOne;
        const pick = wrongOnPurpose ? (rightAt === 0 ? 1 : 0) : rightAt;
        await page.keyboard.press(String(pick + 1));
        await expect(page.getByTestId("fb-strip")).toBeVisible();
        await page.keyboard.press("Enter");
        if (wrongOnPurpose) {
          missedOne = true;
          await expect(page.getByRole("status").filter({ hasText: MISS_TEXT })).toBeVisible();
          await expect(progress(page)).toHaveAttribute("aria-label", `Progress: ${passed + 1} of ${total + 1} cards`);
        }
        break;
      }

      case "explain": {
        const box = card.getByRole("textbox", { name: "From memory. No peeking." });
        await expect(box).toBeFocused();
        await page.keyboard.type(EXPLAIN_ANSWER);
        await page.keyboard.press("ControlOrMeta+Enter");
        await expect(card.getByText("Quick check only")).toBeVisible();
        await gradePass(page);
        break;
      }

      case "match": {
        const q = (await card.getByRole("heading", { level: 2 }).textContent()) ?? "";
        const pairs = byQuestion(q).pairs!;
        const terms = card.getByRole("group", { name: "Terms" });
        const meanings = card.getByRole("group", { name: "Meanings" });
        for (const [term, meaning] of pairs) {
          await terms.getByRole("button", { name: term, exact: true }).focus();
          await page.keyboard.press("Enter");
          await meanings.getByRole("button", { name: meaning, exact: true }).focus();
          await page.keyboard.press("Enter");
        }
        await expect(page.getByTestId("fb-strip")).toBeVisible();
        await page.keyboard.press("Enter");
        break;
      }

      default:
        throw new Error(`Unknown card type: ${type}`);
    }

    plays++;
    played.push(type);
    // The card is graded: its segment fills (the frame stays while the last one saves).
    await expect
      .poll(async () => (await done.isVisible()) || (await readProgress(page)).passed > passed)
      .toBe(true);
  }

  expect(missedOne, "the bite had a quiz card").toBe(true);
  expect(plays).toBe(9);
  test.info().annotations.push({ type: "cards played", description: played.join(", ") });

  // Done: the forecast moved up.
  const chart = done.getByRole("img", { name: /^Forecast \d+%, was \d+%, target \d+%$/ });
  await expect(chart).toBeVisible();
  const [, after, was] = ((await chart.getAttribute("aria-label")) ?? "").match(/^Forecast (\d+)%, was (\d+)%/)!;
  expect(Number(after) - Number(was)).toBeGreaterThan(0);
  await expect(done.getByRole("button", { name: /^One more bite/ })).toBeVisible();

  // Done for now: the exam page, higher than before.
  await done.getByRole("button", { name: "Done for now" }).click();
  await expect(page).toHaveURL(new RegExp(`/exams/${examId}(\\?|$)`));
  const now = await examForecast(page);
  expect(now).toBeGreaterThan(before);
  expect(now).toBe(Number(after));

  // Home offers the second bite for the same exam.
  await page.goto("/home");
  const second = biteRow(page);
  await expect(second).toBeVisible();
  await expect(second).toContainText("Start");
  await expect(second).toHaveAttribute("href", new RegExp(`exam=${examId}`));
});
