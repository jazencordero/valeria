/**
 * The frame for the first-run screens (/welcome, /connect, and the M5 steps
 * after them). Static: it reads no cookie, so it never makes a page dynamic.
 *
 * On purpose it adds nothing you can see: no tab bar, no side nav, no column
 * or padding. Each first-run screen draws its own centred 440 px column
 * (Welcome, PasteKey), so /connect looks exactly as it did before this layout.
 *
 * What it does hold is the shared hand-drawn wobble filter (`DoodleDefs`,
 * a zero-size SVG), once for the whole group, so every first-run screen can
 * draw small doodles without each page repeating the filter.
 */
import type { ReactNode } from "react";
import { DoodleDefs } from "@/components/doodle";

export default function FirstRunLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DoodleDefs />
      {children}
    </>
  );
}
