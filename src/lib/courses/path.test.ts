import { describe, expect, it } from "vitest";
import {
  curveLength,
  curvePath,
  doneFraction,
  fmt,
  pathGeom,
  type PathLecture,
  type PathLectureState,
} from "./path";

// Expected numbers below are worked out by hand from the rules, not by
// calling the code:
//   wide:  centre 96, offset 40 -> stops at x 56 (even index) / 136 (odd)
//   phone: centre 54, offset 16 -> stops at x 38 / 70
//   first stop y 84; then +128 (or +164 when a flag follows),
//   +22 when the next stop is current, +14 after the current stop.
//   flag y = stop y + 82, finish y = next y - 20, height = finish y + 56.

const lec = (...st: PathLectureState[]): PathLecture[] =>
  st.map((s, i) => ({ n: i + 1, st: s }));

const xy = (g: { pts: { x: number; y: number }[] }) =>
  g.pts.map((p) => [p.x, p.y]);

describe("pathGeom: 1 lecture", () => {
  it("wide, current, no flags", () => {
    const g = pathGeom(lec("cur"), [], true);
    // 84 + 128 + 14 = 226 -> finish 206, height 262
    expect(xy(g)).toEqual([[56, 84]]);
    expect(g.flags).toEqual([]);
    expect(g.fin).toEqual({ x: 96, y: 206 });
    expect(g.h).toBe(262);
    expect(g.cx).toBe(96);
    expect(g.lx).toBe(196);
  });

  it("phone, current, no flags", () => {
    const g = pathGeom(lec("cur"), [], false);
    expect(xy(g)).toEqual([[38, 84]]);
    expect(g.fin).toEqual({ x: 54, y: 206 });
    expect(g.h).toBe(262);
    expect(g.cx).toBe(54);
    expect(g.lx).toBe(112);
  });

  it("wide, done, flag after it", () => {
    const flag = { after: 1, id: "a1" };
    const g = pathGeom(lec("done"), [flag], true);
    // 84 + 164 = 248 -> finish 228, height 284; flag at 84 + 82 = 166
    expect(xy(g)).toEqual([[56, 84]]);
    expect(g.flags).toEqual([{ x: 96, y: 166, f: flag }]);
    expect(g.fin).toEqual({ x: 96, y: 228 });
    expect(g.h).toBe(284);
  });

  it("phone, done, flag after it", () => {
    const g = pathGeom(lec("done"), [{ after: 1 }], false);
    expect(xy(g)).toEqual([[38, 84]]);
    expect(g.flags.map((f) => [f.x, f.y])).toEqual([[54, 166]]);
    expect(g.fin).toEqual({ x: 54, y: 228 });
    expect(g.h).toBe(284);
  });
});

describe("pathGeom: 5 lectures (done, done, cur, up, soon)", () => {
  const five = lec("done", "done", "cur", "up", "soon");

  it("wide, no flags", () => {
    const g = pathGeom(five, [], true);
    // 84; +128 = 212; +128+22 = 362; +128+14 = 504; +128 = 632; +128 = 760
    expect(xy(g)).toEqual([
      [56, 84],
      [136, 212],
      [56, 362],
      [136, 504],
      [56, 632],
    ]);
    expect(g.flags).toEqual([]);
    expect(g.fin).toEqual({ x: 96, y: 740 });
    expect(g.h).toBe(796);
  });

  it("phone, no flags", () => {
    const g = pathGeom(five, [], false);
    expect(xy(g)).toEqual([
      [38, 84],
      [70, 212],
      [38, 362],
      [70, 504],
      [38, 632],
    ]);
    expect(g.fin).toEqual({ x: 54, y: 740 });
    expect(g.h).toBe(796);
  });

  it("wide, flags after 2 and 4 (a second flag on 2 and one on a missing lecture are ignored)", () => {
    const f2 = { after: 2, id: "a" };
    const f4 = { after: 4, id: "b" };
    const g = pathGeom(five, [f2, { after: 2, id: "dup" }, f4, { after: 9, id: "x" }], true);
    // 84; +128 = 212; flag 294, +164+22 = 398 (cur); +128+14 = 540;
    // flag 622, +164 = 704; +128 = 832 -> finish 812, height 868
    expect(xy(g)).toEqual([
      [56, 84],
      [136, 212],
      [56, 398],
      [136, 540],
      [56, 704],
    ]);
    expect(g.flags).toEqual([
      { x: 96, y: 294, f: f2 },
      { x: 96, y: 622, f: f4 },
    ]);
    expect(g.fin).toEqual({ x: 96, y: 812 });
    expect(g.h).toBe(868);
  });

  it("phone, flags after 2 and 4", () => {
    const g = pathGeom(five, [{ after: 2 }, { after: 4 }], false);
    expect(xy(g)).toEqual([
      [38, 84],
      [70, 212],
      [38, 398],
      [70, 540],
      [38, 704],
    ]);
    expect(g.flags.map((f) => [f.x, f.y])).toEqual([
      [54, 294],
      [54, 622],
    ]);
    expect(g.fin).toEqual({ x: 54, y: 812 });
    expect(g.h).toBe(868);
  });
});

describe("pathGeom: 8 lectures (4 done, cur, up, soon, soon)", () => {
  const eight = lec("done", "done", "done", "done", "cur", "up", "soon", "soon");

  it("phone, no flags", () => {
    const g = pathGeom(eight, [], false);
    // 84, 212, 340, 468; +128+22 = 618 (cur); +142 = 760; 888; 1016; +128 = 1144
    expect(xy(g)).toEqual([
      [38, 84],
      [70, 212],
      [38, 340],
      [70, 468],
      [38, 618],
      [70, 760],
      [38, 888],
      [70, 1016],
    ]);
    expect(g.fin).toEqual({ x: 54, y: 1124 });
    expect(g.h).toBe(1180);
  });

  it("wide, no flags", () => {
    const g = pathGeom(eight, [], true);
    expect(xy(g)).toEqual([
      [56, 84],
      [136, 212],
      [56, 340],
      [136, 468],
      [56, 618],
      [136, 760],
      [56, 888],
      [136, 1016],
    ]);
    expect(g.fin).toEqual({ x: 96, y: 1124 });
    expect(g.h).toBe(1180);
  });

  it("wide, flags after 1, 4 and 8", () => {
    const g = pathGeom(eight, [{ after: 1 }, { after: 4 }, { after: 8 }], true);
    // 84 (flag 166), +164 = 248; 376; 504 (flag 586), +164+22 = 690 (cur);
    // +142 = 832; 960; 1088 (flag 1170), +164 = 1252 -> finish 1232, height 1288
    expect(xy(g)).toEqual([
      [56, 84],
      [136, 248],
      [56, 376],
      [136, 504],
      [56, 690],
      [136, 832],
      [56, 960],
      [136, 1088],
    ]);
    expect(g.flags.map((f) => [f.x, f.y])).toEqual([
      [96, 166],
      [96, 586],
      [96, 1170],
    ]);
    expect(g.fin).toEqual({ x: 96, y: 1232 });
    expect(g.h).toBe(1288);
  });

  it("phone, flags after 1, 4 and 8", () => {
    const g = pathGeom(eight, [{ after: 1 }, { after: 4 }, { after: 8 }], false);
    expect(xy(g).map((p) => p[0])).toEqual([38, 70, 38, 70, 38, 70, 38, 70]);
    expect(xy(g).map((p) => p[1])).toEqual([84, 248, 376, 504, 690, 832, 960, 1088]);
    expect(g.flags.map((f) => [f.x, f.y])).toEqual([
      [54, 166],
      [54, 586],
      [54, 1170],
    ]);
    expect(g.fin).toEqual({ x: 54, y: 1232 });
    expect(g.h).toBe(1288);
  });

  it("all done (no current stop) spaces every stop 128 apart", () => {
    const g = pathGeom(lec("done", "done", "done", "done", "done", "done", "done", "done"), [], true);
    expect(xy(g).map((p) => p[1])).toEqual([84, 212, 340, 468, 596, 724, 852, 980]);
    // 980 + 128 - 20 = 1088, + 56 = 1144
    expect(g.fin).toEqual({ x: 96, y: 1088 });
    expect(g.h).toBe(1144);
  });
});

describe("pathGeom: no lectures", () => {
  it("puts the finish just under the top", () => {
    const g = pathGeom([], [], true);
    expect(g.pts).toEqual([]);
    expect(g.fin).toEqual({ x: 96, y: 64 });
    expect(g.h).toBe(120);
  });
});

describe("curvePath", () => {
  it("one stop to the finish: vertical tangents at both ends", () => {
    // (56,84) -> (96,206): half gap 61 -> controls at y 145
    expect(curvePath([{ x: 56, y: 84 }, { x: 96, y: 206 }])).toBe(
      "M56 84 C56 145 96 145 96 206",
    );
  });

  it("two curves", () => {
    expect(
      curvePath([
        { x: 56, y: 84 },
        { x: 136, y: 212 },
        { x: 56, y: 362 },
      ]),
    ).toBe("M56 84 C56 148 136 148 136 212 C136 287 56 287 56 362");
  });

  it("whole course line starts at the first stop and ends at the finish", () => {
    const g = pathGeom(lec("done", "done", "cur", "up", "soon"), [], true);
    const d = curvePath([...g.pts, g.fin]);
    expect(d.startsWith("M56 84 C")).toBe(true);
    expect(d.endsWith(" 96 740")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(5);
  });

  it("phone line with flags ends at the finish too", () => {
    const g = pathGeom(lec("done", "cur", "up"), [{ after: 1 }], false);
    // 84 (flag), +164+22 = 270 (cur), +142 = 412, +128 = 540 -> finish 520
    const d = curvePath([...g.pts, g.fin]);
    expect(d.startsWith("M38 84 C")).toBe(true);
    expect(d.endsWith(" 54 520")).toBe(true);
  });

  it("a single point is just the move", () => {
    expect(curvePath([{ x: 56, y: 84 }])).toBe("M56 84");
    expect(curvePath([])).toBe("");
  });

  it("rounds to 2 decimals and drops trailing zeros", () => {
    expect(curvePath([{ x: 0, y: 0 }, { x: 1 / 3, y: 1 }])).toBe(
      "M0 0 C0 0.5 0.33 0.5 0.33 1",
    );
    expect(fmt(12.5)).toBe("12.5");
    expect(fmt(2.005 + 1e-9)).toBe("2.01");
    expect(fmt(-0.001)).toBe("0");
  });
});

describe("doneFraction", () => {
  // Four mirror-image curves of the same length.
  const even = [
    { x: 56, y: 84 },
    { x: 136, y: 212 },
    { x: 56, y: 340 },
    { x: 136, y: 468 },
    { x: 56, y: 596 },
  ];

  it("is 0 at the first stop", () => {
    expect(doneFraction(even, 0)).toBe(0);
  });

  it("is half way at the middle stop", () => {
    expect(doneFraction(even, 2)).toBeCloseTo(0.5, 10);
    expect(doneFraction(even, 1)).toBeCloseTo(0.25, 10);
  });

  it("is 1 at the last point", () => {
    expect(doneFraction(even, 4)).toBe(1);
    expect(doneFraction(even, 99)).toBe(1);
  });

  it("is 0 when there is no line", () => {
    expect(doneFraction([], 0)).toBe(0);
    expect(doneFraction([{ x: 1, y: 2 }], 0)).toBe(0);
  });

  it("straight vertical line: length is the gap", () => {
    expect(curveLength([{ x: 96, y: 0 }, { x: 96, y: 128 }])).toBeCloseTo(128, 6);
    // 0 -> 100 -> 400 on one line: a quarter done at index 1
    expect(
      doneFraction(
        [
          { x: 96, y: 0 },
          { x: 96, y: 100 },
          { x: 96, y: 400 },
        ],
        1,
      ),
    ).toBeCloseTo(0.25, 6);
  });

  it("course line with the finish: increases stop by stop up to 1", () => {
    const g = pathGeom(lec("done", "done", "cur", "up", "soon"), [], true);
    const all = [...g.pts, g.fin];
    const fr = all.map((_, i) => doneFraction(all, i));
    expect(fr[0]).toBe(0);
    expect(fr[all.length - 1]).toBe(1);
    for (let i = 1; i < fr.length; i++) expect(fr[i]).toBeGreaterThan(fr[i - 1]);
  });
});
