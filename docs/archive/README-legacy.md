# ASTRA

**An original AI assistant** — ChatGPT-style conversation with a JARVIS-style presence: hands-free wake word, streaming replies, voice in/out, desktop agent actions, and a living reactor-core HUD. Built from scratch: original name, original design, original persona. No copyrighted assets, logos, or text from any existing AI product.

## Hands-free voice

Toggle **WAKE ON** (top-right) and just speak:

- **"Hey Astra, open youtube"** — orb ripples ACTIVE, Astra opens the site and speaks a confirmation
- **"Hey Astra, play lofi beats on youtube"** — finds and plays the top video, announces title/channel
- The mic stays in a hands-free loop: after each action there's a **5-second window** for follow-ups ("now search google for the weather") before returning to armed standby
- Commands chain: **"open github and search google for rust"** runs as sequential atomic steps
- Works with the free browser speech engine (Chrome/Edge). For robust on-device detection, `usePorcupineWake.js` ships ready for a **Picovoice Porcupine** custom "Hey Astra" keyword (access key + .ppn from console.picovoice.ai, then `npm i @picovoice/porcupine-web @picovoice/web-voice-processor`).

## Desktop agent

Say it in plain language — no commands needed:

| Say | Astra does |
|---|---|
| "open youtube" / "open spotify" / "open github.com" | launches the site (or the app, e.g. "open calculator") |
| "play lofi beats on youtube" | opens & plays the **top video**, announces its title |
| "search google for albert einstein" | opens Google and **summarizes the top result** |
| "find mechanical keyboard on amazon" | opens Amazon with a best-effort product match |
| "type hello world then press enter" | types into the frontmost window (optional delay: "in 5 seconds") |
| "press cmd+t" | presses the key/chord |
| "/diagnostics" | **real telemetry**: CPU %, RAM in use, ping to Google/YouTube/Amazon/Cloudflare |

Notes: typing/keys require macOS Accessibility permission (System Settings → Privacy & Security → Accessibility → grant to the app running Astra, e.g. your terminal or browser). Amazon/Google/YouTube actively block automated readers, so summaries fall back to DuckDuckGo extraction and degrade gracefully. Kill-switch for typing: set `Astra:Agent:AllowTyping` to `false` in appsettings.json.

## Stack

| Layer     | Tech                                              |
|-----------|---------------------------------------------------|
| Frontend  | React 18 + plain CSS (Vite, JavaScript)           |
| Backend   | C# / ASP.NET Core 10 minimal API, SSE streaming   |
| Brain     | Pluggable: offline demo persona **or** any OpenAI-compatible API (OpenAI, OpenRouter, Ollama) |

## Quick start

```bash
cd astra

# Easy way - use the startup script
./start.sh

# Or manual way:
npm install          # installs the root launcher (concurrently)
npm run install:all  # frontend deps
npm run dev          # starts backend (:5175) + frontend (:5173) together
```

Open **http://localhost:5173** — Astra boots up, and you're talking in seconds. No API key needed for demo mode.

To stop ASTRA:
```bash
./stop.sh
```

## Jarvis features

- **Reactor orb** — reacts to state: breathing idle → ripple rings while listening → fast spin while thinking → waveform bars while speaking
- **Wake word** — "Hey Astra" hands-free loop with 5-second follow-up windows
- **Voice** — mic speech-to-text (Chrome/Edge) and spoken replies with a mute toggle
- **Streaming typewriter** — true token-by-token SSE streaming with thinking dots
- **Agent commands** — type `/` for the palette: `/status`, `/time`, `/remember <fact>`, `/recall`, `/diagnostics`, `/erase`, `/help`, `/clear`

## Going live (real LLM intelligence)

Edit `backend/appsettings.json`:

```json
"Astra": {
  "Provider": "openai",
  "OpenAI": {
    "BaseUrl": "https://api.openai.com/v1/",
    "ApiKey": "<your key>",
    "Model": "gpt-4o-mini"
  }
}
```

Or use env vars (no secrets on disk): `Astra__Provider=openai` and `Astra__OpenAI__ApiKey=...`

Works with **any OpenAI-compatible endpoint** — e.g. local Ollama: `BaseUrl: http://localhost:11434/v1/`, any model name, empty key. The persona in `Astra:Persona` is sent as the system prompt and is yours to rewrite.

> Tip: `backend/appsettings.Development.json` overrides are also loaded automatically in dev.

## Architecture

```
astra/
├── backend/                      # C# ASP.NET Core
│   ├── Program.cs                # bootstrap, /api/chat (SSE), /api/status, slash commands
│   ├── Services/
│   │   ├── IAstraEngine.cs       # pluggable brain interface
│   │   ├── DemoAstraEngine.cs    # offline persona (no key needed)
│   │   └── OpenAiCompatibleEngine.cs  # any OpenAI-compatible API, streamed
│   └── Models/ChatMessage.cs
└── frontend/                     # React + CSS (Vite)
    └── src/
        ├── App.jsx               # layout, boot sequence, WAKE toggle, hands-free loop
        ├── hooks/useAstra.js     # SSE client, voice, session state
        ├── hooks/useWakeWord.js  # "Hey Astra" wake word + 5s command windows
        ├── hooks/usePorcupineWake.js # optional on-device Porcupine path
        ├── components/           # AstraOrb, ChatStream, CommandBar
        └── styles/               # global / orb / chat / controls
```

## Notes

- Session history and `/remember` notes live in memory (server restart clears them) — swap in a database when you want persistence.
- Mic input requires Chrome or Edge (Web Speech API); every other feature works in any modern browser.

## Configuration Reference

### Provider Selection

ASTRA now defaults to `"Provider": "openai"` for production-ready behavior. Configure your choice:

| Provider | Description | API Key Required |
|----------|-------------|------------------|
| `openai` | OpenAI-compatible endpoints (OpenAI, OpenRouter, local Ollama) | Yes (unless local endpoint) |
| `demo` | Simulated persona responses for testing | No |

### Environment Variables

All configuration can be set via environment variables (useful for keeping secrets out of files):

```bash
# Provider selection
export Astra__Provider="openai"

# OpenAI configuration  
export Astra__OpenAI__ApiKey="sk-..."
export Astra__OpenAI__BaseUrl="https://api.openai.com/v1/"
export Astra__OpenAI__Model="gpt-4o-mini"
```

Legacy variable `ASTRA_OPENAI__APIKEY` is also supported for backwards compatibility.

### Command Intent Gating (Fixed)

**IMPORTANT:** ASTRA now uses strict intent detection to prevent accidental command execution.

**Conversational (NOT commands):**
- "Can you explain Google search?" → AI explains how Google works
- "How does YouTube's algorithm work?" → AI conversation  
- "I was reading about Amazon" → AI conversation
- "What should I search for?" → AI helps decide

**Desktop Commands (triggers automation):**
- "open youtube" → Opens YouTube  
- "search google for cats" → Opens Google and searches
- "play lofi music on youtube" → Searches and plays video
- "find laptop on amazon" → Opens Amazon search

This prevents the frustrating bug where casual conversation about technology would randomly open websites.

### Voice Reliability (Fixed)

Voice commands now maintain persistent listening. The system:
- Automatically re-arms after each command
- Maintains a 5-second follow-up window
- Never deadlocks after 1-2 uses
- Handles browser speech engine auto-stop gracefully
- Uses exponential backoff for recovery

If voice stops working, check:
1. Browser microphone permissions (Chrome/Edge required)
2. System microphone access
3. Console for specific error messages

### System Prompt Customization

ASTRA loads its personality from:
1. `Astra:Persona` in appsettings.json (if set)
2. `backend/AstraSystemPrompt.md` (default)

Edit either to customize behavior. The system prompt is automatically injected into every conversation with the AI model.

## Troubleshooting

**"I'm not connected to a live AI model yet"**
- Add API key to `backend/appsettings.json` or environment variable
- Restart backend: `cd backend && dotnet run`
- Check `/api/status` endpoint: http://localhost:5175/api/status

**Voice commands work once then stop**
- Fixed in this version! Voice now maintains continuous listening
- If you still experience issues, check browser console for errors
- Try toggling WAKE OFF then ON again

**Websites opening randomly during conversation**
- Fixed in this version! Strict command intent detection prevents this
- Only explicit action commands trigger automation
- Questions about technology remain conversation

**Backend won't start**
- Verify .NET 10 SDK: `dotnet --version`
- Check port 5175 availability: `lsof -i :5175`
- Review backend logs for specific errors

**Frontend can't connect**
- Verify backend is running: http://localhost:5175/api/status  
- Check CORS origins in `backend/Program.cs`
- Ensure frontend port matches (default 5173)

## Status Endpoints

**GET /api/status**
```json
{
  "provider": "openai-compatible",
  "model": "gpt-4o-mini", 
  "online": true,
  "note": "Live AI model connected and ready."
}
```

**GET /api/diagnostics**
```json
{
  "cpu": 23.4,
  "memory": 67.2,
  "memoryDetail": "10.7 GB / 16.0 GB",
  "latencies": {
    "google": 42,
    "youtube": 38,
    "amazon": 56,
    "cloudflare": 12
  }
}
```
