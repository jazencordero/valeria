# Feature map

Live app: https://valeria-theta.vercel.app
Visual version (Whiteboard): https://claude.ai/artifact/TdfMS2wFZcSp412JfGvw9b
This file is the source of truth. Keep the board roughly in sync when big things move.

Status: `todo` · `building` · `testing` · `done`

## v0: build now

| Feature | Status | Notes |
|---|---|---|
| Add exam: date + topics with hour estimates | testing | In starter |
| Free study hours per week | testing | In starter |
| Readiness: hours left vs hours available, on track / behind | testing | Assumes each exam gets all weekly hours |
| Topic status: not started, learning, ready | testing | In starter |
| "I have N min" button + resume card | testing | Picks by urgency, boosts topics in progress |

## v1: next

| Feature | Status | Notes |
|---|---|---|
| Upload slides/PDFs, AI makes practice questions | todo | Needs an API route + model calls |
| Quiz answers update readiness | todo | Depends on the one above |
| Log real time per topic, estimates learn | todo | Basic minute logging exists already |
| Installable on phone (PWA) | todo | |
| Edit warm-up questions and notes outside a session | todo | |

## Later

- Calendar sync for free time
- Spaced repetition reminders
- Classmates share topic lists
- Accounts and sync across devices
- Paid plan for working students

## Out of scope (others do it well)

- Notes editor (Notion)
- AI tutor chat (StudyFetch)
- Lecture recording
- Flashcard app (Anki)
