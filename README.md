# 🕵️ Find the AI — a hidden-role social deduction game

Some players are humans. Some are **AI running locally on your own machine** (via [Ollama](https://ollama.com)) — no cloud, no data-center calls. The AI pretend to be human; the humans try to sniff them out. The twist: **the bots learn from your votes**, GAN-style, and get harder to catch over time.

Built to be as light as a game of Jackbox or Kahoot — the whole point is that the AI's cost lives on your laptop, not a hyperscale data center.

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

That's it — the game runs immediately using a built-in offline answer bank for the bots.

### For real local AI bots (recommended)

Install [Ollama](https://ollama.com), then pull a small model:

```bash
ollama pull llama3.2:1b      # ~1.3GB, fast, laptop-friendly
npm start
```

The server auto-detects Ollama on boot. Want a different/smaller model? Set it:

```bash
OLLAMA_MODEL=qwen2.5:0.5b npm start     # even tinier
```

If Ollama isn't running, the game **still works** — it just falls back to the offline answer bank.

## How to play

Open the page and either:

- **🎲 Quick Play** — drop into a public room with strangers + bots (Among-Us style matchmaking).
- **➕ Create Game** — get a 4-letter room code to share with friends (Kahoot/Jackbox style). They join via the code (or the copied invite link).
- **Dev mode** — a checkbox that lets you play **solo** against the bots (1 human minimum), for testing.

### Two game modes

| | **Classic** | **Party** |
|---|---|---|
| Objective | **Find the AI** — vote out the bots | **Find the Humans** — everyone pretends to be AI |
| Chat | Open text chat to debate | Disabled |
| Identity | Your chosen name | Anonymous auto-alias (real names hidden) |
| Twist | A human wrongly voted out as "AI" **loses** | Correctly **guess a friend's alias** → that friend *and* a random AI are both eliminated |
| Win | Humans win when all AI are gone (survivors only); AI win at parity | Last human standing wins; if all AI are voted out first, humans lose |

### Each round

1. **Answer** a prompt (e.g. *"What's brown and sticky?"*) under a 60s timer — 125 or 250 char limit.
2. **Vote** on who seems most AI (Classic) or most human (Party). Live vote tally shown.
3. **Result** — the eliminated player's identity is revealed.

Buttons: **⏩ Speed up** rushes the clock (majority triggers it); **📣 Call/Force vote** ends the phase early (limited uses per player).

## How the bots learn (GAN through play)

You, the human voters, are the **discriminator**. Each round the server:

- saves real human answers as the distribution the bots imitate,
- **rewards** AI answers that survived a vote, **penalizes** answers caught as AI,
- feeds that corpus back as few-shot conditioning so future answers drift toward human-like.

State persists in `data/corpus.json` across matches, and preference pairs (`chosen` = human/survivor, `rejected` = caught-AI) are appended to `data/train.jsonl` — a ready-made dataset if you ever want to do **real offline fine-tuning** (DPO/SFT).

## 🌱 Ethics page

In-app (🌱 button) transparency panel: live count of AI generations, tokens, a conservative energy estimate, `0 mL` data-center water, and the current bot "learning generation." The design goal is a footprint no heavier per player than YouTube/Kahoot/Among Us.

> **Compute model, honestly:** in this server-authoritative build the bots run on the **host's** local Ollama. Truly spreading inference across *every* player's laptop would mean in-browser WebGPU (WebLLM); `llm.js` is written as a single pluggable module so that's a drop-in swap later.

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP/WS port |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint |
| `OLLAMA_MODEL` | `llama3.2:1b` | Model the bots use |
| `OLLAMA_TIMEOUT_MS` | `20000` | Per-generation timeout before fallback |

## Deploy so friends can play (Render)

This game needs a persistent WebSocket server, so it runs on a real Node host — **not** Vercel/Netlify (serverless can't hold WebSocket connections or in-memory game state). Render's free tier works and is already configured via `render.yaml`.

> On a host there's no Ollama, so the bots use the built-in offline answer bank. The game plays fine; you just don't get the local-LLM AI (see the local instructions above for that).

1. **Put the code on GitHub** (from this folder):
   ```bash
   git remote add origin https://github.com/<you>/hidden-role-game.git
   git push -u origin main
   ```
   (Create the empty repo on github.com first.)
2. **Deploy on Render:** go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint** → connect your GitHub repo. Render reads `render.yaml` and deploys automatically.
3. Share the resulting `https://your-app.onrender.com` link. Friends open it, everyone types a name, host **Creates a game** and shares the 4-letter code (uncheck Dev for a real multiplayer match).

Notes: the free plan sleeps after ~15 min idle and cold-starts in ~30–60s on the next visit. Prefer no GitHub? **Railway** works the same way and its CLI can deploy straight from this folder: `npm i -g @railway/cli && railway login && railway init && railway up`.

## Project layout

```
server.js    game engine + WebSocket server + phase machine
llm.js       local Ollama client (pluggable) + offline fallback bank
learn.js     GAN-style learning corpus + preference-dataset export
content.js   prompts + fallback answers
public/      index.html · style.css · app.js  (vanilla, no build step)
data/        corpus.json + train.jsonl  (created at runtime)
```
