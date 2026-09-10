#!/usr/bin/env bash
# Secure Grok Bot MCP: localhost MCP + OAuth gateway + cloudflared in front of gateway ONLY
#
# Environment (optional):
#   GROK_BOT_MCP_ROOT           Repo root (default: directory of this script)
#   GROK_BOT_WORKSPACE          Folder scope for workspace tools
#   GROK_BOT_MCP_PORT           Loopback MCP port (default 3851)
#   GROK_BOT_GATEWAY_PORT       OAuth gateway port (default 3860)
#   GROK_BOT_AGENTS_DIR         Agent profiles dir for agent-bridge
#   GROK_BOT_SELF_AGENT_ID      This agent's UUID for agent-bridge
#   GROK_BOT_PUBLIC_BASE_URL    Stable public HTTPS base (no trailing path)
#   CLOUDFLARE_TUNNEL_TOKEN     Named/stable tunnel token → cloudflared tunnel run --token
#                               (requires GROK_BOT_PUBLIC_BASE_URL for the hostname clients use)
#   GROK_BOT_SKIP_QUICK_TUNNEL  If 1 and GROK_BOT_PUBLIC_BASE_URL is set, skip starting
#                               cloudflared (assume external ingress already fronts the gateway)
#   AGENT_BRIDGE_WEBHOOK_URL    Optional outbox webhook (or agent-bridge/webhook.url)
#   ALLOW_NO_AUTH_LOCAL         Loopback no-auth (default 1 via this script)
#
# Tunnel modes (first match wins):
#   1) CLOUDFLARE_TUNNEL_TOKEN set → named tunnel (stable hostname)
#   2) GROK_BOT_PUBLIC_BASE_URL + GROK_BOT_SKIP_QUICK_TUNNEL=1 → no local tunnel
#   3) else → quick tunnel (*.trycloudflare.com); URL written to secrets/PUBLIC_BASE_URL.txt
set -euo pipefail

ROOT_MCP="${GROK_BOT_MCP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
export GROK_BOT_MCP_ROOT="$ROOT_MCP"

# Workspace scope: env → existing /workspace/chatgpt → $ROOT/../chatgpt → $ROOT/workspace
if [[ -n "${GROK_BOT_WORKSPACE:-}" ]]; then
  ROOT_SCOPE="$GROK_BOT_WORKSPACE"
elif [[ -d /workspace/chatgpt ]]; then
  ROOT_SCOPE=/workspace/chatgpt
elif [[ -d "$ROOT_MCP/../chatgpt" ]]; then
  ROOT_SCOPE="$(cd "$ROOT_MCP/../chatgpt" && pwd)"
elif [[ -d "$ROOT_MCP/workspace" ]]; then
  ROOT_SCOPE="$ROOT_MCP/workspace"
else
  ROOT_SCOPE="$ROOT_MCP/workspace"
  mkdir -p "$ROOT_SCOPE"
fi
export GROK_BOT_WORKSPACE="$ROOT_SCOPE"

PORT_MCP="${GROK_BOT_MCP_PORT:-3851}"
PORT_GW="${GROK_BOT_GATEWAY_PORT:-3860}"
HOME_DIR="$ROOT_MCP/runtime"
LOG_DIR="$ROOT_MCP/logs"
PKG="$ROOT_MCP/node_modules/chatgpt-local-mcp"
CF_BIN=""
PID_DIR="$ROOT_MCP/run"
PUBLIC_FILE="$ROOT_MCP/secrets/PUBLIC_BASE_URL.txt"
BIN_DIR="$ROOT_MCP/bin"

mkdir -p "$LOG_DIR" "$HOME_DIR/bin" "$HOME_DIR/src" "$PID_DIR" "$ROOT_MCP/secrets" "$BIN_DIR"
chmod 700 "$ROOT_MCP/secrets"

# --- Locate or install cloudflared ---
find_cloudflared() {
  local c
  # Prefer explicit / already-linked runtime copy if it resolves
  if [[ -x "$HOME_DIR/bin/cloudflared" ]]; then
    # follow symlink; ensure target still exists
    if [[ -x "$(readlink -f "$HOME_DIR/bin/cloudflared" 2>/dev/null || echo "$HOME_DIR/bin/cloudflared")" ]]; then
      echo "$HOME_DIR/bin/cloudflared"
      return 0
    fi
  fi
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi
  for c in \
    "$HOME/.local/bin/cloudflared" \
    "$BIN_DIR/cloudflared" \
    /usr/local/bin/cloudflared \
    /usr/bin/cloudflared \
    /home/box/.local/bin/cloudflared \
    /home/box/.npm/_npx/53cbb7a73c04921d/node_modules/cloudflared/bin/cloudflared \
    "$ROOT_MCP/node_modules/cloudflared/bin/cloudflared" \
    "$ROOT_MCP/node_modules/.bin/cloudflared"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  # npx cloudflared package (may download)
  if command -v npx >/dev/null 2>&1; then
    if npx --yes cloudflared --version >/dev/null 2>&1; then
      # resolve binary from npx cache / node_modules
      local npx_bin
      npx_bin="$(find "$HOME/.npm/_npx" -type f -name cloudflared 2>/dev/null | head -1 || true)"
      if [[ -n "$npx_bin" && -x "$npx_bin" ]]; then
        echo "$npx_bin"
        return 0
      fi
      local nm_bin
      nm_bin="$(find "$ROOT_MCP/node_modules" -type f -name cloudflared 2>/dev/null | head -1 || true)"
      if [[ -n "$nm_bin" && -x "$nm_bin" ]]; then
        echo "$nm_bin"
        return 0
      fi
    fi
  fi
  return 1
}

download_cloudflared() {
  local dest="$BIN_DIR/cloudflared"
  local url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
  echo "[secure] downloading cloudflared linux-amd64 → $dest" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    echo "curl/wget missing; cannot download cloudflared" >&2
    return 1
  fi
  chmod +x "$dest"
  echo "$dest"
}

CF_BIN="$(find_cloudflared || true)"
if [[ -z "$CF_BIN" ]]; then
  CF_BIN="$(download_cloudflared)" || {
    echo "cloudflared binary not found and download failed" >&2
    exit 1
  }
fi
# Stable link under runtime/bin for STATUS / stop scripts (gitignored)
ln -sfn "$CF_BIN" "$HOME_DIR/bin/cloudflared"
CF_BIN="$HOME_DIR/bin/cloudflared"
echo "[secure] cloudflared: $CF_BIN ($("$CF_BIN" --version 2>/dev/null | head -1 || echo unknown))"

echo "[secure] stopping previous stack..."
bash "$ROOT_MCP/stop-secure.sh" || true
sleep 0.5

# Free ports
fuser -k "${PORT_MCP}/tcp" 2>/dev/null || true
fuser -k "${PORT_GW}/tcp" 2>/dev/null || true
pkill -f 'runtime/bin/cloudflared tunnel --url' 2>/dev/null || true
pkill -f 'cloudflared tunnel run --token' 2>/dev/null || true
pkill -f 'oauth-gateway/gateway.js' 2>/dev/null || true
sleep 0.4

# Keep branded runtime/src/server.js as source of truth; sync into package so
# chatgpt-local-mcp's installRuntime copy preserves agent-bridge wiring.
if [[ -f "$HOME_DIR/src/server.js" && -d "$PKG/src" ]]; then
  cp -f "$HOME_DIR/src/server.js" "$PKG/src/server.js"
fi

# --- 1) Local MCP: 127.0.0.1 only, NO tunnel ---
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
export GROK_BOT_MCP_ROOT="$ROOT_MCP"

# Prefer direct branded server (avoids package overwrite of runtime/src).
cd "$ROOT_SCOPE"
if [[ -f "$HOME_DIR/src/server.js" ]]; then
  nohup env GROK_BOT_MCP_ROOT="$ROOT_MCP" \
    ${GROK_BOT_AGENTS_DIR:+GROK_BOT_AGENTS_DIR="$GROK_BOT_AGENTS_DIR"} \
    ${GROK_BOT_SELF_AGENT_ID:+GROK_BOT_SELF_AGENT_ID="$GROK_BOT_SELF_AGENT_ID"} \
    ${AGENT_BRIDGE_WEBHOOK_URL:+AGENT_BRIDGE_WEBHOOK_URL="$AGENT_BRIDGE_WEBHOOK_URL"} \
    node "$HOME_DIR/src/server.js" \
    >"$LOG_DIR/mcp.out" 2>&1 &
  echo $! >"$PID_DIR/mcp-cli.pid"
else
  nohup node "$PKG/bin/cli.js" --port "$PORT_MCP" --no-tunnel --log \
    >"$LOG_DIR/mcp.out" 2>&1 &
  echo $! >"$PID_DIR/mcp-cli.pid"
fi
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

# --- 2) cloudflared / public URL ---
TUNNEL_MODE="quick"
PUBLIC_URL=""
: >"$LOG_DIR/cloudflared-secure.log"

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  if [[ -z "${GROK_BOT_PUBLIC_BASE_URL:-}" ]]; then
    echo "[secure] CLOUDFLARE_TUNNEL_TOKEN set but GROK_BOT_PUBLIC_BASE_URL is required (stable hostname)" >&2
    exit 1
  fi
  TUNNEL_MODE="named"
  PUBLIC_URL="${GROK_BOT_PUBLIC_BASE_URL%/}"
  nohup "$CF_BIN" tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" \
    >"$LOG_DIR/cloudflared-secure.log" 2>&1 &
  echo $! >"$PID_DIR/cloudflared.pid"
  echo "[secure] named tunnel PID $(cat "$PID_DIR/cloudflared.pid") → use $PUBLIC_URL"
elif [[ -n "${GROK_BOT_PUBLIC_BASE_URL:-}" && "${GROK_BOT_SKIP_QUICK_TUNNEL:-}" == "1" ]]; then
  TUNNEL_MODE="external"
  PUBLIC_URL="${GROK_BOT_PUBLIC_BASE_URL%/}"
  rm -f "$PID_DIR/cloudflared.pid"
  echo "[secure] skipping quick tunnel; assuming external ingress at $PUBLIC_URL"
else
  TUNNEL_MODE="quick"
  nohup "$CF_BIN" tunnel --url "http://127.0.0.1:${PORT_GW}" \
    >"$LOG_DIR/cloudflared-secure.log" 2>&1 &
  echo $! >"$PID_DIR/cloudflared.pid"
  echo "[secure] cloudflared quick tunnel PID $(cat "$PID_DIR/cloudflared.pid")"

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
fi

echo "$PUBLIC_URL" >"$PUBLIC_FILE"
chmod 600 "$PUBLIC_FILE"
echo "[secure] public base $PUBLIC_URL (mode=$TUNNEL_MODE)"

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
CF_PID=$(cat "$PID_DIR/cloudflared.pid" 2>/dev/null || echo "n/a")
CLI_PID=$(cat "$PID_DIR/mcp-cli.pid")

# Write STATUS
cat >"$ROOT_MCP/STATUS.txt" << STATUS
Grok Bot MCP — SECURE (OAuth 2.1)
=================================
Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Package: chatgpt-local-mcp@1.0.3 (local) behind oauth-gateway (mcp-oauth-server)
         branded serverInfo name=grok-bot title="Grok Bot"
Root:    ${ROOT_MCP}
Workspace scope: ${ROOT_SCOPE}
Tunnel mode: ${TUNNEL_MODE}

Security model:
  - Local MCP bound to 127.0.0.1:${PORT_MCP} ONLY (no direct public exposure)
  - OAuth 2.1 gateway on 127.0.0.1:${PORT_GW}: DCR + PKCE (S256) + CIMD
  - Owner password (bcrypt) at consent page; hashed under secrets/ (mode 600)
  - /mcp requires valid OAuth Bearer with scope mcp:tools; unauthenticated → 401
  - cloudflared / external ingress fronts the OAuth gateway ONLY (not raw MCP)
  - Tools scoped to ${ROOT_SCOPE} (no --bypass)
  - Loopback / stdio clients: AI_PC_MCP_ALLOW_NO_AUTH + ALLOW_NO_AUTH_LOCAL (no OAuth)

Auth for remote MCP clients (ChatGPT, HTTP agents): OAuth
  Name: Grok Bot
  URL:  ${PUBLIC_URL}/mcp
  Auth: OAuth

Stdio local clients (Claude Desktop, Cursor):
  bash ${ROOT_MCP}/start-stdio.sh
  (see examples/claude_desktop_config.json and examples/cursor-mcp.json)

Public base: ${PUBLIC_URL}/
Local MCP:   http://127.0.0.1:${PORT_MCP}/mcp
Gateway:     http://127.0.0.1:${PORT_GW}/
Owner password file (plaintext once): $ROOT_MCP/secrets/OWNER_PASSWORD.txt
Owner password hash: $ROOT_MCP/secrets/owner_password.bcrypt
Public URL file: $PUBLIC_FILE

PIDs:
  ${CLI_PID}  MCP server (127.0.0.1:${PORT_MCP})
  ${MCP_SERVER_PID:-?}  listener pid
  ${GW_PID}  oauth-gateway/gateway.js (127.0.0.1:${PORT_GW})
  ${CF_PID}  cloudflared / tunnel (${TUNNEL_MODE})

Restart:
  bash $ROOT_MCP/stop-secure.sh
  bash $ROOT_MCP/start-secure.sh
  # Quick tunnels change URL each restart — prefer CLOUDFLARE_TUNNEL_TOKEN + GROK_BOT_PUBLIC_BASE_URL.

Do NOT use start.sh (unauthenticated public tunnel).
STATUS

echo "[secure] STATUS written"
echo "[secure] connector URL: ${PUBLIC_URL}/mcp"
