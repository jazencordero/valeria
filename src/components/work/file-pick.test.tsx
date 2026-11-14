import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePick, OUR_MAX_BYTES, formatBytes } from "./file-pick";

const MB = 1024 * 1024;
const LMS_URL = "https://lms.example.edu/mod/assign/view.php?id=101";

function fakeFile(name: string, size: number, type = "application/pdf") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function setup(props: Partial<React.ComponentProps<typeof FilePick>> = {}) {
  const onChange = vi.fn();
  render(<FilePick lms="MyCourses" lmsUrl={LMS_URL} onChange={onChange} {...props} />);
  const input = screen.getByTestId("file-pick-input") as HTMLInputElement;
  return { onChange, input, user: userEvent.setup() };
}

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FilePick", () => {
  it("takes a good file, shows its name and size and gives it to the parent", async () => {
    const { onChange, input, user } = setup({ maxBytes: 20 * MB });
    const file = fakeFile("Essay draft.pdf", Math.round(1.25 * MB));
    await user.upload(input, file);

    expect(onChange).toHaveBeenCalledWith(file);
    expect(screen.getByTestId("file-pick-name").textContent).toBe("Essay draft.pdf");
    expect(screen.getByTestId("file-pick-size").textContent).toBe("1.3 MB");
    expect(screen.queryByTestId("file-pick-problem")).toBeNull();
    expect(screen.queryByRole("button", { name: /choose file/i })).toBeNull();
  });

  it("refuses a file over our 4 MB limit that the LMS takes, and links to the LMS", async () => {
    const { onChange, input, user } = setup({ maxBytes: 50 * MB });
    await user.upload(input, fakeFile("Slides.pptx", 9 * MB));

    expect(onChange).not.toHaveBeenCalled();
    const line = screen.getByRole("alert");
    expect(line.textContent).toBe(
      "That file is 9 MB. MyCourses takes it, we cannot yet. Hand this one in on MyCourses.",
    );
    const link = screen.getByRole("link", { name: "Hand this one in on MyCourses." });
    expect(link.getAttribute("href")).toBe(LMS_URL);
    expect(screen.getByRole("button", { name: /choose file/i })).toBeTruthy();
  });

  it("uses the LMS name it is given", async () => {
    const { input, user } = setup({ lms: "Moodle" });
    await user.upload(input, fakeFile("Big.zip", 6 * MB));
    expect(screen.getByRole("alert").textContent).toContain("Moodle takes it, we cannot yet.");
    expect(screen.getByRole("alert").textContent).not.toContain("MyCourses");
  });

  it("refuses a file over the assignment's own limit", async () => {
    const { onChange, input, user } = setup({ maxBytes: 2 * MB });
    await user.upload(input, fakeFile("Report.docx", 3 * MB));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "That file is 3 MB. This assignment takes up to 2 MB. Make it smaller, or pick another file.",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("refuses more files than the assignment accepts", () => {
    const { onChange } = setup();
    fireEvent.drop(screen.getByTestId("file-pick-drop"), {
      dataTransfer: { files: [fakeFile("a.pdf", 1000), fakeFile("b.pdf", 1000)] },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "That is two files. This assignment takes one file. Pick the one to hand in.",
    );
  });

  it("takes one dropped file", () => {
    const { onChange } = setup();
    const file = fakeFile("Lab notes.pdf", 2048);
    fireEvent.drop(screen.getByTestId("file-pick-drop"), { dataTransfer: { files: [file] } });
    expect(onChange).toHaveBeenCalledWith(file);
    expect(screen.getByTestId("file-pick-size").textContent).toBe("2 KB");
  });

  it("removes the file, tells the parent and brings back Choose file", async () => {
    const { onChange, input, user } = setup();
    await user.upload(input, fakeFile("Essay.pdf", 500 * 1024));
    await user.click(screen.getByRole("button", { name: "Remove Essay.pdf" }));

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("file-pick-name")).toBeNull();
    expect(screen.getByRole("button", { name: /choose file/i })).toBeTruthy();
  });

  it("opens the picker from the Choose file button with the keyboard", async () => {
    const { input, user } = setup();
    const click = vi.spyOn(input, "click");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /choose file/i }));
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("formats sizes and rounds up near a limit", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(OUR_MAX_BYTES + 1)).toBe("4.1 MB");
    expect(formatBytes(12.2 * MB)).toBe("13 MB");
  });
});
