"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FilePick, formatBytes } from "@/components/work/file-pick";

const MB = 1024 * 1024;
const LMS_URL = "https://lms.example.edu/mod/assign/view.php?id=101";

type Sample = { label: string; files: { name: string; bytes: number }[] };

const SAMPLES: Sample[] = [
  { label: "Good file", files: [{ name: "Essay draft.pdf", bytes: 1.25 * MB }] },
  {
    label: "Long name",
    files: [
      {
        name: "Week_7_lab_report_final_FINAL_v3_with_corrected_graphs_and_appendix_for_submission.docx",
        bytes: 640 * 1024,
      },
    ],
  },
  { label: "9 MB", files: [{ name: "Slides.pptx", bytes: 9 * MB }] },
  { label: "3 MB", files: [{ name: "Report.docx", bytes: 3 * MB }] },
  {
    label: "Two files",
    files: [
      { name: "a.pdf", bytes: 1000 },
      { name: "b.pdf", bytes: 1000 },
    ],
  },
];

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** Puts made-up files on the component's real input, as the picker would. */
function feed(wrap: HTMLElement | null, sample: Sample) {
  const input = wrap?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input || input.disabled) return;
  const dt = new DataTransfer();
  for (const f of sample.files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function Demo({
  title,
  note,
  maxBytes,
  disabled,
  samples = SAMPLES,
}: {
  title: string;
  note: string;
  maxBytes?: number;
  disabled?: boolean;
  samples?: Sample[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [got, setGot] = useState<File | null>(null);
  const [key, setKey] = useState(0);

  return (
    <section className="space-y-3">
      <h2 className="type-h22">{title}</h2>
      <p className="ink-2">{note}</p>
      <div className="flex flex-wrap gap-2">
        {samples.map((s) => (
          <Button key={s.label} variant="secondary" size="sm" onClick={() => feed(wrap.current, s)}>
            {s.label}
          </Button>
        ))}
        <Button
          variant="text"
          size="sm"
          onClick={() => {
            setGot(null);
            setKey((k) => k + 1);
          }}
        >
          Reset
        </Button>
      </div>
      <div ref={wrap} className="max-w-md">
        <FilePick
          key={key}
          lms="MyCourses"
          lmsUrl={LMS_URL}
          maxBytes={maxBytes}
          disabled={disabled}
          onChange={setGot}
        />
      </div>
      <p className="mono ink-3 [overflow-wrap:anywhere]">
        parent has: {got ? `${got.name} (${formatBytes(got.size)})` : "null"}
      </p>
    </section>
  );
}

export default function FilePickPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-10 px-4 py-10 sm:px-5">
      <header className="space-y-3">
        <h1 className="type-h30">File pick</h1>
        <p className="ink-2">
          Attach the one file she made. Drop a file, use Choose file, or press a sample button
          (made-up files, fed to the real input). Tab to Choose file, press Enter or Space to open
          the picker, Tab to Remove.
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

      <Demo
        title="Assignment takes 20 MB"
        note="Our own 4 MB limit is the one that bites: 9 MB gets the hand-in-on-MyCourses line."
        maxBytes={20 * MB}
      />
      <Demo
        title="Assignment takes 2 MB"
        note="The assignment's own limit comes first: 3 MB and 9 MB are over it."
        maxBytes={2 * MB}
      />
      <Demo title="No limit from MyCourses" note="Only our 4 MB limit applies." />
      <Demo title="Disabled" note="While a hand-in is sending." maxBytes={20 * MB} disabled />
    </main>
  );
}
