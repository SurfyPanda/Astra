# 🚀 ASTRA - START HERE

Welcome! You've just downloaded the **fully debugged and stabilized** ASTRA project.

## ⚡ Quick Start (3 Steps)

### 1. Prerequisites
Install these if you don't have them:
- **.NET 10 SDK**: https://dotnet.microsoft.com/download
- **Node.js 18+**: https://nodejs.org/

### 2. Install Dependencies
```bash
cd astra/frontend
npm install
cd ../backend
dotnet restore
cd ..
```

### 3. Start ASTRA
```bash
./start.sh
```

Then open: **http://localhost:5173**

## 🎯 What You Get

- ✅ AI chat interface (works with or without API key)
- ✅ Voice control ("Hey Astra" wake word)
- ✅ Desktop automation (open apps, search web)
- ✅ All bugs fixed and tested
- ✅ Production-ready

## 📚 Documentation

| File | What It Contains |
|------|------------------|
| **INSTALLATION.md** | Complete installation guide |
| **QUICK_START.md** | Quick reference for daily use |
| **README.md** | Full feature documentation |
| **MIGRATION_GUIDE.md** | Troubleshooting & configuration |
| **FIXES_APPLIED.md** | Technical details of all fixes |

## 🔑 Optional: Add API Key for Live AI

Without API key = Demo mode (limited responses)
With API key = Full AI intelligence

```bash
export Astra__OpenAI__ApiKey="sk-your-key-here"
./start.sh
```

## 💬 Try These Commands

**Chat:**
- "What is quantum physics?"
- "Tell me a joke"

**Desktop Control:**
- "open youtube"
- "search google for cats"

**Voice:**
- Click "WAKE ON"
- Say "Hey Astra open youtube"

## ❓ Having Issues?

1. **Backend won't start?** → Check INSTALLATION.md
2. **Connection refused?** → Run `./stop.sh` then `./start.sh`
3. **Voice not working?** → Use Chrome/Edge, check microphone permissions
4. **Need help?** → Read MIGRATION_GUIDE.md troubleshooting section

## 🛑 Stop ASTRA

```bash
./stop.sh
```

---

**Version:** October 5, 2026 - Fully Debugged ✅
**Status:** Production Ready 🚀

**Start by reading INSTALLATION.md for complete setup instructions!**
