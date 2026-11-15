import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M3-57: an account seeded from files has no Moodle connection; the hand-in becomes a way to connect.
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn() }) }));
vi.mock("@/app/(app)/assignments/[id]/actions", () => ({ confirmHandinAction: vi.fn(), prepareHandinAction: vi.fn() }));

const { Workspace } = await import("./workspace");

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function workspace(props: { connected?: boolean; acceptsFiles?: boolean; aiAssignments?: "off" | "allowed" }) {
  return render(
    <Workspace
      id="00000000-0000-4000-8000-000000000001"
      title="Invented exercise"
      courseName="Invented course"
      dueAt={new Date("2026-11-20T21:59:00Z")}
      handedInAt={null}
      brief={null}
      files={[]}
      acceptsFiles={props.acceptsFiles ?? false}
      maxBytes={null}
      maxFiles={null}
      lms="Invented LMS"
      lmsUrl="https://moodle.example.test/course/view.php?id=1"
      connected={props.connected}
      aiAssignments={props.aiAssignments ?? "off"}
      setPolicy={async (policy) => ({ ok: true, policy })}
      messages={[]}
      draft={null}
      now={new Date("2026-11-15T10:00:00Z")}
    />,
  );
}

describe("Workspace without a Moodle connection", () => {
  it("shows Connect <LMS> to hand in where the hand-in would be, linking to /connect", () => {
    workspace({ connected: false, acceptsFiles: true });
    const link = screen.getByRole("link", { name: "Connect Invented LMS to hand in" });
    expect(link.getAttribute("href")).toBe("/connect");
    expect(screen.queryByTestId("handin-open")).toBeNull();
  });

  it("does so also when the assignment takes no files here", () => {
    workspace({ connected: false, acceptsFiles: false });
    expect(screen.getByRole("link", { name: "Connect Invented LMS to hand in" })).toBeTruthy();
    expect(screen.queryByText(/does not take files here/)).toBeNull();
  });

  it("offers it under the chat too, instead of Hand in my own file", () => {
    workspace({ connected: false, acceptsFiles: true, aiAssignments: "allowed" });
    expect(screen.getByRole("link", { name: "Connect Invented LMS to hand in" }).getAttribute("href")).toBe("/connect");
    expect(screen.queryByText("Hand in my own file instead")).toBeNull();
  });

  it("is unchanged with a connection", () => {
    workspace({ acceptsFiles: true });
    expect(screen.queryByText(/Connect Invented LMS/)).toBeNull();
    expect(screen.getByTestId("handin-open")).toBeTruthy();
  });
});
