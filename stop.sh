#!/bin/bash

# ASTRA shutdown: frontend → backend → agent bridge (proxy kills its own
# private OpenCode child on exit).

cd "$(dirname "$0")"

say() { printf '\033[33m%s\033[0m\n' "$*"; }

stop_port() { # stop_port <port> <name>
  local port=$1 name=$2 pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$pids" ]; then
    say "Stopping $name (PID: $(echo "$pids" | tr '\n' ' '))..."
    kill $pids 2>/dev/null
    sleep 1
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    say "✅ $name stopped"
  else
    say "⚠️  $name not running"
  fi
}

say "🛑 Stopping ASTRA..."
stop_port 5173 "Frontend"
stop_port 5175 "Backend"
stop_port 4321 "Agent bridge"

# Ports cover the process that owns the socket; the recorded PID covers the
# wrapper (npm/vite, dotnet run) that would otherwise linger as an orphan.
for f in .proxy/frontend.pid .proxy/backend.pid .proxy/proxy.pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && say "✅ stopped wrapper PID $pid"
  rm -f "$f"
done

# The proxy's private OpenCode runtime should die with it; clean up strays.
for port in 4399; do
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
done

say "✅ ASTRA stopped"
