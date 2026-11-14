import { describe, expect, it } from "vitest";
import { wantsFast } from "./fast";
import { duration, rewardSpring } from "./tokens";
import { presets, type MotionPreset } from "./transitions";

const TRANSFORM_KEYS = ["x", "y", "z", "scale", "scaleX", "scaleY", "rotate", "transform"];

function targets(p: MotionPreset): object[] {
  const list: unknown[] = [p.initial, p.animate, p.exit];
  return list.filter(
    (t): t is object => typeof t === "object" && t !== null,
  );
}

describe("motion presets", () => {
  for (const [name, preset] of Object.entries(presets)) {
    describe(name, () => {
      it("calm version has no transform and lasts 150 ms", () => {
        for (const calm of [preset(true), preset("calm")]) {
          for (const t of targets(calm)) {
            expect(Object.keys(t)).toEqual(["opacity"]);
            for (const key of TRANSFORM_KEYS) expect(t).not.toHaveProperty(key);
          }
          expect(calm.transition).toMatchObject({ duration: 0.15 });
          expect(calm.transition).not.toHaveProperty("type");
        }
      });

      it("instant version is opacity-only with duration 0", () => {
        const instant = preset("instant");
        for (const t of targets(instant)) expect(Object.keys(t)).toEqual(["opacity"]);
        expect(instant.transition).toMatchObject({ duration: 0 });
      });

      it("full version moves something besides opacity", () => {
        const full = preset(false);
        expect(full).toEqual(preset("full"));
        if (name === "fade") {
          expect(full.transition).toMatchObject({ duration: duration.quick });
        } else {
          expect(Object.keys(full.initial as object).length).toBeGreaterThan(1);
        }
      });
    });
  }

  it("pop uses the reward spring", () => {
    expect(presets.pop().transition).toMatchObject({ scale: rewardSpring });
    expect(rewardSpring).toEqual({ type: "spring", bounce: 0.25, visualDuration: 0.4 });
  });
});

describe("motion fast switch", () => {
  it("turns on for ?fast=1 or the READY_FAST cookie", () => {
    expect(wantsFast("?fast=1", "")).toBe(true);
    expect(wantsFast("?a=2&fast=1", "")).toBe(true);
    expect(wantsFast("", "theme=dark; READY_FAST=1")).toBe(true);
    expect(wantsFast("", "READY_FAST")).toBe(true);
  });

  it("stays off otherwise", () => {
    expect(wantsFast("", "")).toBe(false);
    expect(wantsFast("?fast=0", "NOT_READY_FAST=1")).toBe(false);
  });
});
