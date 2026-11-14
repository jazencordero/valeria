import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHOOL,
  SCHOOLS,
  SCHOOL_IDS,
  allowedSiteUrls,
  canConnect,
  isSchoolId,
  lmsNameOf,
  schoolIdOf,
  schoolOf,
} from "./schools";

describe("SCHOOLS", () => {
  it("lists Aalto and LUT with the ticket's exact words", () => {
    expect(SCHOOLS).toEqual({
      aalto: {
        name: "Aalto",
        full: "Aalto University",
        where: "Espoo",
        lms: "MyCourses",
        article: "an",
        quip: "Aalto. Ambitious. I respect it.",
        siteUrl: "https://mycourses.aalto.fi",
        enabled: true,
      },
      lut: {
        name: "LUT",
        full: "LUT University",
        where: "Lappeenranta and Lahti",
        lms: "Moodle",
        article: "a",
        quip: "LUT. Lakes, saunas and group work. Nice.",
        siteUrl: null,
        enabled: false,
      },
    });
    expect(SCHOOL_IDS).toEqual(["aalto", "lut"]);
  });

  it("gives every site as https with no trailing slash", () => {
    for (const id of SCHOOL_IDS) {
      const site: string | null = SCHOOLS[id].siteUrl;
      if (site === null) continue;
      expect(site).toMatch(/^https:\/\/[^/]+$/);
    }
  });
});

describe("schoolOf", () => {
  it("returns her school with its id", () => {
    expect(schoolOf({ school: "lut" })).toEqual({ id: "lut", ...SCHOOLS.lut });
    expect(schoolOf({ school: "aalto" })).toEqual({ id: "aalto", ...SCHOOLS.aalto });
  });

  it("answers Aalto when the school is missing or unknown", () => {
    expect(DEFAULT_SCHOOL).toBe("aalto");
    for (const user of [null, undefined, {}, { school: null }, { school: "" }, { school: "hogwarts" }, { school: "toString" }]) {
      expect(schoolIdOf(user)).toBe("aalto");
      expect(schoolOf(user).id).toBe("aalto");
    }
  });
});

describe("lmsNameOf", () => {
  it("names her school's Moodle, so LUT never sees MyCourses", () => {
    expect(lmsNameOf({ school: "aalto" })).toBe("MyCourses");
    expect(lmsNameOf({ school: "lut" })).toBe("Moodle");
    expect(lmsNameOf(null)).toBe("MyCourses");
  });
});

describe("isSchoolId", () => {
  it("accepts only our keys", () => {
    expect(isSchoolId("aalto")).toBe(true);
    expect(isSchoolId("lut")).toBe(true);
    expect(isSchoolId("Aalto")).toBe(false);
    expect(isSchoolId("constructor")).toBe(false);
    expect(isSchoolId(1)).toBe(false);
  });
});

describe("connecting", () => {
  it("keeps LUT disabled and out of the allowed sites until M8-18", () => {
    expect(SCHOOLS.lut.enabled).toBe(false);
    expect(canConnect("lut")).toBe(false);
    expect(canConnect("aalto")).toBe(true);
    expect(allowedSiteUrls()).toEqual(["https://mycourses.aalto.fi"]);
  });
});
