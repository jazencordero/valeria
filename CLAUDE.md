@AGENTS.md

# Ready: study readiness app

**One line:** Know if you'll be ready. Start studying in 10 seconds.

Read `context/product.md` before any product decision, and `context/feature-map.md` before picking what to build.

## The `context/` folder is the project's memory

Everything we learn goes there, so any new session can pick up where the last one stopped.

| File | What goes in it |
|---|---|
| `context/product.md` | Problem, user, principles, positioning. Changes rarely. |
| `context/feature-map.md` | What's built, what's next, what's out of scope. Source of truth for priorities. |
| `context/decisions.md` | Each decision: what, why, date. Newest on top. |
| `context/user-notes.md` | What we observed when real people used the app. Facts only, no guesses. |
| `context/log.md` | Short session log: what changed, what's next. Newest on top. |

At the end of any session that changed something, update `log.md`, and `feature-map.md` if a feature moved. Use `/wrap`.

## How we work

- One feature per branch: `feat/<short-name>`. Every push gets a Vercel preview link to send to testers.
- Build the smallest version that tests the idea. If it takes more than a weekend, cut scope and say what was cut.
- Watch a real user before adding the next thing. Observations go in `context/user-notes.md`.
- Keep it calm and simple to look at. Fewer, clearer screens beat more features.
- Run `npm run lint` and `npm run build` before saying something is done.

## Model routing (save tokens)

- Everyday work (UI, small features, copy, fixes) runs on the default model in `.claude/settings.json`.
- Hand off to the **deep-thinker** subagent (`.claude/agents/deep-thinker.md`) only for: architecture choices, data model changes, a bug that survived two attempts, or a product decision with real trade-offs. Give it a short, complete brief; it returns a recommendation, not code.
- `/think <question>` does this handoff explicitly.

## Tech

- Next.js (App Router) + TypeScript + Tailwind, deployed on Vercel.
- v0 stores data in the browser (`localStorage`, see `src/lib/store.ts`). No accounts yet.
- Planning logic lives in `src/lib/plan.ts` (readiness and "what to study next"). Keep it pure and easy to test.
