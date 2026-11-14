# Ready

Know if you'll be ready. Start studying in 10 seconds.

Live: https://valeria-theta.vercel.app

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Work on it with Claude Code

Open Claude Code in this folder and use:

| Command | What it does |
|---|---|
| `/start` | Catches up on where we left off and suggests the next thing |
| `/build <feature>` | Builds one feature on its own branch, ready for a preview link |
| `/notes <what happened>` | Records what you saw when someone used the app |
| `/think <question>` | Sends a hard question to the deep-thinker (Fable) |
| `/wrap` | Updates the log and feature map at the end of a session |

Or just chat. `CLAUDE.md` and the `context/` folder give every session the full picture.

## The loop

Pick a feature from `context/feature-map.md` → build it on a branch → send the Vercel preview link to a tester → watch them use it → `/notes` → merge → `/wrap`.
