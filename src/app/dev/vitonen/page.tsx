"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Vitonen,
  type VitonenHandle,
  type VitonenReaction,
  type VitonenState,
} from "@/components/vitonen";
import { useMotionMode } from "@/lib/motion/use-calm";

const SIZES = [20, 44, 64, 120] as const;
const STATES: VitonenState[] = ["idle", "talking", "thinking"];
const REACTIONS: VitonenReaction[] = ["nod", "wince", "cheer", "peek", "blink", "swing"];

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function VitonenPage() {
  const mode = useMotionMode();
  const caps = useRef(new Map<string, VitonenHandle>());

  const playAll = (reaction: VitonenReaction) => {
    caps.current.forEach((cap) => cap.react(reaction));
  };

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Vitonen</h1>
        <p className="ink-2">
          The talking cap at four sizes in each state. Under 28 px it uses the
          tiny drawing. Reactions play on every cap at once. With reduced
          motion on, nothing moves.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="motion-mode">
          motion: {mode}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("dark")}>
            Dark
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("system")}>
            System
          </Button>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="type-h22">Reactions</h2>
        <div className="flex flex-wrap gap-2">
          {REACTIONS.map((reaction) => (
            <Button
              key={reaction}
              size="sm"
              onClick={() => playAll(reaction)}
              data-testid={`react-${reaction}`}
            >
              {reaction}
            </Button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="type-h22">States and sizes</h2>
        <table className="border-separate border-spacing-x-6 border-spacing-y-4">
          <thead>
            <tr className="text-left">
              <th className="mono ink-3 font-normal">state</th>
              {SIZES.map((size) => (
                <th key={size} className="mono ink-3 font-normal">
                  {size} px
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STATES.map((state) => (
              <tr key={state}>
                <td className="mono ink-2 align-middle">{state}</td>
                {SIZES.map((size) => {
                  const id = `${state}-${size}`;
                  return (
                    <td key={size} className="align-middle" data-testid={`cap-${id}`}>
                      <Vitonen
                        size={size}
                        state={state}
                        ref={(handle) => {
                          if (handle) caps.current.set(id, handle);
                          else caps.current.delete(id);
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
