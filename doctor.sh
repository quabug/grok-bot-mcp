#!/usr/bin/env bash
# Health / publish readiness checks for Grok Bot MCP.
# Exit non-zero on hard failures (node, deps, MCP tools, gateway 401).
# Soft warnings (webhook, cloudflared missing when stdio-only, pending outbox) do not fail.
set -euo pipefail

export GROK_BOT_MCP_GENERAL_ONLY="${GROK_BOT_MCP_GENERAL_ONLY:-false}"
case "$GROK_BOT_MCP_GENERAL_ONLY" in
  true|false) ;;
  *) echo "GROK_BOT_MCP_GENERAL_ONLY must be true or false" >&2; exit 1 ;;
esac

ROOT_MCP="${GROK_BOT_MCP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT_MCP="${GROK_BOT_MCP_PORT:-3851}"
PORT_GW="${GROK_BOT_GATEWAY_PORT:-3860}"
PORT_NOTIFY="${AGENT_BRIDGE_NOTIFY_PORT:-3861}"
FAIL=0
WARN=0

ok() { printf '  OK  %s\n' "$*"; }
warn() { printf ' WARN %s\n' "$*"; WARN=$((WARN + 1)); }
fail() { printf ' FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }

echo "Grok Bot MCP doctor"
echo "root: $ROOT_MCP"
echo

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH"
else
  NODE_VER="$(node -v 2>/dev/null || echo unknown)"
  NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    ok "node $NODE_VER"
  else
    fail "node $NODE_VER (need 20+)"
  fi
fi

# --- Deps ---
need_dir() {
  local d="$1" label="$2"
  if [[ -d "$ROOT_MCP/$d" ]]; then
    ok "deps: $label present"
  else
    fail "deps: missing $d — run npm install${3:+ ($3)}"
  fi
}
need_dir "node_modules" "root node_modules"
need_dir "oauth-gateway/node_modules" "oauth-gateway" "cd oauth-gateway && npm install"
need_dir "runtime/node_modules" "runtime" "cd runtime && npm install"

# --- Ports ---
port_listen() {
  local port="$1"
  if ss -tln 2>/dev/null | grep -qE ":${port}\\b"; then
    return 0
  fi
  return 1
}

PORTS=("$PORT_MCP" "$PORT_GW")
if [[ "$GROK_BOT_MCP_GENERAL_ONLY" == "false" ]]; then PORTS+=("$PORT_NOTIFY"); fi
for p in "${PORTS[@]}"; do
  if port_listen "$p"; then
    ok "port $p listening"
  else
    if [[ "$p" == "$PORT_NOTIFY" ]]; then
      warn "port $p (notify) not listening — MCP may be down or agent-bridge not loaded"
    else
      fail "port $p not listening — is start-secure.sh running?"
    fi
  fi
done

# --- MCP initialize + tools/list ---
MCP_URL="http://127.0.0.1:${PORT_MCP}/mcp"
if port_listen "$PORT_MCP"; then
  INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"doctor","version":"1.0.0"}}}'
  INIT_RESP="$(curl -sf -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "$INIT_BODY" 2>/dev/null || true)"
  # Handle SSE or plain JSON
  INIT_JSON="$INIT_RESP"
  if echo "$INIT_RESP" | grep -q '^data:'; then
    INIT_JSON="$(echo "$INIT_RESP" | sed -n 's/^data: //p' | head -1)"
  fi
  if echo "$INIT_JSON" | grep -q '"result"'; then
    ok "MCP initialize"
  else
    fail "MCP initialize failed against $MCP_URL"
  fi

  # Capture session id if present (streamable HTTP)
  SESSION_HDR=()
  SID="$(curl -sD - -o /tmp/grok-bot-doctor-init.body -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "$INIT_BODY" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2; exit}')"
  if [[ -n "${SID:-}" ]]; then
    SESSION_HDR=(-H "mcp-session-id: $SID")
  fi

  # notifications/initialized (best-effort)
  curl -sf -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    "${SESSION_HDR[@]}" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null 2>&1 || true

  TOOLS_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  TOOLS_RESP="$(curl -sf -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    "${SESSION_HDR[@]}" \
    -d "$TOOLS_BODY" 2>/dev/null || true)"
  TOOLS_JSON="$TOOLS_RESP"
  if echo "$TOOLS_RESP" | grep -q '^data:'; then
    TOOLS_JSON="$(echo "$TOOLS_RESP" | sed -n 's/^data: //p' | head -1)"
  fi
  MISSING=()
  EXPECTED_TOOLS=(current_context read_file run_command)
  if [[ "$GROK_BOT_MCP_GENERAL_ONLY" == "false" ]]; then
    EXPECTED_TOOLS+=(list_agents message_agent check_replies)
  elif echo "$TOOLS_JSON" | grep -qE '"name"[[:space:]]*:[[:space:]]*"(list_agents|message_agent|check_replies)"'; then
    fail "general-only mode requested but agent tools are exposed; restart MCP with matching mode"
  fi
  for t in "${EXPECTED_TOOLS[@]}"; do
    if ! echo "$TOOLS_JSON" | grep -q "\"name\":\"$t\""; then
      # also allow spaced JSON
      if ! echo "$TOOLS_JSON" | grep -q "\"name\": \"$t\""; then
        MISSING+=("$t")
      fi
    fi
  done
  if [[ ${#MISSING[@]} -eq 0 ]]; then
    ok "tools/list includes ${EXPECTED_TOOLS[*]}"
  else
    fail "tools/list missing: ${MISSING[*]}"
  fi
else
  fail "skip MCP RPC checks (port $PORT_MCP down)"
fi

# --- Gateway 401 without auth ---
if port_listen "$PORT_GW"; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT_GW}/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' 2>/dev/null || echo 000)"
  if [[ "$CODE" == "401" ]]; then
    ok "gateway /mcp → 401 without auth"
  else
    fail "gateway /mcp expected 401 without auth, got $CODE"
  fi
else
  fail "skip gateway auth check (port $PORT_GW down)"
fi

# --- Secrets exist (not contents) ---
for f in OWNER_PASSWORD.txt owner_password.bcrypt PUBLIC_BASE_URL.txt; do
  if [[ -f "$ROOT_MCP/secrets/$f" ]]; then
    ok "secrets/$f exists"
  else
    if [[ "$f" == "PUBLIC_BASE_URL.txt" ]]; then
      warn "secrets/$f missing (run start-secure.sh or set GROK_BOT_PUBLIC_BASE_URL)"
    else
      fail "secrets/$f missing"
    fi
  fi
done

# --- cloudflared ---
CF_OK=0
if command -v cloudflared >/dev/null 2>&1; then CF_OK=1; fi
for c in \
  "$ROOT_MCP/runtime/bin/cloudflared" \
  "$ROOT_MCP/bin/cloudflared" \
  "$HOME/.local/bin/cloudflared"; do
  if [[ -x "$c" ]]; then CF_OK=1; break; fi
done
if [[ "$CF_OK" -eq 1 ]]; then
  ok "cloudflared present"
else
  warn "cloudflared not found (needed for remote HTTPS; start-secure can download)"
fi

# --- Outbox pending ---
if [[ "$GROK_BOT_MCP_GENERAL_ONLY" == "false" ]]; then
  OUTBOX="$ROOT_MCP/agent-bridge/outbox"
  PENDING=0
  if [[ -d "$OUTBOX" ]]; then
    PENDING="$(find "$OUTBOX" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  fi
  ok "outbox pending count: $PENDING"

  # --- webhook.url ---
  if [[ -n "${AGENT_BRIDGE_WEBHOOK_URL:-}" ]]; then
    ok "AGENT_BRIDGE_WEBHOOK_URL is set"
  elif [[ -f "$ROOT_MCP/agent-bridge/webhook.url" ]]; then
    ok "agent-bridge/webhook.url present"
  else
    warn "no webhook configured (AGENT_BRIDGE_WEBHOOK_URL or agent-bridge/webhook.url) — parent relies on poll/NOTIFY"
  fi

fi

echo
if [[ "$FAIL" -gt 0 ]]; then
  echo "doctor: $FAIL hard failure(s), $WARN warning(s)"
  exit 1
fi
echo "doctor: all hard checks passed ($WARN warning(s))"
exit 0
