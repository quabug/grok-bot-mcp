#!/usr/bin/env bash
# Secure Grok Bot MCP: localhost MCP + OAuth gateway + cloudflared in front of gateway ONLY
set -euo pipefail

ROOT_MCP=/workspace/grok-bot-mcp
ROOT_SCOPE=/workspace/chatgpt
PORT_MCP="${GROK_BOT_MCP_PORT:-3851}"
PORT_GW="${GROK_BOT_GATEWAY_PORT:-3860}"
HOME_DIR="$ROOT_MCP/runtime"
LOG_DIR="$ROOT_MCP/logs"
PKG="$ROOT_MCP/node_modules/chatgpt-local-mcp"
CF_BIN="$HOME_DIR/bin/cloudflared"
PID_DIR="$ROOT_MCP/run"
PUBLIC_FILE="$ROOT_MCP/secrets/PUBLIC_BASE_URL.txt"

mkdir -p "$LOG_DIR" "$HOME_DIR/bin" "$PID_DIR" "$ROOT_MCP/secrets"
chmod 700 "$ROOT_MCP/secrets"

# Locate cloudflared
if [[ ! -x "$CF_BIN" ]]; then
  for c in \
    /home/box/.npm/_npx/53cbb7a73c04921d/node_modules/cloudflared/bin/cloudflared \
    /usr/local/bin/cloudflared \
    /usr/bin/cloudflared \
    "$HOME_DIR/bin/cloudflared"; do
    if [[ -x "$c" ]]; then ln -sfn "$c" "$CF_BIN"; break; fi
  done
fi
if [[ ! -x "$CF_BIN" ]]; then
  echo "cloudflared binary not found" >&2
  exit 1
fi

echo "[secure] stopping previous stack..."
bash "$ROOT_MCP/stop-secure.sh" || true
sleep 0.5

# Free ports
fuser -k "${PORT_MCP}/tcp" 2>/dev/null || true
fuser -k "${PORT_GW}/tcp" 2>/dev/null || true
pkill -f 'runtime/bin/cloudflared tunnel --url' 2>/dev/null || true
pkill -f 'oauth-gateway/gateway.js' 2>/dev/null || true
sleep 0.4

# --- 1) Local MCP: 127.0.0.1 only, NO tunnel ---
export CHATGPT_LOCAL_MCP_HOME="$HOME_DIR"
export AI_PC_MCP_HOME="$HOME_DIR"
export AI_PC_MCP_PORT="$PORT_MCP"
export AI_PC_MCP_HOST="127.0.0.1"
export AI_PC_MCP_ROOT="$ROOT_SCOPE"
export AI_PC_MCP_DEFAULT_CWD="$ROOT_SCOPE"
export AI_PC_MCP_BYPASS="false"
export AI_PC_MCP_ALLOW_NO_AUTH="true"
export AI_PC_MCP_NO_TUNNEL="true"
export AI_PC_MCP_COMMAND_TIMEOUT_MS="${AI_PC_MCP_COMMAND_TIMEOUT_MS:-120000}"

rm -f "$HOME_DIR/src/server.js"
cd "$ROOT_SCOPE"
nohup node "$PKG/bin/cli.js" --port "$PORT_MCP" --no-tunnel --log \
  >"$LOG_DIR/mcp.out" 2>&1 &
echo $! >"$PID_DIR/mcp-cli.pid"
echo "[secure] MCP launcher PID $(cat "$PID_DIR/mcp-cli.pid")"

# Wait for MCP health
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${PORT_MCP}/health" >/dev/null 2>&1; then
    echo "[secure] MCP up on 127.0.0.1:${PORT_MCP}"
    break
  fi
  # some builds use /mcp only
  if curl -sf -o /dev/null -w '' -X POST "http://127.0.0.1:${PORT_MCP}/mcp" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' 2>/dev/null; then
    echo "[secure] MCP responding on /mcp"
    break
  fi
  sleep 0.25
  if [[ $i -eq 40 ]]; then
    echo "[secure] MCP failed to start" >&2
    tail -50 "$LOG_DIR/mcp.out" >&2 || true
    exit 1
  fi
done

# Confirm bound to localhost only
if ss -tlnp | grep ":${PORT_MCP}" | grep -q '127.0.0.1'; then
  echo "[secure] MCP bound to 127.0.0.1:${PORT_MCP}"
else
  echo "[secure] WARNING: MCP not clearly on 127.0.0.1 — check AI_PC_MCP_HOST" >&2
  ss -tlnp | grep ":${PORT_MCP}" || true
fi

# --- 2) Start cloudflared to gateway port (gateway not yet up → brief 502 ok) ---
: >"$LOG_DIR/cloudflared-secure.log"
nohup "$CF_BIN" tunnel --url "http://127.0.0.1:${PORT_GW}" \
  >"$LOG_DIR/cloudflared-secure.log" 2>&1 &
echo $! >"$PID_DIR/cloudflared.pid"
echo "[secure] cloudflared PID $(cat "$PID_DIR/cloudflared.pid")"

PUBLIC_URL=""
for i in $(seq 1 60); do
  PUBLIC_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$LOG_DIR/cloudflared-secure.log" | head -1 || true)
  if [[ -n "$PUBLIC_URL" ]]; then break; fi
  sleep 0.5
done
if [[ -z "$PUBLIC_URL" ]]; then
  echo "[secure] failed to obtain trycloudflare URL" >&2
  tail -40 "$LOG_DIR/cloudflared-secure.log" >&2 || true
  exit 1
fi
echo "$PUBLIC_URL" >"$PUBLIC_FILE"
chmod 600 "$PUBLIC_FILE"
echo "[secure] public base $PUBLIC_URL"

# --- 3) OAuth gateway ---
export PUBLIC_BASE_URL="$PUBLIC_URL"
export GATEWAY_PORT="$PORT_GW"
export UPSTREAM_MCP="http://127.0.0.1:${PORT_MCP}"
export OWNER_PASSWORD_HASH_FILE="$ROOT_MCP/secrets/owner_password.bcrypt"

nohup node "$ROOT_MCP/oauth-gateway/gateway.js" \
  >"$LOG_DIR/gateway.out" 2>&1 &
echo $! >"$PID_DIR/gateway.pid"
echo "[secure] gateway PID $(cat "$PID_DIR/gateway.pid")"

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${PORT_GW}/health" >/dev/null 2>&1; then
    echo "[secure] gateway healthy"
    break
  fi
  sleep 0.25
  if [[ $i -eq 40 ]]; then
    echo "[secure] gateway failed" >&2
    tail -50 "$LOG_DIR/gateway.out" >&2 || true
    exit 1
  fi
done

# Collect child PIDs for STATUS
MCP_SERVER_PID=$(ss -tlnp 2>/dev/null | grep ":${PORT_MCP}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
GW_PID=$(cat "$PID_DIR/gateway.pid")
CF_PID=$(cat "$PID_DIR/cloudflared.pid")
CLI_PID=$(cat "$PID_DIR/mcp-cli.pid")

# Write STATUS
cat >"$ROOT_MCP/STATUS.txt" << STATUS
Grok Bot MCP — SECURE (OAuth 2.1)
=================================
Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Package: chatgpt-local-mcp@1.0.3 (local) behind oauth-gateway (mcp-oauth-server)
         branded serverInfo name=grok-bot title="Grok Bot"

Security model:
  - Local MCP bound to 127.0.0.1:${PORT_MCP} ONLY (no direct public exposure)
  - OAuth 2.1 gateway on 127.0.0.1:${PORT_GW}: DCR + PKCE (S256) + CIMD (ChatGPT/OpenAI hosts)
  - Owner password (bcrypt) at consent page; hashed under secrets/ (mode 600)
  - /mcp requires valid OAuth Bearer with scope mcp:tools; unauthenticated → 401
  - cloudflared quick tunnel fronts the OAuth gateway ONLY (not raw MCP)
  - Tools scoped to /workspace/chatgpt (no --bypass)

Auth for ChatGPT connector: OAuth
  Name: Grok Bot
  URL:  ${PUBLIC_URL}/mcp
  Auth: OAuth

Public base: ${PUBLIC_URL}/
Local MCP:   http://127.0.0.1:${PORT_MCP}/mcp
Gateway:     http://127.0.0.1:${PORT_GW}/
Owner password file (plaintext once): $ROOT_MCP/secrets/OWNER_PASSWORD.txt
Owner password hash: $ROOT_MCP/secrets/owner_password.bcrypt
Public URL file: $PUBLIC_FILE

PIDs:
  ${CLI_PID}  mcp cli.js (--no-tunnel)
  ${MCP_SERVER_PID:-?}  server.js (MCP HTTP 127.0.0.1:${PORT_MCP})
  ${GW_PID}  oauth-gateway/gateway.js (127.0.0.1:${PORT_GW})
  ${CF_PID}  cloudflared -> http://127.0.0.1:${PORT_GW}

Restart:
  bash $ROOT_MCP/stop-secure.sh
  bash $ROOT_MCP/start-secure.sh
  # NOTE: trycloudflare URL changes each restart — update ChatGPT connector URL.

Do NOT use start.sh (unauthenticated public tunnel).
STATUS

echo "[secure] STATUS written"
echo "[secure] connector URL: ${PUBLIC_URL}/mcp"
