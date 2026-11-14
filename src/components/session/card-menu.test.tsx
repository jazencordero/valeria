import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Server Action's collaborators; the component tests inject their own action.
vi.mock("@/server/auth/session", () => {
  class NotSignedIn extends Error {}
  return { currentUser: vi.fn(), NotSignedIn };
});
vi.mock("@/server/study/store", () => {
  class StudyNotFound extends Error {}
  return { flagCard: vi.fn(), StudyNotFound };
});

import { dropCard, type DropResult } from "@/app/(app)/study/card-actions";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { flagCard, StudyNotFound } from "@/server/study/store";
import { CardMenu, DROP_ERROR_TEXT } from "./card-menu";

// Made-up id for tests only.
const CARD = "0b6c3a52-7a7e-4d7b-9a51-0d2b8c1f4e11";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(action = vi.fn(async (cardId: string, kind: "flagged" | "suspended"): Promise<DropResult> => ({ ok: true, cardId, kind }))) {
  const onDrop = vi.fn();
  const user = userEvent.setup();
  render(<CardMenu cardId={CARD} onDrop={onDrop} action={action} />);
  return { action, onDrop, user, button: screen.getByRole("button", { name: "Card options" }) };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CardMenu", () => {
  it("is a closed menu button to start with", () => {
    const { button } = setup();
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("flagging calls the action once, even on a double click, and tells the session to drop the card", async () => {
    const pending = deferred<DropResult>();
    const action = vi.fn(() => pending.promise);
    const { onDrop, user, button } = setup(action);

    await user.click(button);
    const wrong = screen.getByRole("menuitem", { name: "This card is wrong" });
    await user.dblClick(wrong);
    await user.click(wrong);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(CARD, "flagged");
    expect(onDrop).not.toHaveBeenCalled();

    pending.resolve({ ok: true, cardId: CARD, kind: "flagged" });
    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop).toHaveBeenCalledWith(CARD, "flagged");
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("skip calls the action with suspended", async () => {
    const { action, onDrop, user, button } = setup();
    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "Skip this card for now" }));
    await waitFor(() => expect(onDrop).toHaveBeenCalledWith(CARD, "suspended"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(CARD, "suspended");
  });

  it("a refused action keeps the card and shows a plain error line", async () => {
    const action = vi.fn(async (): Promise<DropResult> => ({ ok: false, reason: "not_found" }));
    const { onDrop, user, button } = setup(action);
    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "This card is wrong" }));
    expect((await screen.findByRole("alert")).textContent).toBe(DROP_ERROR_TEXT);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("a thrown action (network) keeps the card and shows the error; a retry can go again", async () => {
    const action = vi
      .fn<(id: string, kind: "flagged" | "suspended") => Promise<DropResult>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, cardId: CARD, kind: "flagged" });
    const { onDrop, user, button } = setup(action);
    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "This card is wrong" }));
    expect((await screen.findByRole("alert")).textContent).toBe(DROP_ERROR_TEXT);
    expect(onDrop).not.toHaveBeenCalled();

    await user.click(button);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "This card is wrong" }));
    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledTimes(2);
  });

  describe("keyboard", () => {
    it("Enter opens on the first item, arrows move and wrap, Escape closes and returns focus", async () => {
      const { user, button } = setup();
      button.focus();
      await user.keyboard("{Enter}");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      const [wrong, skip] = screen.getAllByRole("menuitem");
      expect(document.activeElement).toBe(wrong);

      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(skip);
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(wrong);
      await user.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(skip);
      await user.keyboard("{Home}");
      expect(document.activeElement).toBe(wrong);
      await user.keyboard("{End}");
      expect(document.activeElement).toBe(skip);

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
    });

    it("Space and ArrowDown open it too; ArrowUp opens on the last item", async () => {
      const { user, button } = setup();
      button.focus();
      await user.keyboard(" ");
      expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
      await user.keyboard("{Escape}");

      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
      await user.keyboard("{Escape}");

      await user.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
    });

    it("Escape in the menu does not reach the session's own Escape handler", async () => {
      // The session frame listens on document and skips default-prevented keys.
      const seen: boolean[] = [];
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") seen.push(e.defaultPrevented);
      };
      document.addEventListener("keydown", onKey);
      try {
        const { user, button } = setup();
        await user.click(button);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).toBeNull();
        expect(seen.every((prevented) => prevented)).toBe(true);
      } finally {
        document.removeEventListener("keydown", onKey);
      }
    });

    it("Enter on an item picks it", async () => {
      const { action, onDrop, user, button } = setup();
      button.focus();
      await user.keyboard("{Enter}{ArrowDown}{Enter}");
      await waitFor(() => expect(onDrop).toHaveBeenCalledWith(CARD, "suspended"));
      expect(action).toHaveBeenCalledTimes(1);
    });
  });
});

describe("dropCard (Server Action)", () => {
  beforeEach(() => {
    vi.mocked(currentUser).mockResolvedValue({ id: "user-a" } as Awaited<ReturnType<typeof currentUser>>);
    vi.mocked(flagCard).mockResolvedValue(undefined);
  });

  it("flags or suspends her card through flagCard, scoped to the signed-in user", async () => {
    expect(await dropCard(CARD, "flagged")).toEqual({ ok: true, cardId: CARD, kind: "flagged" });
    expect(flagCard).toHaveBeenLastCalledWith("user-a", CARD, "flagged");
    expect(await dropCard(CARD, "suspended")).toEqual({ ok: true, cardId: CARD, kind: "suspended" });
    expect(flagCard).toHaveBeenLastCalledWith("user-a", CARD, "suspended");
  });

  it("refuses bad input before touching the session or the store", async () => {
    for (const [id, kind] of [
      ["not-a-uuid", "flagged"],
      [CARD, "active"],
      [CARD, undefined],
      [42, "flagged"],
    ] as const) {
      expect(await dropCard(id, kind)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(currentUser).not.toHaveBeenCalled();
    expect(flagCard).not.toHaveBeenCalled();
  });

  it("reads another user's or a missing card as not_found", async () => {
    vi.mocked(flagCard).mockRejectedValue(new StudyNotFound("card", CARD));
    expect(await dropCard(CARD, "flagged")).toEqual({ ok: false, reason: "not_found" });
  });

  it("answers signed_out without a session", async () => {
    vi.mocked(currentUser).mockRejectedValue(new NotSignedIn());
    expect(await dropCard(CARD, "flagged")).toEqual({ ok: false, reason: "signed_out" });
    expect(flagCard).not.toHaveBeenCalled();
  });
});
