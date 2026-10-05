#!/bin/bash

# ASTRA startup: agent bridge (proxy) → .NET backend → Vite frontend.
# Every service is skipped if its port is already listening.

set -u
cd "$(dirname "$0")"

log() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

mkdir -p .proxy

wait_for() { # wait_for <port> <name> [tries]
  local port=$1 name=$2 tries=${3:-40}
  for _ in $(seq 1 "$tries"); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  warn "$name did not come up on port $port"
  return 1
}

log "🚀 Starting ASTRA..."

# 1) Agent bridge: OpenAI-compatible proxy + private OpenCode runtime (4321 / 4399)
if lsof -nP -iTCP:4321 -sTCP:LISTEN >/dev/null 2>&1; then
  warn "⚠️  Agent bridge already running on 4321"
else
  log "🧠 Starting agent bridge on 4321..."
  nohup node proxy/server.js > .proxy/proxy.log 2>&1 &
  echo $! > .proxy/proxy.pid
  wait_for 4321 "Agent bridge"
fi

# 2) Backend (.NET, 5175)
if lsof -nP -iTCP:5175 -sTCP:LISTEN >/dev/null 2>&1; then
  warn "⚠️  Backend already running on 5175"
else
  log "🔧 Starting backend on 5175..."
  nohup dotnet run --project backend --urls http://localhost:5175 > .proxy/backend.log 2>&1 &
  echo $! > .proxy/backend.pid
  wait_for 5175 "Backend" 80
fi

# 3) Frontend (Vite, 5173)
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  warn "⚠️  Frontend already running on 5173"
else
  log "🎨 Starting frontend on 5173..."
  [ -d frontend/node_modules ] || npm --prefix frontend install
  # Subshell cds first; exec replaces it so $! is the real dev-server PID, and
  # the redirect/pid paths resolve from the project root (not from frontend/).
  ( cd frontend && exec npm run dev ) > .proxy/frontend.log 2>&1 &
  echo $! > .proxy/frontend.pid
  wait_for 5173 "Frontend"
fi

echo ""
log "✅ ASTRA is up"
echo "  Frontend:      http://localhost:5173"
echo "  Backend API:   http://localhost:5175/api/status"
echo "  Agent bridge:  http://127.0.0.1:4321/health"
echo "  Logs:          .proxy/*.log   Stop: ./stop.sh"
echo ""
