# Release: how work reaches production

Free hosting gives a limited number of builds, so most pushes do not build.

## The rule in `vercel.json`

`ignoreCommand` checks the branch Vercel is asked to build (`VERCEL_GIT_COMMIT_REF`):

| Branch | What Vercel does |
|---|---|
| `main` | Builds. This is production. |
| `preview/<name>` | Builds. This is a preview link for testers. |
| anything else (`claude/*`, `feat/*`, `scratch/*`) | Skips. No build is used. |

Vercel's rule: the command exiting 1 means build, exiting 0 means skip. A deploy started by hand with the Vercel CLI has no branch, so it is skipped too; use a `preview/*` push instead.

## How work moves

1. **Build branch.** Agents commit ticket by ticket on the builder branch (today `claude/build-bceaea`). Pushing it costs nothing.
2. **Preview, only when a check needs a real link.** Push the current commit once: `git push origin HEAD:preview/<ticket-id>`. Vercel builds it and posts the link. Batch several checks into one preview where possible. Vercel makes no new deployment for a commit it has already seen on another branch (even a skipped one), so push a fresh empty commit to the preview branch only: `git push origin "$(git commit-tree HEAD^{tree} -p HEAD -m preview)":refs/heads/preview/<ticket-id>`. Delete the branch when done: `git push origin --delete preview/<ticket-id>`.
3. **Production.** A merge into `main`, which Jazen approves. Nothing else deploys to production.

## Before merging to `main`

- CI is green on the pull request (lint, typecheck, unit tests, build).
- Migrations: every Vercel build (`main` and `preview/*`) runs `drizzle-kit migrate` against Neon before `next build` (vercel.json `buildCommand`, unpooled address). Previews and production share the one database, so a preview push already migrates it: keep every migration additive (new tables, new nullable columns), and look at the build log's migrate step before merging.
- Every new environment value the release reads is present in Vercel for Production (`vercel env ls production`).
- The whole-flow checks pass (`npm run test:e2e`, and the whole-flow tickets M1-39, M2-23 once they exist) against the preview of the exact commit being merged.
- The preview of that commit was opened on a phone once.

## Undo a bad release

- **Code:** in Vercel, open the project's Deployments, pick the previous production deployment and use Instant Rollback (or `vercel rollback`). This is instant and needs no build. Then revert the bad commit on `main` so the next deploy does not bring it back.
- **A migration that already ran:** rolling back code does not roll back the database. Prefer migrations that only add (new tables, new nullable columns) so the old code still works against the new schema. If a migration removed or changed something the old code needs, do not roll back the code: write a new forward migration that fixes it; the next build applies it. Never reset the production database.
