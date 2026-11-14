import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./sheet";

function stubMatchMedia(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("min-width") ? wide : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function Harness({ locked = false }: { locked?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Behind</button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        locked={locked}
        title="Hand in"
        data-testid="sheet"
      >
        <button type="button">First</button>
        <button type="button" onClick={() => setOpen(false)}>
          Last
        </button>
      </Sheet>
    </div>
  );
}

beforeEach(() => {
  // Instant motion so exits finish at once.
  document.documentElement.dataset.fast = "1";
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

async function openSheet(locked = false) {
  const user = userEvent.setup();
  render(<Harness locked={locked} />);
  const opener = screen.getByRole("button", { name: "Open" });
  await user.click(opener);
  return { user, opener, dialog: screen.getByRole("dialog", { name: "Hand in" }) };
}

describe("Sheet", () => {
  it("opens as a modal dialog with focus inside", async () => {
    const { dialog } = await openSheet();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Escape closes and focus returns to the opener", async () => {
    const { user, opener } = await openSheet();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("scrim tap closes", async () => {
    const { user, opener } = await openSheet();
    await user.click(screen.getByTestId("sheet-scrim"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("locked ignores Escape and scrim", async () => {
    const { user } = await openSheet(true);
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("sheet-scrim"));
    expect(screen.getByRole("dialog", { name: "Hand in" })).toBeTruthy();
  });

  it("focus returns to the opener when closed from inside", async () => {
    const { user, opener } = await openSheet();
    await user.click(screen.getByRole("button", { name: "Last" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("Tab and Shift+Tab wrap inside the sheet", async () => {
    const { user, dialog } = await openSheet();
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("makes everything behind inert while open", async () => {
    const { user, opener } = await openSheet();
    const app = opener.closest("body > div") as HTMLElement;
    expect(app.inert).toBe(true);
    expect(app.getAttribute("aria-hidden")).toBe("true");
    await user.keyboard("{Escape}");
    expect(app.inert).toBe(false);
    expect(app.hasAttribute("aria-hidden")).toBe(false);
  });

  it("is a bottom sheet when narrow and centred when wide", async () => {
    const { dialog } = await openSheet();
    expect(dialog.getAttribute("data-layout")).toBe("bottom");
    cleanup();
    stubMatchMedia(true);
    await act(async () => {
      render(<Harness />);
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog").getAttribute("data-layout")).toBe("centred");
  });
});
