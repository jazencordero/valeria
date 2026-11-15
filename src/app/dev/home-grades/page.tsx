import { GradesCard, type GradesCardRow } from "@/components/home/grades-card";
import { SCHOOLS } from "@/lib/schools";

// Made-up courses; ids are placeholders, the links go to a 404 here.
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const row = (n: number, r: Omit<GradesCardRow, "id" | "href">): GradesCardRow => ({
  id: id(n),
  href: `/grades/${id(n)}`,
  ...r,
});

const STATES: { label: string; courses: GradesCardRow[] }[] = [
  {
    label: "Several courses: on track, within reach, out of reach, too early",
    courses: [
      row(1, { name: "Forecasting Methods", status: "on", target: 4, trajectory: 4.3 }),
      row(2, { name: "Service Design", status: "within", target: 5, trajectory: 3.7 }),
      row(3, { name: "Supply Chain Analytics", status: "out", target: 3, trajectory: 2.2 }),
      row(4, { name: "Marketing Research", status: "early", target: 5, trajectory: null }),
    ],
  },
  {
    label: "One course, too early (nothing graded yet)",
    courses: [row(5, { name: "Marketing Research", status: "early", target: 4, trajectory: null })],
  },
  {
    label: "Needs weights (no number, not too early), and a perfect 5 at target 5",
    courses: [
      row(6, { name: "Operations Strategy", status: "needs_weights", target: 3, trajectory: null }),
      row(7, { name: "Business Statistics", status: "on", target: 5, trajectory: 5 }),
    ],
  },
  {
    label: "A long course name",
    courses: [
      row(8, {
        name: "Advanced Topics in Sustainable Supply Chain Management",
        status: "within",
        target: 4,
        trajectory: 3.95,
      }),
    ],
  },
  { label: "No courses: the card is not drawn", courses: [] },
];

export default function HomeGradesPreview() {
  return (
    <main className="space-y-10 bg-paper px-4 py-10">
      <header className="mx-auto max-w-[340px] space-y-2">
        <h1 className="text-[26px]">Grades card on Home</h1>
        <p className="text-[15px] text-ink-2">
          Five pips filled to the whole grade, the target pip outlined in rose. Each row links to /grades/&lt;id&gt;.
        </p>
      </header>
      {STATES.map((s) => (
        <section key={s.label} className="mx-auto max-w-[340px] space-y-3">
          <h2 className="mono font-normal text-ink-3 [font-family:var(--mono)]">{s.label}</h2>
          <GradesCard courses={s.courses} lmsName={SCHOOLS.aalto.lms} />
          {s.courses.length === 0 && <p className="text-[13px] text-ink-3">(nothing rendered)</p>}
        </section>
      ))}
    </main>
  );
}
