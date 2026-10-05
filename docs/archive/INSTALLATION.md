# ASTRA Installation Guide

## What's Included

This is the **complete, debugged, and stabilized** ASTRA project with all fixes applied as of October 5, 2026.

### Fixed Issues ✅
- ✅ Normal chat works without nagging about "connecting a model"
- ✅ Voice commands work reliably (no more deadlock after 1-2 uses)
- ✅ Random website opening bug fixed (questions stay conversation)
- ✅ System prompt properly injected into all conversations
- ✅ Port configuration corrected (backend on 5175, frontend on 5173)
- ✅ Environment variable support for configuration
- ✅ Startup scripts for easy launching

## Prerequisites

Before installation, ensure you have:

1. **.NET 10 SDK** - [Download here](https://dotnet.microsoft.com/download)
   ```bash
   # Verify installation
   dotnet --version
   # Should show 10.x.x
   ```

2. **Node.js 18+** - [Download here](https://nodejs.org/)
   ```bash
   # Verify installation
   node --version
   npm --version
   ```

3. **Chrome or Edge** browser (for voice features)

4. **OpenAI API Key** (optional, for live AI - demo mode works without it)

## Installation Steps

### 1. Extract the Files

```bash
# Extract to your desired location
unzip astra-fixed.zip
cd astra
```

### 2. Install Dependencies

```bash
# Frontend dependencies
cd frontend
npm install
cd ..

# Backend dependencies (automatic on first run)
cd backend
dotnet restore
cd ..
```

### 3. Configure (Optional)

#### For Live AI (Recommended)

**Option A: Environment Variable (Secure)**
```bash
# Add to ~/.zshrc or ~/.bashrc
export Astra__OpenAI__ApiKey="sk-your-api-key-here"
export Astra__OpenAI__Model="gpt-4o-mini"

# Reload shell
source ~/.zshrc
```

**Option B: Configuration File**
Edit `backend/appsettings.json`:
```json
{
  "Astra": {
    "Provider": "openai",
    "OpenAI": {
      "ApiKey": "sk-your-api-key-here",
      "Model": "gpt-4o-mini"
    }
  }
}
```

#### For Demo Mode (No API Key)
Edit `backend/appsettings.json`:
```json
{
  "Astra": {
    "Provider": "demo"
  }
}
```

### 4. Start ASTRA

#### Easy Way (Recommended)
```bash
./start.sh
```

#### Manual Way
```bash
# Terminal 1 - Backend
cd backend
dotnet run

# Terminal 2 - Frontend
cd frontend
npm run dev
```

### 5. Access ASTRA

Open your browser to: **http://localhost:5173**

## First-Time Setup

### Enable Voice (Optional)

1. Click **"WAKE ON"** button (top right)
2. Allow microphone access when prompted
3. Say: **"Hey Astra"** (orb should ripple)
4. Try: **"open youtube"**

### Test Commands

**Normal Conversation:**
- "What is quantum physics?"
- "Tell me a joke"
- "Explain machine learning"

**Desktop Commands:**
- "open youtube"
- "search google for cats"
- "play lofi music on youtube"

**Slash Commands:**
- `/help` - Show all commands
- `/status` - System status
- `/time` - Current time
- `/clear` - Clear chat

## Project Structure

```
astra/
├── backend/                    # C# ASP.NET Core API
│   ├── Properties/
│   │   └── launchSettings.json # Port configuration (5175)
│   ├── Services/
│   │   ├── OpenAiCompatibleEngine.cs  # Live AI
│   │   ├── DemoAstraEngine.cs         # Demo mode
│   │   ├── AgentRouter.cs             # Desktop automation
│   │   └── OsControl.cs               # System control
│   ├── Program.cs              # Main API server
│   ├── AstraSystemPrompt.md    # AI personality
│   └── appsettings.json        # Configuration
│
├── frontend/                   # React + Vite UI
│   ├── src/
│   │   ├── components/         # AstraOrb, ChatStream, CommandBar
│   │   ├── hooks/              # useAstra, useWakeWord
│   │   └── styles/             # CSS
│   └── vite.config.js          # Dev server + proxy
│
├── start.sh                    # Easy startup script
├── stop.sh                     # Easy shutdown script
├── README.md                   # Full documentation
├── QUICK_START.md              # Quick reference
├── FIXES_APPLIED.md            # Technical details of fixes
├── MIGRATION_GUIDE.md          # Troubleshooting guide
├── PORT_FIX_APPLIED.md         # Port configuration fix
└── INSTALLATION.md             # This file
```

## Configuration Reference

### Environment Variables (Recommended for Production)

| Variable | Default | Description |
|----------|---------|-------------|
| `Astra__Provider` | `openai` | `openai` or `demo` |
| `Astra__OpenAI__ApiKey` | (none) | Your OpenAI API key |
| `Astra__OpenAI__BaseUrl` | `https://api.openai.com/v1/` | API endpoint |
| `Astra__OpenAI__Model` | `gpt-4o-mini` | Model to use |

### Ports

| Service | Port | URL |
|---------|------|-----|
| Frontend | 5173 | http://localhost:5173 |
| Backend | 5175 | http://localhost:5175 |
| Status API | 5175 | http://localhost:5175/api/status |

## Troubleshooting

### Backend Won't Start

**Error: "dotnet: command not found"**
- Install .NET 10 SDK: https://dotnet.microsoft.com/download

**Error: Port 5175 in use**
```bash
# Find and kill process
lsof -i :5175
kill -9 <PID>
```

### Frontend Won't Start

**Error: "npm: command not found"**
- Install Node.js: https://nodejs.org/

**Error: Dependencies not installed**
```bash
cd frontend
npm install
```

### "This site can't be reached"

```bash
# Stop everything
./stop.sh

# Restart
./start.sh

# Verify
curl http://localhost:5175/api/status
curl http://localhost:5173/api/status
```

### Voice Not Working

- ✅ Use Chrome or Edge (Safari not supported)
- ✅ Check browser microphone permissions
- ✅ Check system microphone permissions
- ✅ Try toggling WAKE OFF → ON

### AI Not Responding Intelligently

**If seeing demo responses:**
1. Set API key: `export Astra__OpenAI__ApiKey="sk-..."`
2. Restart backend: `./stop.sh && ./start.sh`
3. Check status: `curl http://localhost:5175/api/status`

## Verification Checklist

After installation, verify:

- [ ] Backend starts without errors
- [ ] Frontend loads at http://localhost:5173
- [ ] Chat interface visible
- [ ] Can type and send messages
- [ ] Messages get responses
- [ ] "Can you explain Google?" stays conversation (no browser)
- [ ] "open youtube" opens browser
- [ ] Voice wake word activates orb
- [ ] Voice commands work multiple times
- [ ] No random website opening

## Using with Local Models (Ollama)

ASTRA works with local OpenAI-compatible endpoints:

```json
{
  "Astra": {
    "Provider": "openai",
    "OpenAI": {
      "BaseUrl": "http://localhost:11434/v1/",
      "ApiKey": "",
      "Model": "llama2"
    }
  }
}
```

## Uninstallation

```bash
# Stop services
./stop.sh

# Remove directory
cd ..
rm -rf astra
```

## Getting Help

1. **Read documentation:**
   - `README.md` - Full feature list
   - `QUICK_START.md` - Quick reference
   - `MIGRATION_GUIDE.md` - Troubleshooting
   - `FIXES_APPLIED.md` - Technical details

2. **Check logs:**
   - Backend: Terminal where `dotnet run` is running
   - Frontend: Browser console (F12)

3. **Test endpoints:**
   ```bash
   curl http://localhost:5175/api/status
   curl http://localhost:5175/api/diagnostics
   ```

## What's New in This Version

### Major Fixes (October 5, 2026)

1. **Normal Chat Fixed**
   - Changed default from demo to OpenAI mode
   - System prompt injection working
   - No more repeated nagging about "connecting a model"

2. **Voice Reliability Fixed**
   - Exponential backoff restart mechanism
   - Liveness watchdog
   - Works reliably for 3+ consecutive commands

3. **Command Intent Fixed**
   - Strict regex requiring command at start
   - Questions about tech stay conversation
   - Only explicit commands trigger automation

4. **Port Configuration Fixed**
   - Backend correctly starts on port 5175
   - Frontend proxy working
   - Connection stable

5. **Startup Scripts Added**
   - `start.sh` - Easy single-command start
   - `stop.sh` - Clean shutdown

## Security Notes

- ⚠️ Don't commit API keys to git
- ✅ Use environment variables for secrets
- ✅ Keep appsettings.json clean
- ✅ Add `appsettings.Development.json` to .gitignore

## Performance Tips

- Backend compiles on first run (may take 10-15 seconds)
- Subsequent starts are faster
- Voice requires microphone permissions (one-time prompt)
- Desktop automation requires accessibility permissions on macOS

## Known Limitations

1. **Voice:** Chrome/Edge only (Web Speech API)
2. **Typing/Keys:** macOS Accessibility permission required
3. **Web Scraping:** YouTube/Amazon may block bots (graceful degradation)
4. **Session Storage:** In-memory (restart clears history)

## Next Steps

After installation:

1. ✅ Start ASTRA: `./start.sh`
2. ✅ Open browser: http://localhost:5173
3. ✅ Try chat: "Hello, what can you do?"
4. ✅ Try voice: Click WAKE ON, say "Hey Astra"
5. ✅ Try command: "open youtube"
6. ✅ Read docs: Open `QUICK_START.md`

## Support

For issues or questions:
1. Check `MIGRATION_GUIDE.md` troubleshooting section
2. Check `FIXES_APPLIED.md` for technical details
3. Verify backend logs for errors
4. Check browser console for frontend errors

---

**Version:** October 5, 2026 - Stabilized & Debugged
**Status:** Production Ready ✅
**All Known Issues:** Fixed ✅

Enjoy ASTRA! 🚀
