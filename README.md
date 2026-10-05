# ASTRA

**Autonomous System Task & Reasoning Assistant** — a local-first desktop webapp: streaming chat, hands-free wake word, and an agent with real tools that can run shell commands, create files, and control this Mac. **No paid API key** — the brain runs on a locally-spawned OpenCode runtime using free models.

## Architecture

```
React/Vite  ──►  .NET backend  ──►  agent bridge  ──►  private OpenCode runtime
  :5173            :5175             :4321               :4399 (spawned, free models)
```

| Port | Piece | What it does |
|------|-------|--------------|
| 5173 | `frontend/` | React + CSS HUD, SSE chat, TTS, wake word |
| 5175 | `backend/` | ASP.NET Core minimal API — chat endpoint, slash commands, status |
| 4321 | `proxy/` | Zero-dependency Node bridge, OpenAI-compatible `/v1/chat/completions` + live `/activity` feed |
| 4399 | OpenCode | Headless `opencode serve` spawned by the proxy — the actual agent (tools, permissions) |

Why a bridge: the .NET backend already speaks the OpenAI protocol, so it only needed a new `BaseUrl`. The proxy owns the OpenCode child process, maps ASTRA sessions to OpenCode sessions (persisted in `.proxy/sessions.json`), auto-approves headless tool permissions (all logged), and streams telemetry to the UI.

**Model:** `opencode/mimo-v2.6-flash-free` (free tier, no login). Change it in `opencode.json` / `ASTRA_MODEL`.

## Quick start

```bash
./start.sh     # bridge + backend + frontend
./stop.sh      # tears all three down
```

or manually / per tier:

```bash
npm install && npm run install:all
npm run proxy      # :4321  (spawns OpenCode on :4399)
npm run backend    # :5175
npm run frontend   # :5173
npm run dev        # all three at once
npm run doctor     # environment health check
```

Open **http://localhost:5173**.

## What works

- **Chat** — token streaming, ASTRA persona (`AGENTS.md`), session memory, `/clear` wipes both UI and agent memory.
- **Agent with real tools** — `bash`, `write`, `edit`, `read`, `webfetch`, `websearch`. Ask it to create a file, run a command, inspect code.
- **macOS control** — open apps/sites, play/pause/next media, volume, brightness, screenshots, keystrokes, system telemetry (`AGENTS.md` has the recipes).
- **Wake word** — say **“Astra”** (no “Hey” needed). The word itself is **editable**: click *Change wake word* in the sidebar, type any 1–3 word phrase, and it takes effect on the next utterance (saved in `localStorage`, enforced by `isValidWakeWord`). Matching lives in `frontend/src/lib/wakePhrase.js` — token-based so it never fires on *astronomy* or *astronaut*, accepts STT mishearings of the default word, strips filler like “um”/“please”, and hands back the raw text after the wake word so casing and punctuation survive. One continuous listener means there is no restart gap for a phrase to fall into. It yields the mic only while TTS is playing or the manual mic is dictating, and a spoken command barges in over a running turn.
- **Command capture** — waking opens a *session*, it does not submit. Speech accumulates into it, silence only **starts a timer**, and the timer only fires when the text reads as a finished thought (`isLikelyComplete` in `frontend/src/lib/commandCapture.js`). So “Astra” … *[pause]* … “What is the meaning of life?” captures the whole question, a pause mid-sentence does not, and a fragment like “is the” is never sent — it is held for confirmation instead. The sidebar shows the phase (**Listening for command**), a live `00:03` timer, a **Still listening…** countdown, the accumulated transcript, and **Send** / **Cancel**. Every session has an id, so a command can only be submitted once. Timings are one tunable object: `VOICE_CONFIG` (`COMMAND_MAX_DURATION_MS`, `SILENCE_FINALIZE_MS`, `POST_WAKE_GRACE_MS`, `RESTART_DELAY_MS`). Dev builds log every transition to the console as `[ASTRA VOICE] …` and expose `window.__astraVoiceDebug`.
- **Agent activity** — the sidebar `AGENT ACTIVITY` card streams tool calls, shell runs, permissions and turn timing live from `/proxy/activity`.
- **Voice** — manual mic input and browser TTS with voice selection.

Covered by `npm test` (106 assertions: wake matcher + capture policy).

## Layout

```
astra-fixed/
├── proxy/          # agent bridge: server, runtime supervisor, sessions, turns, activity
├── backend/        # .NET API (OpenAiCompatibleEngine → the bridge)
├── frontend/       # React UI (hooks: useAstra, useWakeWord, useActivity)
├── opencode.json   # agent permissions + default free model
├── AGENTS.md       # ASTRA persona + tool/macOS guidance (auto-loaded by the agent)
├── GOALS.md        # minified goals + backlog
├── start.sh | stop.sh
└── docs/archive/   # superseded notes from earlier iterations
```

## Notes

- The proxy authenticates to OpenCode with `OPENCODE_SERVER_PASSWORD` (set automatically per run) and never touches the OpenCode desktop app's own server.
- Headless permissions are auto-approved and always logged. Destructive actions still require the agent to confirm in its reply (rule in `AGENTS.md`).
- Wake word and mic input need Chrome/Edge (or an Electron shell) with speech recognition; `usePorcupineWake.js` is an inert, ready-to-wire upgrade path for on-device Picovoice detection.

See **GOALS.md** for the definition of done and backlog.
