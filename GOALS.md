# GOALS — ASTRA (minified)

**Ship a local-first, production-ready dev webapp: chat + voice + a real agent that controls this Mac. No paid API keys.**

## Stack
`React/Vite (5173)` → `.NET backend (5175)` → `proxy (4321, OpenAI-compatible)` → `private OpenCode runtime (4399)` → **free models** (`opencode/mimo-v2.6-flash-free`).

## Definition of done
- [ ] `./start.sh` brings up all three tiers; `./stop.sh` kills them and orphans.
- [ ] Chat streams tokens; `Who are you?` answers as ASTRA (persona from `AGENTS.md`).
- [ ] Agent tasks run with tools: *"create a file …"*, *"open Safari"*, *"pause the music"*, *"set volume 40"*.
- [ ] `AGENT ACTIVITY` card shows live tool/shell/permission events from `/proxy/activity`.
- [x] Wake word arms on click, hears **“\<wake word\> \<command\>”**, sends it, re-arms; yields only for TTS/manual mic and barges in over a busy turn. Word is user-editable in the sidebar.
- [x] Command capture is a real session, not a first-chunk submit: wake opens `COMMAND_LISTENING`, speech accumulates, silence only *starts a timer*, and a timer only submits text that reads as a finished thought (`isLikelyComplete`). Live timer + transcript + `SEND`/`CANCEL` in the sidebar; one command session id guarantees exactly-once submit. Tuning lives in `VOICE_CONFIG` (`frontend/src/lib/commandCapture.js`); `npm test` covers matcher + capture policy (106 assertions).
- [ ] `/clear` wipes frontend history **and** agent-side session memory.
- [ ] Bridge down ⇒ friendly backend error, not a stack trace.
- [ ] `npm run build`, `dotnet build` and `npm test` all green.

## Hard rules
1. Free models only — never require a paid key; `OPENCODE_SERVER_PASSWORD` for local auth.
2. One session map: ASTRA sessionId ⇄ OpenCode session, persisted in `.proxy/sessions.json`.
3. Headless permissions auto-approved and **always logged**; destructive shell ops still need reply-time confirmation (see `AGENTS.md`).
4. Proxy owns the OpenCode child process; the desktop app's own server is untouchable.
5. Ports fixed: 5173 / 5175 / 4321 / 4399 — no random ports in client code.

## Backlog (next)
- [ ] Porcupine wake path (`usePorcupineWake.js`) as premium upgrade; keep browser path as fallback.
- [ ] Activity card filter (tools only) + click-to-expand tool input/output.
- [ ] Wake word auto-arm on first user gesture; mic-level VAD to cut false positives.
- [ ] `proxy/doctor` wired into a `/api/status` field → HUD badge shows bridge health.
- [ ] E2E smoke script: `scripts/smoke.sh` (health → chat → agent task → activity assertions).
- [ ] Single-binary packaging (Vite dist served by .NET; proxy spawned by backend).
- [ ] Trim surface: delete `docs/archive/` once the rewrite is validated for a week.

## Non-goals
Multi-user auth · cloud deploy · mobile app · paid model providers.
