// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { flagOn, handinEnabled, handinPausedMessage } from "./flags";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handinEnabled", () => {
  it("is on when HANDIN_ENABLED is unset or empty", () => {
    vi.stubEnv("HANDIN_ENABLED", undefined);
    expect(handinEnabled()).toBe(true);
    vi.stubEnv("HANDIN_ENABLED", "");
    expect(handinEnabled()).toBe(true);
    vi.stubEnv("HANDIN_ENABLED", "   ");
    expect(handinEnabled()).toBe(true);
  });

  it("is off for 0, false, off and no, in any case and with spaces", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off ", "No\n"]) {
      vi.stubEnv("HANDIN_ENABLED", v);
      expect(handinEnabled(), v).toBe(false);
    }
  });

  it("is on for anything else", () => {
    for (const v of ["1", "true", "on", "yes", "ON", "nope", "disabled"]) {
      vi.stubEnv("HANDIN_ENABLED", v);
      expect(handinEnabled(), v).toBe(true);
    }
  });

  it("reads the value on every call, so a change takes effect without a restart of the module", () => {
    vi.stubEnv("HANDIN_ENABLED", "off");
    expect(handinEnabled()).toBe(false);
    vi.stubEnv("HANDIN_ENABLED", "on");
    expect(handinEnabled()).toBe(true);
  });
});

describe("flagOn", () => {
  it("uses the fallback only when unset or blank", () => {
    expect(flagOn(undefined, false)).toBe(false);
    expect(flagOn("", false)).toBe(false);
    expect(flagOn("yes", false)).toBe(true);
    expect(flagOn("no", true)).toBe(false);
  });
});

describe("handinPausedMessage", () => {
  it("names the LMS", () => {
    expect(handinPausedMessage("MyCourses")).toBe("Hand-in from Ready is paused. Hand this one in on MyCourses.");
  });
});
