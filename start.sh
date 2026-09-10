#!/usr/bin/env bash
# DEPRECATED: unauthenticated public tunnel. Use start-secure.sh instead.
echo "ERROR: start.sh is disabled (would expose MCP with No Auth)." >&2
echo "Use: bash /workspace/grok-bot-mcp/start-secure.sh" >&2
exit 1
