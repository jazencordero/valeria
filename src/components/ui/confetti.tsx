"use client";

import { isFast } from "@/lib/motion/fast";

const COLOUR_VARS = ["--confetti-1", "--confetti-2", "--confetti-3", "--confetti-4", "--confetti-5"];
/** Pieces fade out after this, and are gone at LIFE_MS. */
const FADE_FROM_MS = 1000;
export const CONFETTI_LIFE_MS = 1400;

function calm(): boolean {
  if (typeof window === "undefined") return true;
  if (isFast()) return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

type Bit = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  a: number;
  va: number;
  c: string;
};

/**
 * Fires about 90 pastel pieces from the centre of `fromEl` on a full-screen
 * canvas that removes itself after 1.4 s. Does nothing when motion is calm.
 */
export function burst(fromEl: Element | null, count = 90): void {
  if (!fromEl || calm()) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = fromEl.getBoundingClientRect();

  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  cv.dataset.confetti = "";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(vw * dpr);
  cv.height = Math.round(vh * dpr);
  Object.assign(cv.style, {
    position: "fixed",
    inset: "0",
    width: `${vw}px`,
    height: `${vh}px`,
    pointerEvents: "none",
    zIndex: "44",
  });
  const ctx = cv.getContext?.("2d");
  if (!ctx) return;
  document.body.appendChild(cv);
  ctx.scale(dpr, dpr);

  const cs = getComputedStyle(document.documentElement);
  let colours = COLOUR_VARS.map((v) => cs.getPropertyValue(v).trim()).filter(Boolean);
  if (!colours.length) colours = ["currentColor"];

  const ox = r.left + r.width / 2;
  const oy = r.top + r.height / 2;
  const bits: Bit[] = [];
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
    const sp = 5 + Math.random() * 7;
    bits.push({
      x: ox,
      y: oy,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      a: Math.random() * 6.28,
      va: (Math.random() - 0.5) * 0.4,
      c: colours[i % colours.length],
    });
  }

  const t0 = performance.now();
  let last = t0;
  const frame = (now: number) => {
    if (!cv.isConnected) return;
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    const age = now - t0;
    ctx.clearRect(0, 0, vw, vh);
    ctx.globalAlpha =
      age > FADE_FROM_MS ? Math.max(0, 1 - (age - FADE_FROM_MS) / (CONFETTI_LIFE_MS - FADE_FROM_MS)) : 1;
    for (const b of bits) {
      b.vy += 0.32 * dt; // gravity
      b.vx *= 0.985; // drag
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.a += b.va * dt;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (age < CONFETTI_LIFE_MS) requestAnimationFrame(frame);
    else cv.remove();
  };
  requestAnimationFrame(frame);
}
