# Grok Bot MCP

Private MCP server that exposes a **Grok Bot** tool surface to ChatGPT (Developer Mode connectors): local workspace tools plus a mailbox bridge to other Grok Bot agents.

Built for Linux hosts that run beside Grok Bot. ChatGPT connects over **HTTPS + OAuth 2.1**; the raw MCP process stays on loopback.

## Features

- **Workspace tools** (via `chatgpt-local-mcp`): files, shell, git/`gh`, and related utilities, scoped to a workspace root (default `/workspace/chatgpt`)
- **OAuth 2.1 gateway**: DCR + PKCE, owner-password consent; unauthenticated `/mcp` → `401`
- **Cloudflare quick tunnel** in front of the gateway only (not the raw MCP port)
- **Agent bridge**: `list_agents`, `message_agent`, `check_replies` so ChatGPT can queue messages to other Grok Bot teammates (parent agent delivers with `SendToAgent`)

## Requirements

- Node.js 20+
- `cloudflared` (bundled/fetched by the local MCP stack)
- A ChatGPT plan that supports Developer Mode custom connectors
- Grok Bot on the same machine for agent messaging

## Quick start

```bash
git clone git@github.com:quabug/grok-bot-mcp.git
cd grok-bot-mcp
npm install
# also install oauth-gateway deps if needed:
# (cd oauth-gateway && npm install)

# Generate owner password (first run) and start secured stack
bash start-secure.sh
```

Public base URL is written to `secrets/PUBLIC_BASE_URL.txt` (gitignored). Point ChatGPT at:

- **URL:** `https://<tunnel>/mcp`
- **Auth:** OAuth

Complete the consent page with the owner password from `secrets/OWNER_PASSWORD.txt` (never commit this file).

Stop:

```bash
bash stop-secure.sh
```

> Do **not** use `start.sh` for production exposure — it is disabled / No-Auth oriented. Prefer `start-secure.sh`.

## ChatGPT connector

1. ChatGPT → Settings → Plugins → Developer mode → Create app  
2. Name: `Grok Bot`  
3. Server URL: value from `secrets/PUBLIC_BASE_URL.txt` + `/mcp`  
4. Authentication: **OAuth**  
5. Authorize with the owner password when prompted  

Cloudflare quick tunnels change URL on restart — update the connector if you restart `cloudflared`.

## Agent bridge

ChatGPT tools:

| Tool | Purpose |
|------|---------|
| `list_agents` | List Grok Bot agents discovered from local agent profiles |
| `message_agent` | Queue a message to an agent (by id or name) |
| `check_replies` | Read replies recorded in the inbox |

The MCP process **cannot** call Grok Bot’s `SendToAgent` directly. It writes an **outbox**; the parent Grok Bot agent must deliver and write replies into the **inbox**. See [`agent-bridge/PARENT.md`](agent-bridge/PARENT.md).

Mailbox (gitignored live data):

- `agent-bridge/outbox/` — pending
- `agent-bridge/sent/` — after dispatch
- `agent-bridge/inbox/` — teammate replies for ChatGPT

## Layout

```
grok-bot-mcp/
  runtime/           # local MCP HTTP server (branded Grok Bot)
  oauth-gateway/     # OAuth 2.1 front door
  agent-bridge/      # mailbox + MCP tool module + parent helpers
  start-secure.sh    # recommended start
  stop-secure.sh
  secrets/           # gitignored — passwords, public URL
```

## Security

- Loopback-only MCP; public traffic hits OAuth first
- Owner password gates consent; store only the bcrypt hash in long-lived config when possible
- Workspace tools are folder-scoped — treat the tunnel + password as highly sensitive
- Never commit `secrets/`, live mailboxes, or tokens

## License

[MIT](LICENSE) © 2026 quabug
