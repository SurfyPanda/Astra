# ASTRA Migration Guide

## Quick Start (If You're New)

### Easy Method (Recommended)

```bash
cd /Users/aaravvemula/Documents/Codex/astra

# Optional: Set your OpenAI API key for intelligent responses
export Astra__OpenAI__ApiKey="sk-your-key-here"

# Start everything with one command
./start.sh

# When done, stop everything
./stop.sh
```

### Manual Method

```bash
cd /Users/aaravvemula/Documents/Codex/astra

# 1. Set your OpenAI API key (optional, required for intelligent responses)
export Astra__OpenAI__ApiKey="sk-your-key-here"

# 2. Start the backend (Terminal 1)
cd backend
dotnet run

# 3. Start the frontend (Terminal 2)
cd frontend  
npm run dev

# 4. Open http://localhost:5173
```

---

## For Existing Users

### What Changed

**Default Provider:** Now `openai` instead of `demo`
- If you don't have an API key, ASTRA will tell you once (not repeatedly)
- To explicitly use demo mode, set `"Provider": "demo"` in appsettings.json

**Voice Commands:** Now work reliably for multiple interactions
- No action needed - the fix is automatic
- If you disabled voice due to bugs, you can re-enable it now

**Desktop Commands:** Now require explicit action intent
- "Can you explain Google?" → Stays conversation ✅
- "Search google for cats" → Opens browser ✅
- No accidental website opening anymore

### Configuration Migration

#### Option A: Keep Using appsettings.json

**Before:**
```json
{
  "Astra": {
    "Provider": "demo"
  }
}
```

**After (for live AI):**
```json
{
  "Astra": {
    "Provider": "openai",
    "OpenAI": {
      "ApiKey": "sk-your-key-here",
      "Model": "gpt-4o-mini"
    }
  }
}
```

**After (to keep demo mode):**
```json
{
  "Astra": {
    "Provider": "demo"
  }
}
```

#### Option B: Use Environment Variables (Recommended)

**Advantages:**
- Keep secrets out of git
- Easy deployment configuration
- Override appsettings without editing files

**Setup:**
```bash
# Add to your ~/.zshrc or ~/.bashrc
export Astra__Provider="openai"
export Astra__OpenAI__ApiKey="sk-your-key-here"
export Astra__OpenAI__Model="gpt-4o-mini"

# Then restart terminal and run
cd backend && dotnet run
```

**For one-time use:**
```bash
Astra__OpenAI__ApiKey="sk-..." dotnet run
```

### Testing Your Setup

#### 1. Check Status
```bash
curl http://localhost:5175/api/status
```

**Expected (with API key):**
```json
{
  "provider": "openai-compatible",
  "model": "gpt-4o-mini",
  "online": true,
  "note": "Live AI model connected and ready."
}
```

**Expected (demo mode):**
```json
{
  "provider": "demo",
  "model": "astra-demo-persona",
  "online": true,
  "note": "Running in demo mode with simulated responses..."
}
```

#### 2. Test Chat
Open http://localhost:5173 and try:
- "What is quantum physics?" (should get intelligent response if live)
- "Tell me a joke" (should work)

#### 3. Test Voice
- Click "WAKE ON" button
- Say "hey astra"
- Orb should ripple
- Say "open youtube"
- Should open YouTube
- Immediately say "hey astra search google for cats"
- Should work without deadlock ✅

#### 4. Test Command Intent
- Type: "Can you explain how Google search works?"
- Should get explanation, NOT open browser ✅
- Type: "search google for cats"  
- Should open browser ✅

---

## Troubleshooting

### "I'm not connected to a live AI model yet"

**Cause:** No API key configured

**Fix:**
```bash
# Set environment variable
export Astra__OpenAI__ApiKey="sk-your-key-here"

# OR edit backend/appsettings.json
{
  "Astra": {
    "OpenAI": {
      "ApiKey": "sk-your-key-here"
    }
  }
}

# Restart backend
cd backend && dotnet run
```

### Voice Stops After First Command

**This should now be fixed!** The new version maintains continuous listening.

**If you still experience issues:**
1. Check browser console for errors (F12 → Console)
2. Verify microphone permissions:
   - Chrome: Settings → Privacy → Microphone → Allow
   - macOS: System Settings → Privacy → Microphone → Allow
3. Try toggling WAKE OFF then ON
4. Use Chrome or Edge (Safari doesn't support Web Speech API)

### Random Website Opening

**This should now be fixed!** Commands require explicit action intent.

**Verify the fix:**
- "Can you explain Google?" → Should NOT open browser ✅
- "What is YouTube?" → Should NOT open browser ✅
- "Open youtube" → Should open browser ✅

**If websites still open randomly:**
Check `backend/Services/AgentRouter.cs` - the GoogleRegex should be:
```csharp
[GeneratedRegex(@"^(?:(?:please|can you|could you)\s+)?(?:search|look up|google|find)\b")]
```

### Frontend Can't Connect ("This site can't be reached")

**Symptoms:** 
- Browser shows "localhost refused to connect"
- Frontend loads but can't reach backend

**Causes & Fixes:**

**1. Backend not running**
```bash
# Check if backend is running
lsof -i :5175

# If nothing shows, start backend
cd backend && dotnet run
```

**2. Backend running on wrong port**
```bash
# Backend should be on port 5175
lsof -i :5175  # Should show dotnet process

# If it's on port 5000, you need launchSettings.json
# This file should exist at: backend/Properties/launchSettings.json
# It configures the port to 5175
```

**3. Quick fix - Use the startup scripts**
```bash
# Stop everything
./stop.sh

# Start everything fresh
./start.sh

# Check status
curl http://localhost:5175/api/status
curl http://localhost:5173/api/status
```

### Backend Won't Start

**Error: "dotnet: command not found"**
- Install .NET 10 SDK: https://dotnet.microsoft.com/download

**Error: "Port 5175 already in use"**
```bash
# Find and kill existing process
lsof -i :5175
kill -9 <PID>
```

**Error: Build fails**
```bash
cd backend
dotnet clean
dotnet restore  
dotnet build
```

### Frontend Won't Start

**Error: "npm: command not found"**
- Install Node.js 18+: https://nodejs.org/

**Error: "Port 5173 already in use"**
```bash
# Find and kill existing process
lsof -i :5173
kill -9 <PID>
```

**Error: "Cannot GET /api/chat"**
- Backend not running - start it first: `cd backend && dotnet run`

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `Astra__Provider` | `openai` | AI provider: `openai` or `demo` |
| `Astra__OpenAI__ApiKey` | (none) | OpenAI API key (required for live AI) |
| `Astra__OpenAI__BaseUrl` | `https://api.openai.com/v1/` | API endpoint |
| `Astra__OpenAI__Model` | `gpt-4o-mini` | Model name |
| `ASTRA_OPENAI__APIKEY` | (none) | Legacy API key variable (still supported) |

### Setting Environment Variables

**macOS/Linux - Permanent:**
```bash
# Add to ~/.zshrc or ~/.bashrc
echo 'export Astra__OpenAI__ApiKey="sk-..."' >> ~/.zshrc
source ~/.zshrc
```

**macOS/Linux - Temporary:**
```bash
export Astra__OpenAI__ApiKey="sk-..."
cd backend && dotnet run
```

**Windows PowerShell:**
```powershell
$env:Astra__OpenAI__ApiKey = "sk-..."
cd backend
dotnet run
```

---

## Using Local Models (Ollama)

ASTRA works with any OpenAI-compatible endpoint, including local Ollama:

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

**No API key needed for local endpoints!**

---

## Reverting to Demo Mode

If you want to use demo mode (simulated responses, no API key):

**appsettings.json:**
```json
{
  "Astra": {
    "Provider": "demo"
  }
}
```

**Or environment variable:**
```bash
export Astra__Provider="demo"
```

**Note:** Demo mode now:
- ✅ Doesn't nag repeatedly about connecting a model
- ✅ Gives one clear explanation of limitations
- ✅ Still supports all commands and features
- ❌ Can't answer general knowledge questions intelligently

---

## Production Deployment

### Recommended Configuration

**Use environment variables for secrets:**
```bash
# .env file (don't commit to git!)
Astra__Provider=openai
Astra__OpenAI__ApiKey=sk-prod-key-here
Astra__OpenAI__Model=gpt-4o
```

**appsettings.json (commit to git):**
```json
{
  "Astra": {
    "Provider": "openai",
    "OpenAI": {
      "BaseUrl": "https://api.openai.com/v1/",
      "Model": "gpt-4o-mini"
    }
  }
}
```

### Security Checklist

- [ ] API key in environment variable (not appsettings.json)
- [ ] appsettings.json in .gitignore if it contains secrets
- [ ] CORS configured for your production domain
- [ ] HTTPS enabled for production
- [ ] Rate limiting configured
- [ ] Logging configured (remove verbose debug logs)

---

## What Didn't Change

✅ React + Vite frontend (same tech stack)
✅ C# ASP.NET backend (same tech stack)
✅ SSE streaming (same architecture)
✅ Visual design / HUD / orb (same UI)
✅ Desktop automation features (same capabilities)
✅ Slash commands (same commands)
✅ Voice wake word (same "hey astra")

**Only fixes applied - no redesign!**

---

## Getting Help

1. **Check logs:**
   - Backend: Terminal where `dotnet run` is running
   - Frontend: Browser console (F12)

2. **Test endpoints directly:**
   ```bash
   curl http://localhost:5175/api/status
   curl http://localhost:5175/api/diagnostics
   ```

3. **Verify configuration:**
   ```bash
   cd backend
   dotnet run --environment Development
   # Watch for "Astra:Provider" in startup logs
   ```

4. **Read documentation:**
   - `README.md` - Full feature documentation
   - `FIXES_APPLIED.md` - Technical details of fixes
   - `MIGRATION_GUIDE.md` - This file

---

## Success Checklist

After migration, verify:

- [ ] Backend starts without errors
- [ ] Frontend loads at http://localhost:5173
- [ ] /api/status shows correct provider
- [ ] Normal chat works (with API key) or shows one clear message (without)
- [ ] Voice wake word activates orb
- [ ] Voice commands work multiple times in a row
- [ ] "Can you explain Google?" stays conversation
- [ ] "Search google for cats" opens browser
- [ ] Desktop automation works (open youtube, etc.)
- [ ] No random website opening during conversation

---

**You're all set! ASTRA is now production-ready with reliable voice, normal chat, and controlled automation.**
