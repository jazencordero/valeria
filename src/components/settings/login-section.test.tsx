import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePasswordState, SetLoginState } from "@/app/(app)/settings/login-actions";
import { LoginNudge, LoginSection, NUDGE_HIDDEN_KEY } from "./login-section";

// Invented names and passwords only.
const PASSWORD = "correct horse";

beforeEach(() => {
  // The Button reads the motion setting; jsdom has no matchMedia.
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noChange = async (): Promise<ChangePasswordState> => ({ error: null, changed: false });
const noSet = async (): Promise<SetLoginState> => ({ error: null, username: "", savedAs: null });

describe("LoginSection", () => {
  it("without a login: the sentence, username, password with a toggle, and Save", () => {
    render(<LoginSection username={null} setLoginAction={noSet} changePasswordAction={noChange} />);
    expect(screen.getByRole("heading", { name: "Log in" })).toBeTruthy();
    expect(screen.getByText("Set a username and password so you can log in on any device.")).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByText("Change password")).toBeNull();
    expect(document.getElementById("log-in")).not.toBeNull();
  });

  it("after a save: 'You can now log in as' and the change-password form", async () => {
    const setLogin = vi.fn(async (_p: SetLoginState, f: FormData): Promise<SetLoginState> => {
      expect(f.get("username")).toBe("Own.Name");
      expect(f.get("password")).toBe(PASSWORD);
      return { error: null, username: "", savedAs: "own.name" };
    });
    render(<LoginSection username={null} setLoginAction={setLogin} changePasswordAction={noChange} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "Own.Name" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    });
    expect(await screen.findByText("You can now log in as own.name.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
    expect(setLogin).toHaveBeenCalledOnce();
  });

  it("shows a refusal in the alert line", async () => {
    const taken = async (): Promise<SetLoginState> => ({
      error: "That username is taken. Pick another one.",
      username: "taken.name",
      savedAs: null,
    });
    render(<LoginSection username={null} setLoginAction={taken} changePasswordAction={noChange} />);
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    });
    expect((await screen.findByRole("alert")).textContent).toBe("That username is taken. Pick another one.");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("taken.name");
  });

  it("with a login: the username and Change password, no new username", async () => {
    const change = vi.fn(async (_p: ChangePasswordState, f: FormData): Promise<ChangePasswordState> => {
      expect(f.get("current")).toBe(PASSWORD);
      expect(f.get("next")).toBe("a new one");
      return { error: null, changed: true };
    });
    render(<LoginSection username="own.name" setLoginAction={noSet} changePasswordAction={change} />);
    expect(screen.getByText("own.name")).toBeTruthy();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a new one" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: "Change password" }).closest("form")!);
    });
    expect(await screen.findByText("Your new password is saved.")).toBeTruthy();
  });
});

describe("LoginNudge", () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });

  it("renders nothing on the server, so a dismissed line never flashes", () => {
    expect(renderToString(<LoginNudge />)).toBe("");
  });

  it("links to the Log in section and hides itself on this device", () => {
    const { unmount } = render(<LoginNudge />);
    const link = screen.getByRole("link", { name: "Set a username and password so you can get back in." });
    expect(link.getAttribute("href")).toBe("/settings#log-in");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("link")).toBeNull();
    expect(window.localStorage.getItem(NUDGE_HIDDEN_KEY)).toBe("1");
    unmount();
    render(<LoginNudge />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
