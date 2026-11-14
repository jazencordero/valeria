import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, COMPOSER_PLACEHOLDER } from "./composer";
import { BOUNCE_AFTER_MS, Suggestion } from "./suggestion";

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => stubReducedMotion(false));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

describe("Composer", () => {
  it("shows the placeholder and the send hint", () => {
    render(<Composer onSend={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input.getAttribute("placeholder")).toBe(COMPOSER_PLACEHOLDER);
    expect(COMPOSER_PLACEHOLDER).toBe("Ask or tell me what to do");
    expect(input.getAttribute("enterkeyhint")).toBe("send");
  });

  it("Enter sends the trimmed text once and clears the field", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLInputElement;
    await user.type(input, "  What is asked?  {Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("What is asked?");
    expect(input.value).toBe("");
  });

  it("the send button sends too", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer onSend={onSend} />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Hi");
  });

  it("empty or whitespace text does not send", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "{Enter}");
    await user.type(input, "    {Enter}");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("is disabled while busy: no send by button or Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer busy onSend={onSend} />);
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLInputElement;
    await user.type(input, "Hello{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    // The field keeps her text so she can send it when the reply is done.
    expect(input.value).toBe("Hello");
  });

  it("reports each keystroke", async () => {
    const onInput = vi.fn();
    const user = userEvent.setup();
    render(<Composer onSend={() => {}} onInput={onInput} />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "abc");
    expect(onInput).toHaveBeenCalledTimes(3);
  });
});

describe("Suggestion", () => {
  const chip = (name: string) => screen.queryByRole("button", { name });

  it("tapping the chip sends its label", () => {
    const onSend = vi.fn();
    render(<Suggestion label="What exactly is asked?" onSend={onSend} />);
    fireEvent.click(chip("What exactly is asked?")!);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("What exactly is asked?");
  });

  it("is hidden while busy", () => {
    const { rerender } = render(<Suggestion label="What exactly is asked?" busy onSend={() => {}} />);
    expect(chip("What exactly is asked?")).toBeNull();
    rerender(<Suggestion label="What exactly is asked?" onSend={() => {}} />);
    expect(chip("What exactly is asked?")).not.toBeNull();
  });

  it("bounces once after 4 s of no input, once per label", () => {
    vi.useFakeTimers();
    const onBounce = vi.fn();
    const { rerender } = render(
      <Suggestion label="First step" onSend={() => {}} onBounce={onBounce} />,
    );
    act(() => vi.advanceTimersByTime(BOUNCE_AFTER_MS - 1));
    expect(onBounce).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onBounce).toHaveBeenCalledTimes(1);
    expect(onBounce).toHaveBeenLastCalledWith("First step");
    expect(chip("First step")!.dataset.bounced).toBe("First step");

    // Hide and show the same label: no second bounce.
    rerender(<Suggestion label="First step" busy onSend={() => {}} onBounce={onBounce} />);
    rerender(<Suggestion label="First step" onSend={() => {}} onBounce={onBounce} />);
    act(() => vi.advanceTimersByTime(BOUNCE_AFTER_MS * 2));
    expect(onBounce).toHaveBeenCalledTimes(1);

    // A new label gets its own bounce.
    rerender(<Suggestion label="Next step" onSend={() => {}} onBounce={onBounce} />);
    act(() => vi.advanceTimersByTime(BOUNCE_AFTER_MS));
    expect(onBounce).toHaveBeenCalledTimes(2);
    expect(onBounce).toHaveBeenLastCalledWith("Next step");
  });

  it("typing restarts the 4 s wait", () => {
    vi.useFakeTimers();
    const onBounce = vi.fn();
    const props = { label: "First step", onSend: () => {}, onBounce };
    const { rerender } = render(<Suggestion {...props} lastInput={0} />);
    act(() => vi.advanceTimersByTime(3000));
    rerender(<Suggestion {...props} lastInput={1} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(onBounce).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(onBounce).toHaveBeenCalledTimes(1);
  });

  it("does not bounce when the user prefers reduced motion", () => {
    stubReducedMotion(true);
    vi.useFakeTimers();
    const onBounce = vi.fn();
    render(<Suggestion label="First step" onSend={() => {}} onBounce={onBounce} />);
    act(() => vi.advanceTimersByTime(BOUNCE_AFTER_MS * 3));
    expect(onBounce).not.toHaveBeenCalled();
    expect(chip("First step")!.dataset.bounced).toBeUndefined();
  });
});
