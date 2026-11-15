/**
 * Accessibility check on every main screen (M8-22).
 *
 * WHAT IT CHECKS, per screen, on the phone and laptop projects:
 *  1. axe (rules tagged WCAG 2.0 / 2.1, level A and AA), in light and in dark.
 *  2. By script, in light:
 *     - `tab-unreachable`: every focusable element the page has (a DOM query) is
 *       reached by pressing Tab until the focus comes round again.
 *     - `focus-not-visible`: each element Tab lands on shows it. It counts as shown
 *       when the element has an outline, or when the look of the element, its label,
 *       its parents or its neighbours differs between focused and not focused.
 *     - `focus-trap`: with a sheet or the study session open, Tab and Shift+Tab
 *       never land outside it.
 *     The first test runs these three on a made-up page that has each fault, so a
 *     clean result on a real screen means something.
 *
 * HOW IT REPORTS (the pass / fail rule):
 *  - Every finding is printed as one line starting with `[a11y]`, and attached to
 *    the test as JSON. A finding is keyed by screen and rule id, e.g. `home` +
 *    `color-contrast`.
 *  - `a11y-known.json` (next to this file) lists the findings we already know:
 *    screen -> rule id -> the ticket that fixes it, or "accepted: <reason>".
 *  - The spec FAILS only on a finding that is not in that list (a new rule on a
 *    screen). A known finding is printed and the test passes, so CI stays green
 *    while the tickets are open and goes red when something new breaks.
 *  - When a ticket is fixed, delete its line from a11y-known.json: from then on the
 *    spec guards that rule on that screen. A listed finding that no longer shows up
 *    is printed as `[a11y] stale` and does not fail (a rule can show on one project
 *    only).
 *  - A screen that cannot be opened (404, no such session, an opener that is not
 *    there) is printed as `[a11y] not checked` and annotated; it does not fail.
 *
 * SETUP: `next dev` with the fake Moodle and the fake AI (playwright.config.ts). One
 * demo user per project for the whole file, as in chat.spec.ts: GET /demo makes at
 * most 20 demo users an hour, so `beforeAll` opens it once and every test reuses the
 * cookie. The tests of this file therefore run in order in one worker per project.
 * Nothing here submits, grades or calls the AI: the hand-in sheet is opened and
 * closed, the sessions are started and left. Welcome, School and Connect are opened
 * without the demo cookie, as a new visitor sees them.
 *
 * Next's own dev-tools button (<nextjs-portal>, dev server only) is left out of every
 * check. Cut (ticket): no screen-reader walkthrough by a person.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import knownFile from "./a11y-known.json";

const KNOWN: Record<string, Record<string, string>> = knownFile.known;

const SAMPLE_PDF = path.join(__dirname, "..", "fixtures", "files", "sample.pdf");
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const CARD_TYPES = ["basic", "cloze", "mcq", "match", "explain"] as const;
const DEV_TOOLS = "nextjs-portal";

const SHEET = '[role="dialog"][aria-modal="true"]';
const SESSION = 'section[aria-label="Study session"]';

type Theme = "light" | "dark";
type Finding = {
  screen: string;
  rule: string;
  theme: Theme | "-";
  impact: string;
  count: number;
  /** Where: axe's CSS selectors, or a short description of the element. */
  targets: string[];
  help: string;
};

/** What the page-side walker answers after one Tab press. */
type Probe = { status: "new" | "repeat" | "none" | "devtools"; inside: boolean; label: string; id: number };
type WalkResult = { expected: number; reached: number; unreachable: string[]; notVisible: string[] };
type Walker = { probe(): Probe; blur(): void; result(): WalkResult };
type WithWalker = { __a11y: Walker };

test.describe.configure({ mode: "default", timeout: 240_000 });

/** The demo session this worker's tests share: the cookies /demo set. */
let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

/** Rules found per screen in this worker, to name the known ones that did not show. */
const found = new Map<string, Set<string>>();

/**
 * A failed test ends its worker, and the next worker runs `beforeAll` again. So that this does
 * not make one more demo user per failure (the cap is 20 an hour), the cookie is also kept in
 * the project's output folder, which Playwright empties at the start of every run. It is the
 * session of a throwaway demo user on this machine's test server, not a secret.
 */
function sessionFile(): string {
  const { project } = test.info();
  return path.join(project.outputDir, `.a11y-session-${project.name}-${process.env.PLAYWRIGHT_PORT ?? "0"}.json`);
}

test.beforeAll(async ({ browser, baseURL }) => {
  const kept = sessionFile();
  try {
    session = JSON.parse(readFileSync(kept, "utf8")) as typeof session;
    if (session.length > 0) return;
  } catch {
    // No worker of this run has opened the demo yet.
  }
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
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, JSON.stringify(session));
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context, baseURL }) => {
  // READY_FAST makes every animation instant (src/lib/motion/fast.ts).
  await context.addCookies([{ name: "READY_FAST", value: "1", url: baseURL! }]);
});

test.afterAll(() => {
  const project = test.info().project.name;
  for (const [screen, rules] of Object.entries(KNOWN)) {
    const seen = found.get(screen);
    if (!seen) continue; // The screen was not checked in this worker.
    for (const rule of Object.keys(rules)) {
      if (!seen.has(rule)) console.log(`[a11y] stale | ${project} | ${screen} | ${rule} | listed in a11y-known.json, not found on this project`);
    }
  }
});

/** This browser becomes the shared demo user. */
const signIn = (context: BrowserContext) => context.addCookies(session);

function notChecked(screen: string, why: string) {
  const info = test.info();
  info.annotations.push({ type: "not checked", description: `${screen}: ${why}` });
  console.log(`[a11y] not checked | ${info.project.name} | ${screen} | ${why}`);
}

/** Loaded, quiet, and no animation still running. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
        new Promise((done) => setTimeout(done, 3_000)),
      ]),
    )
    .catch(() => undefined);
}

/** Opens a path. False (and a "not checked" note) when it is missing or lands somewhere else. */
async function visit(page: Page, screen: string, target: string, lands: RegExp): Promise<boolean> {
  const response = await page.goto(target);
  const status = response?.status() ?? 0;
  if (status === 404) {
    notChecked(screen, `missing: ${target} answered 404`);
    return false;
  }
  if (status >= 400) {
    notChecked(screen, `${target} answered ${status}`);
    return false;
  }
  const pathname = new URL(page.url()).pathname;
  if (!lands.test(pathname)) {
    notChecked(screen, `missing: ${target} led to ${pathname}`);
    return false;
  }
  await settle(page);
  return true;
}

/** The app's own switch: <html data-theme> and localStorage (src/app/layout.tsx), plus the system scheme. */
async function setTheme(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    try {
      localStorage.setItem("ready-theme", t);
    } catch {
      // Private mode: the attribute alone is enough for this page.
    }
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
    .toBe(theme);
  // Colour transitions end, charts redraw.
  await page.waitForTimeout(400);
}

async function runAxe(page: Page, screen: string, theme: Theme): Promise<Finding[]> {
  // Two copies of playwright-core are installed, so the two `Page` types differ in name only.
  const params = { page } as unknown as ConstructorParameters<typeof AxeBuilder>[0];
  const results = await new AxeBuilder(params).withTags(WCAG_TAGS).exclude(DEV_TOOLS).analyze();
  return results.violations.map((v) => ({
    screen,
    rule: v.id,
    theme,
    impact: v.impact ?? "unknown",
    count: v.nodes.length,
    targets: v.nodes.slice(0, 8).map((n) => {
      const where = n.target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" ");
      const data = n.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
      return data?.contrastRatio ? `${where} (${data.fgColor} on ${data.bgColor}, ${data.contrastRatio}:1)` : where;
    }),
    help: v.help,
  }));
}

/**
 * Presses Tab until the focus comes round, inside `scope` (a CSS selector) or the whole
 * page. Answers the three scripted checks. With a scope, a focus that lands outside it
 * is a broken trap; Shift+Tab is tried too.
 */
async function keyboardWalk(page: Page, screen: string, scope: string | null): Promise<Finding[]> {
  // Read the focused look at once, not halfway through a transition.
  const still = await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });

  await page.evaluate(
    ({ scope, devTools }) => {
      const FOCUSABLE = [
        "a[href]",
        "area[href]",
        "button",
        "input:not([type='hidden'])",
        "select",
        "textarea",
        "iframe",
        "summary",
        "[contenteditable='true']",
        "[tabindex]",
      ].join(",");
      const root: Element = (scope ? document.querySelector(scope) : null) ?? document.body;

      const describe = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute("type");
        const role = el.getAttribute("role");
        const testId = el.closest("[data-testid]")?.getAttribute("data-testid");
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        return `${tag}${type ? `[type=${type}]` : ""}${role ? `[role=${role}]` : ""}${testId ? ` in [data-testid=${testId}]` : ""} "${name}"`;
      };

      const expected = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) =>
          el.tabIndex >= 0 &&
          !el.matches(":disabled") &&
          !el.closest("[inert]") &&
          !el.closest(devTools) &&
          el.checkVisibility({ checkVisibilityCSS: true }),
      );

      const look = (el: Element) => {
        const s = getComputedStyle(el);
        const clear = /[,/]\s*0\)$/.test(s.outlineColor) || s.outlineColor === "transparent";
        return {
          outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && !clear,
          all: [
            s.outlineStyle,
            s.outlineWidth,
            s.outlineColor,
            s.boxShadow,
            s.backgroundColor,
            s.borderTopColor,
            s.borderBottomColor,
            s.borderTopWidth,
            s.color,
            s.textDecorationLine,
            s.opacity,
          ].join("|"),
        };
      };

      /** The element and what may show the focus for it: its labels, parents and neighbours. */
      const around = (el: Element): Element[] => {
        const labels = el instanceof HTMLInputElement && el.labels ? Array.from(el.labels) : [];
        const list = [el, ...labels, el.parentElement, el.parentElement?.parentElement, el.nextElementSibling, el.previousElementSibling];
        return Array.from(new Set(list.filter((n): n is Element => !!n)));
      };

      const seen = new Map<Element, { node: Element; focused: ReturnType<typeof look> }[]>();
      const order: Element[] = [];

      const walker: Walker = {
        probe() {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return { status: "none", inside: true, label: "", id: -1 };
          if (el.closest(devTools)) return { status: "devtools", inside: true, label: "", id: -2 };
          const inside = root.contains(el);
          const at = order.indexOf(el);
          if (at >= 0) return { status: "repeat", inside, label: describe(el), id: at };
          order.push(el);
          seen.set(
            el,
            around(el).map((node) => ({ node, focused: look(node) })),
          );
          return { status: "new", inside, label: describe(el), id: order.length - 1 };
        },
        blur() {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        },
        result() {
          const radioReached = (el: HTMLElement) =>
            el instanceof HTMLInputElement &&
            el.type === "radio" &&
            el.name !== "" &&
            Array.from(seen.keys()).some(
              (s) => s instanceof HTMLInputElement && s.type === "radio" && s.name === el.name && s.form === el.form,
            );
          const unreachable = expected.filter((el) => el.isConnected && !seen.has(el) && !radioReached(el)).map(describe);
          const notVisible: string[] = [];
          for (const [el, snaps] of seen) {
            if (!el.isConnected || !root.contains(el)) continue;
            const shown = snaps.some(
              ({ node, focused }) => (node === el && focused.outline) || look(node).all !== focused.all,
            );
            if (!shown) notVisible.push(describe(el));
          }
          return { expected: expected.length, reached: seen.size, unreachable, notVisible };
        },
      };
      (window as unknown as WithWalker).__a11y = walker;
    },
    { scope, devTools: DEV_TOOLS },
  );

  const probe = () => page.evaluate(() => (window as unknown as WithWalker).__a11y.probe());
  const count = await page.evaluate(
    ({ scope }) => ((scope ? document.querySelector(scope) : null) ?? document.body).querySelectorAll("*").length,
    { scope },
  );
  const leaks = new Set<string>();
  // Enough presses for every element on the page; the walk ends sooner, when the focus comes
  // round to an element it has been on. Staying on the same element is not coming round: a
  // date or time field takes one Tab per part (day, month, year). Twelve in a row is stuck.
  const most = Math.min(400, Math.max(40, count));
  let last = -1;
  let stayed = 0;
  for (let i = 0; i < most; i++) {
    await page.keyboard.press("Tab");
    const p = await probe();
    if (scope && !p.inside) leaks.add(p.label);
    if (p.id < 0) continue;
    if (p.status === "repeat") {
      if (p.id !== last) break;
      if (++stayed >= 12) break;
    } else {
      stayed = 0;
    }
    last = p.id;
  }
  if (scope) {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Tab");
      const p = await probe();
      if (!p.inside) leaks.add(p.label);
    }
  }

  await page.evaluate(() => (window as unknown as WithWalker).__a11y.blur());
  const result = await page.evaluate(() => (window as unknown as WithWalker).__a11y.result());
  await still.evaluate((node) => (node as Element).remove());

  console.log(
    `[a11y] keyboard | ${test.info().project.name} | ${screen} | ${result.reached} reached by Tab, ${result.expected} focusable`,
  );
  const finding = (rule: string, impact: string, targets: string[], help: string): Finding => ({
    screen,
    rule,
    theme: "-",
    impact,
    count: targets.length,
    targets: targets.slice(0, 8),
    help,
  });
  const out: Finding[] = [];
  if (result.unreachable.length) {
    out.push(finding("tab-unreachable", "serious", result.unreachable, "Every interactive element is reachable by Tab"));
  }
  if (result.notVisible.length) {
    out.push(finding("focus-not-visible", "serious", result.notVisible, "The focused element shows that it is focused"));
  }
  if (leaks.size) {
    out.push(finding("focus-trap", "serious", Array.from(leaks), "Tab stays inside the open sheet or session"));
  }
  return out;
}

/** Prints, attaches, and fails on a finding that a11y-known.json does not list. */
async function report(screen: string, findings: Finding[]) {
  const info = test.info();
  const rules = found.get(screen) ?? new Set<string>();
  found.set(screen, rules);
  const fresh: string[] = [];
  for (const f of findings) {
    rules.add(f.rule);
    const known = KNOWN[screen]?.[f.rule];
    console.log(
      `[a11y] ${known ? "known" : "NEW"} | ${info.project.name} | ${screen} | ${f.theme} | ${f.rule} | ${f.impact} | ${f.count} | ${known ?? "-"} | ${f.targets.join(" ; ")}`,
    );
    if (!known) fresh.push(`${f.rule} (${f.theme}, ${f.impact}, ${f.count} elements): ${f.targets[0] ?? ""}`);
  }
  if (findings.length === 0) console.log(`[a11y] clean | ${info.project.name} | ${screen}`);
  info.annotations.push({
    type: "a11y",
    description: `${screen}: ${findings.length ? Array.from(new Set(findings.map((f) => f.rule))).join(", ") : "clean"}`,
  });
  await info.attach(`a11y-${screen}.json`, { body: JSON.stringify(findings, null, 2), contentType: "application/json" });
  expect
    .soft(
      Array.from(new Set(fresh)),
      `New accessibility findings on "${screen}". Fix them, or add them to tests/e2e/a11y-known.json with a ticket id or "accepted: <reason>".`,
    )
    .toEqual([]);
}

/** axe in light and dark, then the keyboard checks in light. `scope`: the open sheet or session. */
async function audit(page: Page, screen: string, scope: string | null = null) {
  const findings: Finding[] = [];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    findings.push(...(await runAxe(page, screen, theme)));
  }
  await setTheme(page, "light");
  findings.push(...(await keyboardWalk(page, screen, scope)));
  await report(screen, findings);
}

/** Runs the steps that open a state; a step that cannot be done is a "not checked" note. */
async function reach(screen: string, steps: () => Promise<void>): Promise<boolean> {
  try {
    await steps();
    return true;
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    notChecked(screen, `missing: could not open it (${first})`);
    return false;
  }
}

/** Closes the open sheet with Escape. */
async function closeSheet(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(SHEET)).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
}

/** The demo exam's id: from Home's bite row, else from any link to an exam. */
async function demoExamId(page: Page): Promise<string | null> {
  await page.goto("/home");
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const row = page.getByRole("link", { name: /-minute bite for / });
  const href = await row
    .first()
    .getAttribute("href", { timeout: 15_000 })
    .catch(() => null);
  const fromRow = href ? new URL(href, "http://x").searchParams.get("exam") : null;
  if (fromRow && UUID.test(fromRow)) return fromRow;
  for (const from of ["/home", "/exams"]) {
    await page.goto(from);
    await settle(page);
    const link = await page
      .locator('a[href^="/exams/"]')
      .first()
      .getAttribute("href", { timeout: 3_000 })
      .catch(() => null);
    const id = link?.match(UUID)?.[0];
    if (id) return id;
  }
  return null;
}

/** The demo's open assignment: Home's DO FIRST card, else the first one on Assignments. */
async function demoAssignmentPath(page: Page): Promise<string | null> {
  await page.goto("/home");
  const start = page.getByRole("region", { name: "DO FIRST" }).getByRole("article").first().getByRole("link", { name: "Start" });
  const href = await start.getAttribute("href", { timeout: 15_000 }).catch(() => null);
  if (href?.startsWith("/assignments/")) return href;
  await page.goto("/assignments");
  await settle(page);
  return page
    .locator('a[href^="/assignments/"]')
    .first()
    .getAttribute("href", { timeout: 3_000 })
    .catch(() => null);
}

// ---------------------------------------------------------------------------------------
// The scripted checks can fail: two small made-up pages with the three faults in them.
// ---------------------------------------------------------------------------------------

test("the keyboard checks catch a button with no focus ring, one Tab never reaches, and a leaking trap", async ({ page }) => {
  await page.setContent(
    '<main><button>Fine</button><button style="outline:none">No ring</button>' +
      '<button id="stuck">Stuck</button><button>Never</button></main>',
  );
  // Tab is swallowed on the third button, so the focus never gets to the fourth.
  await page.evaluate(() => {
    document.getElementById("stuck")?.addEventListener("keydown", (e) => {
      if (e.key === "Tab") e.preventDefault();
    });
  });
  const page1 = await keyboardWalk(page, "self-check", null);
  expect(page1.map((f) => `${f.rule}: ${f.targets.join(", ")}`).sort()).toEqual([
    'focus-not-visible: button "No ring"',
    'tab-unreachable: button "Never"',
  ]);

  await page.setContent('<div id="box"><button>In</button></div><button>Out</button>');
  const page2 = await keyboardWalk(page, "self-check", "#box");
  expect(page2.map((f) => `${f.rule}: ${f.targets.join(", ")}`)).toEqual(['focus-trap: button "Out"']);
});

// ---------------------------------------------------------------------------------------
// First run: a new visitor, no demo cookie.
// ---------------------------------------------------------------------------------------

test("welcome", async ({ page }) => {
  if (!(await visit(page, "welcome", "/welcome", /^\/welcome$/))) return;
  await audit(page, "welcome");
});

test("school", async ({ page }) => {
  if (!(await visit(page, "school", "/school", /^\/school$/))) return;
  await audit(page, "school");
});

test("connect, and its QR step", async ({ page }) => {
  if (!(await visit(page, "connect", "/connect", /^\/connect$/))) return;
  const next = page.getByRole("button", { name: /^Continue with / });
  await next.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await audit(page, "connect");

  const opened = await reach("connect-qr", async () => {
    // The page streams in: a tap before it hydrates does nothing, so tap until it holds.
    await expect(async () => {
      await next.click({ timeout: 2_000 });
      await expect(page.getByRole("heading", { name: "Use the QR code" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });
  if (!opened) return;
  await settle(page);
  await audit(page, "connect-qr");
});

// ---------------------------------------------------------------------------------------
// The app, as the demo user.
// ---------------------------------------------------------------------------------------

test("home, and the More sheet where the tab bar has one", async ({ page, context }) => {
  await signIn(context);
  if (!(await visit(page, "home", "/home", /^\/home$/))) return;
  await expect(page.getByRole("region", { name: "DO FIRST" })).toBeVisible();
  await audit(page, "home");

  // The tab bar (phones) has More; the side nav (laptops) does not.
  const more = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^More/ });
  if (!(await more.isVisible().catch(() => false))) {
    console.log(`[a11y] skipped | ${test.info().project.name} | more-sheet | this layout has no More button`);
    return;
  }
  const opened = await reach("more-sheet", async () => {
    await expect(async () => {
      await more.click({ timeout: 2_000 });
      await expect(page.locator(SHEET)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  });
  if (!opened) return;
  await audit(page, "more-sheet", SHEET);
  await closeSheet(page);
});

test("assignments", async ({ page, context }) => {
  await signIn(context);
  if (!(await visit(page, "assignments", "/assignments", /^\/assignments$/))) return;
  await audit(page, "assignments");
});

test("an assignment, and its hand-in sheet", async ({ page, context }) => {
  await signIn(context);
  const target = await demoAssignmentPath(page);
  if (!target) return notChecked("assignment", "missing: the demo has no open assignment to link to");
  if (!(await visit(page, "assignment", target, /^\/assignments\/[^/]+$/))) return;
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await audit(page, "assignment");

  // Attach a file and press Hand in: the review sheet. Nothing is submitted.
  const opened = await reach("handin-sheet", async () => {
    const handIn = page.getByRole("region", { name: "Hand in" });
    await handIn.locator('input[type="file"]').setInputFiles(SAMPLE_PDF, { timeout: 15_000 });
    await expect(handIn.getByText("sample.pdf")).toBeVisible({ timeout: 15_000 });
    await handIn.getByRole("button", { name: "Hand in", exact: true }).click({ timeout: 15_000 });
    await expect(page.locator(SHEET).getByRole("heading", { name: /^Hand in to / })).toBeVisible({ timeout: 15_000 });
  });
  if (!opened) return;
  await settle(page);
  await audit(page, "handin-sheet", SHEET);
  await closeSheet(page);
});

test("exams, and the add-an-exam sheet", async ({ page, context }) => {
  await signIn(context);
  if (!(await visit(page, "exams", "/exams", /^\/exams$/))) return;
  await audit(page, "exams");

  const opened = await reach("exam-form-sheet", async () => {
    const add = page.getByRole("button", { name: "Add an exam", exact: true });
    await expect(async () => {
      await add.click({ timeout: 2_000 });
      await expect(page.locator(SHEET)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  });
  if (!opened) return;
  await settle(page);
  await audit(page, "exam-form-sheet", SHEET);
  await closeSheet(page);
});

test("an exam page", async ({ page, context }) => {
  await signIn(context);
  const id = await demoExamId(page);
  if (!id) return notChecked("exam", "missing: the demo has no exam to link to");
  if (!(await visit(page, "exam", `/exams/${id}`, /^\/exams\/[^/]+$/))) return;
  await audit(page, "exam");
});

for (const type of CARD_TYPES) {
  test(`a session card: ${type}`, async ({ page, context }) => {
    const screen = `session-${type}`;
    await signIn(context);
    const id = await demoExamId(page);
    if (!id) return notChecked(screen, "missing: the demo has no exam to study for");
    // A practice session of this one card type (src/app/(app)/study/new/route.ts).
    if (!(await visit(page, screen, `/study/new?exam=${id}&kind=tile&arg=${type}`, /^\/study\/[^/]+$/))) return;

    const card = page.getByTestId("session-card");
    const shown = await reach(screen, async () => {
      await expect(page.locator(SESSION)).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveAttribute("data-card-type", type, { timeout: 30_000 });
    });
    if (!shown) return;
    await settle(page);
    // The session is a trap too: everything behind it is inert.
    await audit(page, screen, SESSION);

    if (type !== "basic") return;
    // The answer side, with the grade buttons.
    const turned = await reach("session-basic-answer", async () => {
      await page.keyboard.press("Space");
      await expect(page.getByRole("group", { name: "How well did you remember?" })).toBeVisible({ timeout: 10_000 });
    });
    if (!turned) return;
    await settle(page);
    await audit(page, "session-basic-answer", SESSION);
  });
}

test("grades", async ({ page, context }) => {
  await signIn(context);
  if (!(await visit(page, "grades", "/grades", /^\/grades$/))) return;
  await audit(page, "grades");
});

test("calendar", async ({ page, context }) => {
  await signIn(context);
  if (!(await visit(page, "calendar", "/calendar", /^\/calendar$/))) return;
  await audit(page, "calendar");
});

test("settings", async ({ page, context }) => {
  await signIn(context);
  if (!(await visit(page, "settings", "/settings", /^\/settings$/))) return;
  await audit(page, "settings");
});
