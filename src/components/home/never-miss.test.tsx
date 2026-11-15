import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHOOLS } from "@/lib/schools";
import {
  NOT_NOW_KEY,
  NOT_NOW_MS,
  NeverMiss,
  countLine,
  doneMeta,
  isSnoozed,
  type NeverMissProps,
} from "./never-miss";

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function setup(props: Partial<NeverMissProps> = {}) {
  const onTurnOn = props.onTurnOn ?? vi.fn(async () => undefined);
  const user = userEvent.setup();
  const view = render(
    <NeverMiss
      dateCount={6}
      reminders="email"
      schoolName={SCHOOLS.aalto.name}
      {...props}
      onTurnOn={onTurnOn}
    />,
  );
  return { user, onTurnOn, ...view };
}

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Set up" }));
  return screen.findByRole("dialog", { name: "Never miss one" });
}

/** The Turn on button reads `text` (Button keeps a hidden copy of its label for the loading swap). */
function expectLabel(text: string) {
  expect(screen.getByRole("button", { name: text })).toBe(screen.getByTestId("never-miss-submit"));
}

function fakeTab() {
  return { location: { href: "" }, close: vi.fn(), opener: {} } as unknown as Window;
}

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  stubMatchMedia();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

describe("NeverMiss card", () => {
  it("shows the sky card with its copy", () => {
    setup({ reminders: "push" });
    expect(screen.getByText("Never miss one")).toBeTruthy();
    expect(screen.getByText("Deadlines in your calendar. Reminders on your phone.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("Not now hides the card for 30 days, then it comes back", async () => {
    let t = Date.UTC(2026, 10, 15, 12);
    const now = () => t;
    const { user, unmount } = setup({ now });
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByTestId("never-miss-card")).toBeNull());
    expect(window.localStorage.getItem(NOT_NOW_KEY)).toBe(String(t));
    unmount();

    t += NOT_NOW_MS - 60_000;
    setup({ now });
    expect(screen.queryByTestId("never-miss-card")).toBeNull();
    cleanup();

    t += 120_000;
    setup({ now });
    expect(screen.getByTestId("never-miss-card")).toBeTruthy();
  });

  it("isSnoozed ignores missing, broken and future timestamps", () => {
    expect(isSnoozed(null, 1000)).toBe(false);
    expect(isSnoozed("nope", 1000)).toBe(false);
    expect(isSnoozed("5000", 1000)).toBe(false);
    expect(isSnoozed("1000", 1000 + NOT_NOW_MS - 1)).toBe(true);
    expect(isSnoozed("1000", 1000 + NOT_NOW_MS)).toBe(false);
  });
});

describe("NeverMiss sheet", () => {
  it("shows the real date count", async () => {
    const { user } = setup({ dateCount: 4 });
    await openSheet(user);
    expect(screen.getByText("4 dates now, new ones as they appear.")).toBeTruthy();
    expect(countLine(1)).toBe("1 date now, new ones as they appear.");
  });

  it("reads Close when both switches are off, and closes without saving", async () => {
    const { user, onTurnOn } = setup();
    await openSheet(user);
    expectLabel("Turn on");
    await user.click(screen.getByRole("switch", { name: "Add deadlines to my calendar" }));
    expectLabel("Turn on");
    await user.click(screen.getByRole("switch", { name: "Remind me by email" }));
    expectLabel("Close");
    await user.click(screen.getByTestId("never-miss-submit"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onTurnOn).not.toHaveBeenCalled();
    expect(screen.getByTestId("never-miss-card")).toBeTruthy();
  });

  it("reads Close with the calendar off when no reminders are offered", async () => {
    const { user } = setup({ reminders: "none" });
    await openSheet(user);
    expect(screen.queryByRole("switch", { name: /Remind me/ })).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Add deadlines to my calendar" }));
    expectLabel("Close");
  });

  it("an invalid email shows the error and does not submit", async () => {
    vi.spyOn(window, "open").mockReturnValue(fakeTab());
    const { user, onTurnOn } = setup();
    await openSheet(user);
    const field = screen.getByPlaceholderText("Your personal email, not the Aalto one");
    await user.click(screen.getByTestId("never-miss-submit"));
    expect(screen.getByRole("alert").textContent).toBe("Add an email, or switch reminders off.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await user.type(field, "valeria");
    await user.click(screen.getByTestId("never-miss-submit"));
    expect(screen.getByRole("alert").textContent).toBe("Add an email, or switch reminders off.");
    expect(onTurnOn).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("switching reminders off clears the email error", async () => {
    const { user } = setup();
    await openSheet(user);
    await user.click(screen.getByTestId("never-miss-submit"));
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Remind me by email" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("NeverMiss turning on", () => {
  it("both on: saves the choice and shows Calendar and reminders are on", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab);
    const onTurnOn = vi.fn(async () => ({ subscribeUrl: "webcal://ready.test/api/cal/x.ics" }));
    const { user } = setup({ onTurnOn });
    await openSheet(user);
    await user.click(screen.getByRole("button", { name: "Apple" }));
    await user.type(screen.getByRole("textbox"), "  me@example.com ");
    await user.click(screen.getByTestId("never-miss-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("never-miss-done-title").textContent).toBe(
        "Calendar and reminders are on",
      ),
    );
    expect(onTurnOn).toHaveBeenCalledWith({ calendar: "apple", reminders: "email", email: "me@example.com" });
    expect(screen.getByText("6 dates in Apple Calendar · reminders to me@example.com")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tab.location.href).toBe("webcal://ready.test/api/cal/x.ics");
  });

  it("calendar only: Calendar is on", async () => {
    vi.spyOn(window, "open").mockReturnValue(fakeTab());
    const { user, onTurnOn } = setup();
    await openSheet(user);
    await user.click(screen.getByRole("switch", { name: "Remind me by email" }));
    await user.click(screen.getByTestId("never-miss-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("never-miss-done-title").textContent).toBe("Calendar is on"),
    );
    expect(onTurnOn).toHaveBeenCalledWith({ calendar: "google", reminders: null });
    expect(screen.getByText("6 dates in Google Calendar")).toBeTruthy();
  });

  it("reminders only: Reminders are on, and no tab opens", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(fakeTab());
    const { user, onTurnOn } = setup({ reminders: "push" });
    await openSheet(user);
    await user.click(screen.getByRole("switch", { name: "Add deadlines to my calendar" }));
    await user.click(screen.getByTestId("never-miss-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("never-miss-done-title").textContent).toBe("Reminders are on"),
    );
    expect(onTurnOn).toHaveBeenCalledWith({ calendar: null, reminders: "push" });
    expect(screen.getByText("reminders on this phone")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("calendar on opens the provider's subscribe page in a new tab, inside the click", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    let resolve!: () => void;
    const onTurnOn = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const links = {
      google: "https://calendar.google.com/calendar/render?cid=g",
      outlook: "https://outlook.live.com/calendar/0/addfromweb?url=o",
    };
    const { user } = setup({ reminders: "none", subscribeLinks: links, onTurnOn });
    await openSheet(user);
    await user.click(screen.getByRole("button", { name: "Outlook" }));
    await user.click(screen.getByTestId("never-miss-submit"));
    // Opened before the server answered.
    expect(open).toHaveBeenCalledWith(links.outlook, "_blank", "noopener");
    expectLabel("Turning on");
    expect(screen.getAllByTestId("never-miss-fill")[0].dataset.phase).toBe("working");
    resolve();
    await waitFor(() =>
      expect(screen.getByTestId("never-miss-done-title").textContent).toBe("Calendar is on"),
    );
  });

  it("with no link known yet, opens a blank tab and points it at the returned link", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab);
    const onTurnOn = vi.fn(async () => ({ subscribeUrl: "https://calendar.google.com/calendar/render?cid=x" }));
    const { user } = setup({ reminders: "none", onTurnOn });
    await openSheet(user);
    await user.click(screen.getByTestId("never-miss-submit"));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(tab.location.href).toBe("https://calendar.google.com/calendar/render?cid=x"));
    expect(tab.opener).toBeNull();
  });

  it("when saving fails, closes the blank tab and stays open with an error", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab);
    const onTurnOn = vi.fn(async () => {
      throw new Error("nope");
    });
    const { user } = setup({ reminders: "none", onTurnOn });
    await openSheet(user);
    await user.click(screen.getByTestId("never-miss-submit"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That did not work. Try again."));
    expect(tab.close).toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expectLabel("Turn on");
  });

  it("shows the done row instead of the card when something is on already", () => {
    setup({ on: { calendar: "google", reminders: null } });
    expect(screen.queryByTestId("never-miss-card")).toBeNull();
    expect(screen.getByTestId("never-miss-done-title").textContent).toBe("Calendar is on");
  });

  it("doneMeta leaves the count out when there are no dates", () => {
    expect(doneMeta({ calendar: "outlook", reminders: null }, 0)).toBe("Outlook Calendar");
    expect(doneMeta({ calendar: "google", reminders: "push" }, 1)).toBe(
      "1 date in Google Calendar · reminders on this phone",
    );
  });
});

describe("NeverMiss switch knob and motion", () => {
  it("drops the knob's transform transition under reduced motion", async () => {
    const { user } = setup();
    await openSheet(user);
    const sw = screen.getByRole("switch", { name: "Remind me by email" });
    const knob = sw.querySelector("span > span");
    expect(knob).not.toBeNull();
    // jsdom applies no Tailwind or media queries: check the class Tailwind
    // compiles to `@media (prefers-reduced-motion: reduce) { transition-property: none }`.
    expect(knob!.className).toContain("transition-transform");
    expect(knob!.className).toContain("motion-reduce:transition-none");
  });
});
