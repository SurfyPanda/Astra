# ASTRA Quick Start Guide

## 🚀 Start ASTRA (Easiest Way)

```bash
cd /Users/aaravvemula/Documents/Codex/astra
./start.sh
```

Then open: **http://localhost:5173**

## 🛑 Stop ASTRA

```bash
cd /Users/aaravvemula/Documents/Codex/astra
./stop.sh
```

## 🔧 Configure API Key (Optional - for intelligent AI)

### Quick (one session):
```bash
export Astra__OpenAI__ApiKey="sk-your-key-here"
./start.sh
```

### Permanent (add to ~/.zshrc):
```bash
echo 'export Astra__OpenAI__ApiKey="sk-your-key-here"' >> ~/.zshrc
source ~/.zshrc
```

## 📋 Status Check

```bash
# Check if backend is running
curl http://localhost:5175/api/status

# Check if frontend is accessible
curl http://localhost:5173/api/status
```

Expected output:
```json
{
  "provider": "openai-compatible",
  "model": "gpt-4o-mini",
  "online": false,
  "note": "Configure Astra:OpenAI:ApiKey..."
}
```

## 🎤 Using Voice Commands

1. Open http://localhost:5173
2. Click **"WAKE ON"** button (top right)
3. Allow microphone access when prompted
4. Say: **"Hey Astra"** (orb will ripple)
5. Say your command: **"open youtube"**
6. Voice stays active - just say "Hey Astra" again for next command

## 💬 Example Commands

### Normal Conversation
- "What is quantum physics?"
- "Tell me a joke"
- "Explain how neural networks work"

### Desktop Automation (explicit commands only!)
- "open youtube"
- "search google for cats"
- "play lofi music on youtube"
- "find laptop on amazon"

### Slash Commands
- `/status` - System status
- `/help` - Show commands
- `/time` - Current time
- `/clear` - Clear chat

## 🐛 Troubleshooting

### "This site can't be reached"
```bash
# Check what's running
lsof -i :5175  # Should show backend
lsof -i :5173  # Should show frontend

# If nothing, restart
./stop.sh
./start.sh
```

### "Backend not responding"
```bash
# Stop and restart backend
cd backend
dotnet build
dotnet run
```

### "Voice doesn't work"
- Use Chrome or Edge (Safari not supported)
- Check microphone permissions in browser
- Check System Settings → Privacy → Microphone
- Try toggling WAKE OFF then ON

### "Random websites opening"
This is now FIXED! Questions stay conversation:
- ❌ "Can you explain Google?" → conversation (no browser)
- ✅ "Search google for cats" → opens browser

## 📝 Ports Reference

- **Frontend:** http://localhost:5173
- **Backend:** http://localhost:5175
- **Status API:** http://localhost:5175/api/status
- **Diagnostics:** http://localhost:5175/api/diagnostics

## 🔑 Configuration Files

- Backend config: `backend/appsettings.json`
- Backend port: `backend/Properties/launchSettings.json`
- Frontend config: `frontend/vite.config.js`
- System prompt: `backend/AstraSystemPrompt.md`

## 📚 Full Documentation

- `README.md` - Complete feature list
- `FIXES_APPLIED.md` - Technical details of recent fixes
- `MIGRATION_GUIDE.md` - Detailed migration and troubleshooting
- `QUICK_START.md` - This file

## ✅ Quick Health Check

Everything working? Test these:

1. ✅ http://localhost:5173 loads
2. ✅ Type "Hello" and get a response
3. ✅ Type "Can you explain Google?" - should NOT open browser
4. ✅ Type "open youtube" - should open browser
5. ✅ Click WAKE ON, say "Hey Astra open youtube" - should work
6. ✅ Repeat voice command 3+ times - should work each time

All green? You're good to go! 🎉
