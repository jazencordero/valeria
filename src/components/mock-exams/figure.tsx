/*
 * Mock exams (M3-60): a figure from the exam file drawn as inline SVG (no image files).
 * Ported from the approved mock's renderer: grid on the ticks, a framed plot area, axis labels,
 * points as dots / stars / open triangles, lines solid or dashed (optionally dotted), labels with
 * a halo, an optional horizontal line, and a legend under the plot.
 *
 * Every colour is a token (ink, accent, due, surface, line), so it reads in light and dark. The
 * view box is 360 wide and the text 13 px in it, so at 390 px on a phone the text is still about
 * 12 px. The SVG carries the file's `alt` as its title; the legend is aria-hidden (the alt says it).
 */
import { useId } from "react";
import type { Figure } from "@/lib/mock-exams/types";
import { num } from "./format";

const SERIES = ["var(--ink)", "var(--accent)", "var(--due)"];

function Marker({ kind, x, y, color, k = 1 }: { kind: string; x: number; y: number; color: string; k?: number }) {
  if (kind === "star") {
    const r = 4.2 * k;
    let d = "";
    for (let a = 0; a < 3; a++) {
      const t = (a * Math.PI) / 3 + Math.PI / 2;
      const dx = Math.cos(t) * r;
      const dy = Math.sin(t) * r;
      d += `M${(x - dx).toFixed(1)} ${(y - dy).toFixed(1)}L${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}`;
    }
    return (
      <path
        d={d}
        style={{ stroke: color, strokeWidth: 1.6 * Math.min(k, 1.3), strokeLinecap: "round", fill: "none" }}
      />
    );
  }
  if (kind === "triangle") {
    const r = 4.6 * k;
    return (
      <polygon
        points={`${x.toFixed(1)},${(y - r).toFixed(1)} ${(x + r * 0.9).toFixed(1)},${(y + r * 0.6).toFixed(1)} ${(x - r * 0.9).toFixed(1)},${(y + r * 0.6).toFixed(1)}`}
        style={{ fill: "var(--surface)", stroke: color, strokeWidth: 1.5, strokeLinejoin: "round" }}
      />
    );
  }
  return <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r={(3.2 * k).toFixed(1)} style={{ fill: color }} />;
}

export function ExamFigure({ figure: fg }: { figure: Figure }) {
  const uid = useId().replace(/:/g, "");
  const sq = !!fg.square;
  const m = { l: 40, r: 14, t: 30, b: 44 };
  const W = 360;
  const pw = W - m.l - m.r;
  const ph = sq ? pw : 196;
  const H = m.t + ph + m.b;
  const X = (v: number) => m.l + ((v - fg.x.min) / (fg.x.max - fg.x.min)) * pw;
  const Y = (v: number) => m.t + ph - ((v - fg.y.min) / (fg.y.max - fg.y.min)) * ph;
  const hasPts = !!fg.points?.length;
  const lineColor = (i: number) => (hasPts ? (i === 0 ? "var(--ink-2)" : "var(--ink-3)") : SERIES[i % SERIES.length]);
  const legend = [
    ...(fg.points ?? []).map((s, i) => (
      <span key={`p${i}`} className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <Marker kind={s.marker} x={7} y={7.5} color={SERIES[i % SERIES.length]} k={1.2} />
        </svg>
        {s.series}
      </span>
    )),
    ...(fg.lines ?? []).map((ln, i) => {
      const c = lineColor(i);
      const dashed = ln.style === "dashed";
      return (
        <span key={`l${i}`} className="inline-flex items-center gap-1.5">
          <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
            <path d="M1 6H25" style={{ stroke: c, strokeWidth: 2, strokeDasharray: dashed ? "5 3" : undefined }} />
            {ln.dots ? (
              dashed ? (
                <circle cx="13" cy="6" r="3.2" style={{ fill: "var(--surface)", stroke: c, strokeWidth: 1.6 }} />
              ) : (
                <circle cx="13" cy="6" r="3.2" style={{ fill: c }} />
              )
            ) : null}
          </svg>
          {ln.label}
        </span>
      );
    }),
  ];

  return (
    <figure className="mx-auto my-4 w-full" style={{ maxWidth: sq ? 420 : 560 }} data-testid="exam-figure">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full fill-ink-2 font-sans"
        role="img"
        aria-labelledby={`${uid}-t`}
      >
        <title id={`${uid}-t`}>{fg.alt}</title>
        <defs>
          <clipPath id={`${uid}-c`}>
            <rect x={m.l - 7} y={m.t - 7} width={pw + 14} height={ph + 14} />
          </clipPath>
        </defs>
        <g aria-hidden="true">
          {fg.x.ticks.map((t) => (
            <line key={`gx${t}`} x1={X(t)} x2={X(t)} y1={m.t} y2={m.t + ph} style={{ stroke: "var(--line)", strokeWidth: 1 }} />
          ))}
          {fg.y.ticks.map((t) => (
            <line key={`gy${t}`} x1={m.l} x2={m.l + pw} y1={Y(t)} y2={Y(t)} style={{ stroke: "var(--line)", strokeWidth: 1 }} />
          ))}
          <rect x={m.l} y={m.t} width={pw} height={ph} style={{ fill: "none", stroke: "var(--ink-3)", strokeWidth: 1 }} />
          {fg.x.ticks.map((t) => (
            <text key={`tx${t}`} x={X(t)} y={m.t + ph + 16} textAnchor="middle" fontSize="13">
              {num(t)}
            </text>
          ))}
          {fg.y.ticks.map((t) => (
            <text key={`ty${t}`} x={m.l - 6} y={Y(t)} dy="0.34em" textAnchor="end" fontSize="13">
              {num(t)}
            </text>
          ))}
          <text x={m.l + pw / 2} y={H - 6} textAnchor="middle" fontSize="13.5" style={{ fill: "var(--ink)" }}>
            {fg.x.label}
          </text>
          <text x={m.l - 6} y={m.t - 12} textAnchor="start" fontSize="13.5" style={{ fill: "var(--ink)" }}>
            {fg.y.label} ↑
          </text>
          <g clipPath={`url(#${uid}-c)`}>
            {fg.hline != null ? (
              <line
                x1={m.l}
                x2={m.l + pw}
                y1={Y(fg.hline)}
                y2={Y(fg.hline)}
                style={{ stroke: "var(--ink-2)", strokeWidth: 1.3 }}
              />
            ) : null}
            {(fg.lines ?? []).map((ln, i) => {
              const c = lineColor(i);
              const dashed = ln.style === "dashed";
              const d = ln.data.map(([x, y], k) => `${k ? "L" : "M"}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join("");
              return (
                <g key={`ln${i}`}>
                  <path
                    d={d}
                    style={{
                      fill: "none",
                      stroke: c,
                      strokeWidth: 2,
                      strokeLinejoin: "round",
                      strokeDasharray: dashed ? "6 4" : undefined,
                    }}
                  />
                  {ln.dots
                    ? ln.data.map(([x, y], k) =>
                        dashed ? (
                          <circle
                            key={k}
                            cx={X(x).toFixed(1)}
                            cy={Y(y).toFixed(1)}
                            r="3.4"
                            style={{ fill: "var(--surface)", stroke: c, strokeWidth: 1.6 }}
                          />
                        ) : (
                          <circle key={k} cx={X(x).toFixed(1)} cy={Y(y).toFixed(1)} r="3.2" style={{ fill: c }} />
                        ),
                      )
                    : null}
                </g>
              );
            })}
            {(fg.points ?? []).map((s, i) => {
              const k = s.data.length <= 3 ? 1.6 : 1;
              return (
                <g key={`pt${i}`}>
                  {s.data.map(([x, y], j) => (
                    <Marker key={j} kind={s.marker} x={X(x)} y={Y(y)} color={SERIES[i % SERIES.length]} k={k} />
                  ))}
                </g>
              );
            })}
            {(fg.labels ?? []).map((l, i) => {
              const px = X(l.x);
              const py = Y(l.y);
              const right = px > m.l + pw * 0.62;
              return (
                <text
                  key={`lb${i}`}
                  x={(right ? px - 9 : px + 9).toFixed(1)}
                  y={(py - 9).toFixed(1)}
                  textAnchor={right ? "end" : "start"}
                  fontSize="12.5"
                  style={{
                    fill: "var(--ink)",
                    paintOrder: "stroke",
                    stroke: "var(--surface)",
                    strokeWidth: 4,
                    strokeLinejoin: "round",
                  }}
                >
                  {l.text}
                </text>
              );
            })}
          </g>
        </g>
      </svg>
      {legend.length ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px] text-ink-2" aria-hidden="true">
          {fg.legendTitle ? <span className="text-ink-3">{fg.legendTitle}</span> : null}
          {legend}
        </div>
      ) : null}
      {fg.note ? <figcaption className="mt-2 text-center text-[13px] text-ink-3">{fg.note}</figcaption> : null}
    </figure>
  );
}
