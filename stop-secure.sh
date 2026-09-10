#!/usr/bin/env bash
set -euo pipefail
ROOT_MCP="${GROK_BOT_MCP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PID_DIR="$ROOT_MCP/run"
PORT_MCP="${GROK_BOT_MCP_PORT:-3851}"
PORT_GW="${GROK_BOT_GATEWAY_PORT:-3860}"

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

# Broader cleanup for this stack (portable patterns; avoid hard-coded /workspace)
pkill -f "$ROOT_MCP/oauth-gateway/gateway.js" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:${PORT_GW}" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://localhost:${PORT_MCP}" 2>/dev/null || true
pkill -f "$ROOT_MCP/runtime/bin/cloudflared tunnel" 2>/dev/null || true
pkill -f "$ROOT_MCP/runtime/src/server.js" 2>/dev/null || true
pkill -f "$ROOT_MCP/bin/stdio-bridge.js" 2>/dev/null || true
pkill -f "$ROOT_MCP/node_modules/chatgpt-local-mcp/scripts/start.js" 2>/dev/null || true
pkill -f "$ROOT_MCP/node_modules/chatgpt-local-mcp/bin/cli.js" 2>/dev/null || true

fuser -k "${PORT_MCP}/tcp" 2>/dev/null || true
fuser -k "${PORT_GW}/tcp" 2>/dev/null || true
echo "[stop-secure] done"
