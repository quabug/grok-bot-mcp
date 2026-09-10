#!/usr/bin/env bash
set -euo pipefail
# Stop filesystem MCP (3847) and github-mcp (3848/3850) cleanly — superseded by Grok Bot unified MCP.

kill_tree() {
  local pid="$1"
  [[ -n "$pid" && -d "/proc/$pid" ]] || return 0
  local kids
  kids=$(pgrep -P "$pid" 2>/dev/null || true)
  for k in $kids; do kill_tree "$k"; done
  kill "$pid" 2>/dev/null || true
}

# Filesystem MCP launcher + children
for pat in 'local-mcp-filesystem --dir /workspace/chatgpt' 'mcp-server-filesystem /workspace/chatgpt' 'cloudflared tunnel --url http://127.0.0.1:3847'; do
  pgrep -f "$pat" | while read -r pid; do kill_tree "$pid"; done || true
done

# GitHub MCP + host-proxy + its tunnel
for pat in '/workspace/github-mcp/start-http.sh' './github-mcp-server http' 'host-proxy.js' 'cloudflared tunnel --url http://127.0.0.1:3850'; do
  pgrep -f "$pat" | while read -r pid; do kill_tree "$pid"; done || true
done

sleep 1
# Force lingering listeners
for port in 3847 3848 3850; do
  fuser -k "${port}/tcp" 2>/dev/null || true
done
sleep 0.5
echo "Old MCP ports after stop:"
ss -tlnp | grep -E '3847|3848|3850' || echo "(none listening)"
