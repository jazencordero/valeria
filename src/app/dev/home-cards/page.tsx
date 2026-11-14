import { HeroCard } from "@/components/home/hero-card";
import { Queue, QueueRow } from "@/components/home/queue-row";

// Fixed clock so the labels match the prototype: SAT 14 NOV · 15:48, Helsinki.
const NOW = "2026-11-14T15:48:00+02:00";

const FORECAST = {
  title: "Assignment 3: Forecast weekly demand",
  course: "Forecasting Methods",
  code: "ISM-E1005",
  dueAt: "2026-11-14T21:00:00+02:00",
  href: "/dev/home-cards#forecast",
};

const MEMO = {
  title: "Case memo 2",
  course: "Operations and Supply Chain Analytics",
  code: "ISM-E3003",
  dueAt: "2026-11-17T23:59:00+02:00",
  href: "/dev/home-cards#memo",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function HomeCardsPage() {
  return (
    <main className="mx-auto max-w-xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Home cards</h1>
        <p className="ink-2">The do first card and the queue row. Clock fixed at SAT 14 NOV · 15:48.</p>
      </header>

      <Section title="Do first · urgent, with estimate">
        <HeroCard
          {...FORECAST}
          now={NOW}
          tone="urgent"
          estimateMin={90}
          estimateNote="The brief and the data are ready."
        />
      </Section>

      <Section title="Do first · urgent, no estimate">
        <HeroCard {...FORECAST} now={NOW} tone="urgent" />
      </Section>

      <Section title="Do first · soon, with estimate">
        <HeroCard {...MEMO} now={NOW} tone="soon" estimateMin={120} />
      </Section>

      <Section title="Do first · soon, no estimate">
        <HeroCard {...MEMO} now={NOW} tone="soon" />
      </Section>

      <Section title="Then · queue rows">
        <Queue>
          <QueueRow
            position={2}
            title="Case memo 2"
            course="Operations and Supply Chain Analytics"
            dueAt="2026-11-17T23:59:00+02:00"
            estimateMin={120}
            status="not_started"
          />
          <QueueRow
            position={3}
            title="Service blueprint draft"
            course="Introduction to Digital Service Design"
            dueAt="2026-11-19T16:00:00+02:00"
            estimateMin={180}
            status="new"
          />
          <QueueRow
            position={4}
            title="Assignment 4: Evaluate forecast accuracy"
            course="Forecasting Methods"
            dueAt="2026-11-21T21:00:00+02:00"
            estimateMin={60}
            status="draft_saved"
          />
        </Queue>
      </Section>
    </main>
  );
}
