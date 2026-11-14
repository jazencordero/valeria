---
description: Build one feature from the feature map on its own branch
argument-hint: <feature name or description>
---

Feature: $ARGUMENTS

1. Find it in `context/feature-map.md` (if it's not there, add it under v0 or v1 and say where).
2. Write a 5-line plan: smallest version that tests the idea, files you'll touch, what you're cutting.
3. Create branch `feat/<short-name>`, set the feature to `building`.
4. Build it. Run `npm run lint` and `npm run build`.
5. Commit, push, and tell me the Vercel preview will appear on the branch.
6. Set the feature to `testing` and run `/wrap`.

If a design or data-model choice is genuinely hard, ask the deep-thinker subagent before building.
