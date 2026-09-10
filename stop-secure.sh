#!/usr/bin/env bash
set -euo pipefail
ROOT_MCP=/workspace/grok-bot-mcp
PID_DIR="$ROOT_MCP/run"

stop_pidfile() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local p
    p=$(cat "$f" || true)
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      sleep 0.2
      kill -9 "$p" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
}

stop_pidfile "$PID_DIR/cloudflared.pid"
stop_pidfile "$PID_DIR/gateway.pid"
stop_pidfile "$PID_DIR/mcp-cli.pid"

# Broader cleanup for this stack
pkill -f '/workspace/grok-bot-mcp/oauth-gateway/gateway.js' 2>/dev/null || true
pkill -f 'cloudflared tunnel --url http://127.0.0.1:3860' 2>/dev/null || true
pkill -f 'cloudflared tunnel --url http://localhost:3851' 2>/dev/null || true
pkill -f '/workspace/grok-bot-mcp/runtime/bin/cloudflared tunnel --url http://localhost:3851' 2>/dev/null || true
pkill -f '/workspace/grok-bot-mcp/runtime/src/server.js' 2>/dev/null || true
pkill -f '/workspace/grok-bot-mcp/node_modules/chatgpt-local-mcp/scripts/start.js' 2>/dev/null || true
pkill -f '/workspace/grok-bot-mcp/node_modules/chatgpt-local-mcp/bin/cli.js' 2>/dev/null || true

fuser -k 3851/tcp 2>/dev/null || true
fuser -k 3860/tcp 2>/dev/null || true
echo "[stop-secure] done"
