#!/usr/bin/env bash
# Start (or reuse) local loopback MCP, then run stdio bridge for Claude/Cursor.
# No cloudflared / OAuth tunnel required for stdio clients.
set -euo pipefail

export GROK_BOT_MCP_GENERAL_ONLY="${GROK_BOT_MCP_GENERAL_ONLY:-false}"
case "$GROK_BOT_MCP_GENERAL_ONLY" in
  true|false) ;;
  *) echo "GROK_BOT_MCP_GENERAL_ONLY must be true or false" >&2; exit 1 ;;
esac

ROOT="${GROK_BOT_MCP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
export GROK_BOT_MCP_ROOT="$ROOT"

PORT_MCP="${GROK_BOT_MCP_PORT:-3851}"
HOME_DIR="$ROOT/runtime"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/run"
PKG="$ROOT/node_modules/chatgpt-local-mcp"

# Workspace scope: prefer env, then existing /workspace/chatgpt, then siblings.
if [[ -n "${GROK_BOT_WORKSPACE:-}" ]]; then
  ROOT_SCOPE="$GROK_BOT_WORKSPACE"
elif [[ -d /workspace/chatgpt ]]; then
  ROOT_SCOPE=/workspace/chatgpt
elif [[ -d "$ROOT/../chatgpt" ]]; then
  ROOT_SCOPE="$(cd "$ROOT/../chatgpt" && pwd)"
elif [[ -d "$ROOT/workspace" ]]; then
  ROOT_SCOPE="$ROOT/workspace"
else
  ROOT_SCOPE="$ROOT/workspace"
  mkdir -p "$ROOT_SCOPE"
fi
export GROK_BOT_WORKSPACE="$ROOT_SCOPE"

mkdir -p "$LOG_DIR" "$PID_DIR" "$HOME_DIR/src"

# Ensure deps for bridge + runtime
if [[ ! -d "$ROOT/node_modules/@modelcontextprotocol/sdk" ]]; then
  echo "[stdio] installing root deps (MCP SDK)..." >&2
  (cd "$ROOT" && npm install --no-audit --no-fund) >&2
fi
if [[ ! -d "$HOME_DIR/node_modules/express" ]]; then
  echo "[stdio] installing runtime deps..." >&2
  (cd "$HOME_DIR" && npm install --omit=dev --no-audit --no-fund) >&2
fi

# Keep branded runtime/src/server.js as source of truth; sync into package copy used by cli.
if [[ -f "$HOME_DIR/src/server.js" && -d "$PKG/src" ]]; then
  cp -f "$HOME_DIR/src/server.js" "$PKG/src/server.js"
fi

ensure_local_mcp() {
  if curl -sf "http://127.0.0.1:${PORT_MCP}/health" >/dev/null 2>&1; then
    if ! curl -sf "http://127.0.0.1:${PORT_MCP}/health" | node --input-type=module -e '
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const actual = JSON.parse(input).generalOnly === true;
      process.exit(actual === (process.env.GROK_BOT_MCP_GENERAL_ONLY === "true") ? 0 : 1);
    '; then
      echo "[stdio] existing MCP has a different tool mode; restart it or choose another GROK_BOT_MCP_PORT" >&2
      exit 1
    fi
    echo "[stdio] local MCP already up on 127.0.0.1:${PORT_MCP}"
    return 0
  fi

  echo "[stdio] starting local MCP on 127.0.0.1:${PORT_MCP} (workspace=$ROOT_SCOPE)..."
  export CHATGPT_LOCAL_MCP_HOME="$HOME_DIR"
  export AI_PC_MCP_HOME="$HOME_DIR"
  export AI_PC_MCP_PORT="$PORT_MCP"
  export AI_PC_MCP_HOST="127.0.0.1"
  export AI_PC_MCP_ROOT="$ROOT_SCOPE"
  export AI_PC_MCP_DEFAULT_CWD="$ROOT_SCOPE"
  export AI_PC_MCP_BYPASS="false"
  export AI_PC_MCP_ALLOW_NO_AUTH="true"
  export ALLOW_NO_AUTH_LOCAL="${ALLOW_NO_AUTH_LOCAL:-1}"
  export AI_PC_MCP_NO_TUNNEL="true"
  export AI_PC_MCP_COMMAND_TIMEOUT_MS="${AI_PC_MCP_COMMAND_TIMEOUT_MS:-120000}"
  export GROK_BOT_MCP_ROOT="$ROOT"

  # Prefer direct branded server (portable); fall back to package cli.
  if [[ -f "$HOME_DIR/src/server.js" ]]; then
    nohup env GROK_BOT_MCP_ROOT="$ROOT" node "$HOME_DIR/src/server.js" \
      >"$LOG_DIR/mcp.out" 2>&1 &
    echo $! >"$PID_DIR/mcp-cli.pid"
  else
    nohup node "$PKG/bin/cli.js" --port "$PORT_MCP" --no-tunnel --log \
      >"$LOG_DIR/mcp.out" 2>&1 &
    echo $! >"$PID_DIR/mcp-cli.pid"
  fi

  for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${PORT_MCP}/health" >/dev/null 2>&1; then
      echo "[stdio] MCP up on 127.0.0.1:${PORT_MCP}"
      return 0
    fi
    sleep 0.25
  done
  echo "[stdio] MCP failed to start" >&2
  tail -40 "$LOG_DIR/mcp.out" >&2 || true
  exit 1
}

ensure_local_mcp >&2

export GROK_BOT_MCP_URL="${GROK_BOT_MCP_URL:-http://127.0.0.1:${PORT_MCP}/mcp}"
export GROK_BOT_MCP_PORT="$PORT_MCP"

echo "[stdio] bridge → $GROK_BOT_MCP_URL (loopback, no OAuth)" >&2
exec node "$ROOT/bin/stdio-bridge.js"
