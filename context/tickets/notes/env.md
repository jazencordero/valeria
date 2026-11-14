# Environment values

Names only, never values. Add values with `vercel env add <NAME> <environment>` (pipe the value in) or in the Vercel dashboard. Read them only in the file named; nothing else reads them.

| Name | Where | Added by | Read by | What it is |
|---|---|---|---|---|
| `DATABASE_URL` | Production, Preview, Development | M1-04 (Neon integration, done) | `src/server/db/client.ts` | Neon Postgres. Unset locally means PGlite in `.data/pglite`. |
| `KEY_SEAL_SECRET` | Production, Preview, Development | M1-06 | `src/server/crypto/seal.ts` only | 32 random bytes, base64. Seals her Moodle key. Losing it means every stored key must be reconnected. |
| `KEY_SEAL_SECRET_OLD` | Production | M8-32 | `src/server/crypto/seal.ts` | Previous seal secret during a key rotation. |
| `CRON_SECRET` | Production, Preview, Development | M1-06 | M2-06 cron route, M8-10 | 32 random bytes, base64. Vercel Cron sends it as a bearer token. |
| `APP_URL` | GitHub repository secret | M2-06 | GitHub Actions schedule | The production address the hourly tick calls. |
| `MOODLE_FAKE` | Preview, Development only | M1-09 | `src/server/moodle/client.ts` | `1` answers Moodle calls from sample data (key `demo-key`). Refused when `VERCEL_ENV` is `production`. |
| `HANDIN_ENABLED` | Production | M1-43 | hand-in server code | Off switch for hand-in. Default on. |
| `GROQ_API_KEY` | Production, Preview | M2-01 (done) | AI router (M2-03) | Free AI provider. |
| `OPENROUTER_API_KEY` | Production, Preview | M2-01 (done) | AI router (M2-03) | Free AI provider. |
| `MISTRAL_API_KEY` | Production, Preview | M2-01, if created | AI router (M2-03) | Free AI provider. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Production, Preview | M2-01, if created | AI router (M2-03) | Free AI provider. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Production, Preview | M7-06 | push reminders | Web push keys (`npx web-push generate-vapid-keys`). |
| `RESEND_API_KEY`, `MAIL_FROM` | Production | M7-08 (skipped: no domain) | email reminders | Not used while M7-09 is parked. |
| `BACKUP_PASSPHRASE` | GitHub repository secret | M8-30 | database backup job | Encrypts backups. |

Set by Vercel itself, never added by us: `VERCEL_ENV`, `VERCEL_REGION`, `VERCEL_GIT_COMMIT_REF`.

Not environment values, even though tickets spell them in capitals: `READY_FAST` (a cookie, M1-17), `FREE_MODELS` and `DATA_RULE` (code constants, M2-02/M2-03 and M2-26), `EXAM_DATA` and `CARD_DATA` (prototype data, M3-40).
