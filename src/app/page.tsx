"use client";

import { useState } from "react";
import { demoState, uid, useAppState } from "@/lib/store";
import { daysUntil, hoursLeft, pickNext, readiness, type Pick } from "@/lib/plan";
import type { AppState, Exam, Topic, TopicStatus } from "@/lib/types";

const STATUS_LABEL: Record<TopicStatus, string> = {
  not_started: "Not started",
  learning: "Learning",
  ready: "Ready",
};

export default function Home() {
  const [state, setState] = useAppState();
  const [minutes, setMinutes] = useState(25);
  const [session, setSession] = useState<Pick | null>(null);
  const [nothingToDo, setNothingToDo] = useState(false);

  if (!state) return <main className="p-8 text-stone-400">Loading…</main>;

  function updateTopic(examId: string, topicId: string, patch: Partial<Topic>) {
    setState((s) =>
      s && {
        ...s,
        exams: s.exams.map((e) =>
          e.id !== examId
            ? e
            : { ...e, topics: e.topics.map((t) => (t.id === topicId ? { ...t, ...patch } : t)) },
        ),
      },
    );
  }

  function startSession() {
    const pick = pickNext(state!);
    setNothingToDo(!pick);
    setSession(pick);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:py-14">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-stone-900">Ready</h1>
        <p className="mt-1 text-stone-500">Know if you&apos;ll be ready. Start studying in 10 seconds.</p>
      </header>

      {/* The main action */}
      <section className="mb-10 rounded-3xl bg-stone-900 p-6 text-stone-50 sm:p-8">
        <p className="text-sm uppercase tracking-widest text-stone-400">Got a moment?</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-2xl font-medium">I have</span>
          <div className="flex flex-wrap gap-2">
            {[15, 25, 45, 90].map((m) => (
              <button
                key={m}
                onClick={() => setMinutes(m)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-base transition sm:px-4 sm:py-2 sm:text-lg ${
                  minutes === m ? "bg-amber-300 text-stone-900" : "bg-stone-800 text-stone-300 hover:bg-stone-700"
                }`}
              >
                {m} min
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={startSession}
          className="mt-6 w-full rounded-2xl bg-amber-300 py-4 text-lg font-semibold text-stone-900 transition hover:bg-amber-200"
        >
          Start studying →
        </button>
        {nothingToDo && (
          <p className="mt-4 text-stone-300">Everything is marked ready. Nice. Add an exam or topic below.</p>
        )}
      </section>

      {session && (
        <SessionCard
          pick={session}
          minutes={minutes}
          onClose={() => setSession(null)}
          onFinish={(patch) => {
            updateTopic(session.exam.id, session.topic.id, patch);
            setSession(null);
          }}
        />
      )}

      <section className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-stone-900">Your exams</h2>
        <label className="flex items-center gap-2 text-sm text-stone-500">
          Free study hours per week
          <input
            type="number"
            min={0}
            value={state.weeklyHours}
            onChange={(e) => setState({ ...state, weeklyHours: Number(e.target.value) || 0 })}
            className="w-16 rounded-lg border border-stone-200 bg-white px-2 py-1 text-stone-900"
          />
        </label>
      </section>

      <div className="space-y-6">
        {state.exams.map((exam) => (
          <ExamCard
            key={exam.id}
            exam={exam}
            weeklyHours={state.weeklyHours}
            onUpdateTopic={(topicId, patch) => updateTopic(exam.id, topicId, patch)}
            onAddTopic={(name, estHours) =>
              setState({
                ...state,
                exams: state.exams.map((e) =>
                  e.id === exam.id ? { ...e, topics: [...e.topics, newTopic(name, estHours)] } : e,
                ),
              })
            }
            onDelete={() => setState({ ...state, exams: state.exams.filter((e) => e.id !== exam.id) })}
          />
        ))}
      </div>

      <AddExam onAdd={(exam) => setState({ ...state, exams: [...state.exams, exam] })} />

      <footer className="mt-16 text-center text-xs text-stone-400">
        Saved in this browser only.{" "}
        <button className="underline" onClick={() => setState(demoState() as AppState)}>
          Reset to demo
        </button>
      </footer>
    </main>
  );
}

function newTopic(name: string, estHours: number): Topic {
  return { id: uid(), name, estHours, status: "not_started", spentMin: 0, lastNote: "", nextStep: "", questions: [] };
}

function ExamCard({
  exam,
  weeklyHours,
  onUpdateTopic,
  onAddTopic,
  onDelete,
}: {
  exam: Exam;
  weeklyHours: number;
  onUpdateTopic: (topicId: string, patch: Partial<Topic>) => void;
  onAddTopic: (name: string, estHours: number) => void;
  onDelete: () => void;
}) {
  const r = readiness(exam, weeklyHours);
  const onTrack = r.gap >= 0;
  const pct = r.hoursLeft === 0 ? 100 : Math.min(100, Math.round((r.hoursAvailable / r.hoursLeft) * 100));
  const [name, setName] = useState("");
  const [hours, setHours] = useState(2);

  return (
    <article className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold text-stone-900">{exam.name}</h3>
          <p className="text-sm text-stone-500">
            {r.days} day{r.days === 1 ? "" : "s"} left · {r.readyCount}/{r.total} topics ready
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-medium ${
            onTrack ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
          }`}
        >
          {onTrack ? `On track · ${r.gap}h spare` : `Behind by ${Math.abs(r.gap)}h`}
        </span>
      </div>

      <div className="mt-5">
        <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
          <div
            className={`h-full rounded-full ${onTrack ? "bg-emerald-400" : "bg-rose-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-sm text-stone-500">
          {r.hoursLeft}h of work left · {r.hoursAvailable}h of study time before the exam
        </p>
      </div>

      <ul className="mt-5 divide-y divide-stone-100">
        {exam.topics.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-stone-800">{t.name}</p>
              <p className="text-xs text-stone-400">
                {t.status === "ready" ? "Done" : `~${Math.round(hoursLeft(t) * 10) / 10}h left`}
              </p>
            </div>
            <select
              value={t.status}
              onChange={(e) => onUpdateTopic(t.id, { status: e.target.value as TopicStatus })}
              className={`rounded-full border-0 px-3 py-1 text-sm ${
                t.status === "ready"
                  ? "bg-emerald-50 text-emerald-700"
                  : t.status === "learning"
                    ? "bg-amber-50 text-amber-800"
                    : "bg-stone-100 text-stone-600"
              }`}
            >
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onAddTopic(name.trim(), hours);
          setName("");
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add a topic"
          className="min-w-0 flex-1 rounded-xl border border-stone-200 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min={0.5}
          step={0.5}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value) || 1)}
          className="w-16 rounded-xl border border-stone-200 px-2 py-2 text-sm"
          aria-label="Estimated hours"
        />
        <button className="rounded-xl bg-stone-900 px-4 text-sm text-white">Add</button>
      </form>
      <button onClick={onDelete} className="mt-3 text-xs text-stone-400 hover:text-rose-600">
        Remove exam
      </button>
    </article>
  );
}

function SessionCard({
  pick,
  minutes,
  onClose,
  onFinish,
}: {
  pick: Pick;
  minutes: number;
  onClose: () => void;
  onFinish: (patch: Partial<Topic>) => void;
}) {
  const { exam, topic, reason } = pick;
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [status, setStatus] = useState<TopicStatus>(topic.status === "not_started" ? "learning" : topic.status);

  return (
    <section className="mb-10 rounded-3xl border-2 border-amber-300 bg-amber-50/60 p-6 sm:p-8">
      <p className="text-sm text-amber-800">
        {minutes} minutes · {exam.name} · in {daysUntil(exam.date)} days
      </p>
      <h2 className="mt-1 text-2xl font-semibold text-stone-900">{topic.name}</h2>
      <p className="mt-1 text-sm text-stone-500">{reason}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs uppercase tracking-widest text-stone-400">Where you left off</p>
          <p className="mt-2 text-stone-800">{topic.lastNote || "Fresh start. Nothing yet."}</p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs uppercase tracking-widest text-stone-400">Do this first</p>
          <p className="mt-2 text-stone-800">{topic.nextStep || "Skim your material for this topic and list the key ideas."}</p>
        </div>
      </div>

      {topic.questions.length > 0 && (
        <div className="mt-4 rounded-2xl bg-white p-4">
          <p className="text-xs uppercase tracking-widest text-stone-400">Warm-up: answer in your head</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-stone-800">
            {topic.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-6 space-y-3 border-t border-amber-200 pt-6">
        <p className="font-medium text-stone-900">Done? Leave a note for next time</p>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Where did you stop?"
          className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2"
        />
        <input
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="What's the very next step?"
          className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2"
        />
        <div className="flex flex-wrap items-center gap-2">
          {(["learning", "ready"] as TopicStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-sm ${
                status === s ? "bg-stone-900 text-white" : "bg-white text-stone-600"
              }`}
            >
              {s === "ready" ? "I'm ready on this" : "Still learning"}
            </button>
          ))}
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={() =>
              onFinish({
                status,
                spentMin: topic.spentMin + minutes,
                lastNote: note || topic.lastNote,
                nextStep: next || topic.nextStep,
              })
            }
            className="rounded-xl bg-stone-900 px-5 py-2 font-medium text-white"
          >
            Save session
          </button>
          <button onClick={onClose} className="rounded-xl px-5 py-2 text-stone-500">
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function AddExam({ onAdd }: { onAdd: (exam: Exam) => void }) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  return (
    <form
      className="mt-8 flex flex-wrap gap-2 rounded-3xl border border-dashed border-stone-300 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !date) return;
        onAdd({ id: uid(), name: name.trim(), date, topics: [] });
        setName("");
        setDate("");
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New exam, e.g. Statistics"
        className="min-w-0 flex-1 rounded-xl border border-stone-200 px-3 py-2"
      />
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded-xl border border-stone-200 px-3 py-2"
      />
      <button className="rounded-xl bg-stone-900 px-4 py-2 text-white">Add exam</button>
    </form>
  );
}
