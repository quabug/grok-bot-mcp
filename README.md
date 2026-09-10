# Grok Bot MCP

Portable **Model Context Protocol** server that exposes a **Grok Bot** tool surface to **any MCP-compatible agent** — ChatGPT, Claude Desktop/Code, Cursor, and other HTTP or stdio MCP clients.

- **Remote clients** connect over **HTTPS + OAuth 2.1** (Streamable HTTP `/mcp`).
- **Local clients** use a **stdio** bridge to the same loopback MCP (no tunnel).
- Workspace tools stay folder-scoped; an optional **agent-bridge** mailbox talks to other Grok Bot agents.

From Grok Bot, run `bash start-secure.sh` to launch this MCP, then connect it in ChatGPT, Claude, Cursor, or any MCP-compatible agent/website using the printed HTTPS URL (OAuth) or the stdio command in `examples/`.

## Features

- **Workspace tools** (via `chatgpt-local-mcp`): files, shell, git/`gh`, and related utilities, scoped to `GROK_BOT_WORKSPACE`
- **OAuth 2.1 gateway**: DCR + PKCE, owner-password consent; unauthenticated public `/mcp` → `401`
- **Cloudflare quick tunnel** in front of the gateway only (not the raw MCP port)
- **stdio bridge** (`start-stdio.sh`): Claude Desktop / Cursor command transport → `http://127.0.0.1:3851/mcp`
- **Agent bridge**: `list_agents`, `message_agent`, `check_replies` for teammate messaging

## Requirements

- Node.js 20+
- `cloudflared` (for remote HTTPS; not needed for stdio-only)
- Optional: ChatGPT Developer Mode, Claude Desktop, Cursor, or any MCP client

## Quick start

```bash
git clone git@github.com:quabug/grok-bot-mcp.git
cd grok-bot-mcp
npm install
(cd oauth-gateway && npm install)   # first time, for OAuth gateway
(cd runtime && npm install)         # first time, for HTTP MCP server
```

### Remote HTTP + OAuth (ChatGPT and other HTTPS MCP clients)

```bash
bash start-secure.sh
# or: npm run start:secure
```

Public base URL is written to `secrets/PUBLIC_BASE_URL.txt` (gitignored). Point the client at:

- **URL:** `https://<tunnel>/mcp`
- **Auth:** OAuth

Complete the consent page with the owner password from `secrets/OWNER_PASSWORD.txt` (never commit this file). See [`examples/chatgpt-connector.md`](examples/chatgpt-connector.md).

Stop:

```bash
bash stop-secure.sh
```

> Do **not** use `start.sh` for public exposure. Prefer `start-secure.sh`.

Cloudflare quick tunnels change URL on restart — update remote connectors if you restart `cloudflared`.

### Local stdio (Claude Desktop, Cursor, …)

No tunnel or OAuth required. The bridge talks to loopback MCP only:

```bash
bash start-stdio.sh
# or: npm run start:stdio
```

Example configs (replace `/ABS/PATH/TO/...`):

- [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)
- [`examples/cursor-mcp.json`](examples/cursor-mcp.json)

`ALLOW_NO_AUTH_LOCAL=1` / `AI_PC_MCP_ALLOW_NO_AUTH=true` apply on loopback so stdio clients skip OAuth. **Remote HTTPS still requires the OAuth gateway.**

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `GROK_BOT_MCP_ROOT` | directory of `start-secure.sh` / `start-stdio.sh` | Repo root (agent-bridge, scripts, secrets) |
| `GROK_BOT_WORKSPACE` | `/workspace/chatgpt` if present, else `$ROOT/../chatgpt` or `$ROOT/workspace` | Folder scope for workspace tools |
| `GROK_BOT_MCP_PORT` | `3851` | Loopback MCP HTTP port |
| `GROK_BOT_GATEWAY_PORT` | `3860` | OAuth gateway port |
| `GROK_BOT_MCP_URL` | `http://127.0.0.1:$PORT/mcp` | Upstream URL for stdio bridge |
| `ALLOW_NO_AUTH_LOCAL` | `1` when started via scripts | Documents loopback no-auth intent (with `AI_PC_MCP_ALLOW_NO_AUTH`) |

## Agent bridge

| Tool | Purpose |
|------|---------|
| `list_agents` | List Grok Bot agents discovered from local agent profiles |
| `message_agent` | Queue a message to an agent (by id or name) |
| `check_replies` | Read replies recorded in the inbox |

The MCP process **cannot** call Grok Bot’s `SendToAgent` directly. It writes an **outbox**; the parent Grok Bot agent must deliver and write replies into the **inbox**. See [`agent-bridge/PARENT.md`](agent-bridge/PARENT.md).

Mailbox (gitignored live data): `agent-bridge/outbox/`, `sent/`, `inbox/`.

## Layout

```
grok-bot-mcp/
  runtime/           # local MCP HTTP server (branded Grok Bot)
  oauth-gateway/     # OAuth 2.1 front door for remote /mcp
  agent-bridge/      # mailbox + MCP tool module + parent helpers
  bin/stdio-bridge.js
  start-secure.sh    # HTTPS + OAuth (remote)
  start-stdio.sh     # stdio bridge (local)
  stop-secure.sh
  examples/          # Claude / Cursor / ChatGPT client snippets
  secrets/           # gitignored — passwords, public URL
```

## Security

- Loopback-only MCP; public traffic hits OAuth first
- Owner password gates consent; prefer storing only the bcrypt hash long-term
- Workspace tools are folder-scoped — treat the tunnel + password as highly sensitive
- Never commit `secrets/`, live mailboxes, or tokens

## Before you publish / known issues

Worth fixing or documenting before calling this production-ready:

1. **Tunnel URL rotates** — Cloudflare quick tunnels (`*.trycloudflare.com`) get a new host every `cloudflared` restart. Remote clients (ChatGPT) must update the connector URL, or you should move to a **named Cloudflare tunnel** / stable domain.
2. **OAuth owner password** — Generated under `secrets/` (gitignored). Treat it like a root password for the MCP. Prefer rotating it and never pasting it into chat logs.
3. **ChatGPT tool cache** — After adding tools (e.g. agent-bridge), **Disconnect → Reconnect** the connector (re-consent) or ChatGPT may keep an old tool list (~53 tools without `list_agents` / `message_agent` / `check_replies`).
4. **Agent-bridge needs a parent** — MCP only queues mail. A Grok Bot agent must run a routine (or manual loop) to `SendToAgent` outbox items and `add-reply` inbox messages. Without that, ChatGPT’s `message_agent` appears to hang.
5. **Default poll is slow** — The sample routine uses `@every 5m` (platform minimum). For snappy demos, the parent should also deliver outbox items immediately when woken.
6. **`cloudflared` must exist on PATH** — Do not commit machine-specific symlinks under `runtime/bin/`. Install via package manager or let the start script locate a local binary.
7. **Workspace scope** — Tools are limited to `GROK_BOT_WORKSPACE`. Point it at an intentional folder; do not use `--bypass` / full-disk mode for shared tunnels.
8. **High privilege tools** — Shell + file write + `gh` mean a stolen OAuth session or password is serious. Keep the connector private; use OAuth (not No Auth) for any public URL.
9. **Client differences** — ChatGPT remote = HTTPS + OAuth. Claude Desktop / Cursor often prefer **stdio** (`start-stdio.sh`). Test the transport you actually ship.
10. **Repo hygiene** — Keep `secrets/`, mailboxes, `STATUS.txt`, and live PIDs out of git (see `.gitignore`).

Nice-to-haves later: named tunnel, optional Bearer for non-ChatGPT HTTP clients, faster outbox notify webhook → Grok Bot, and a one-command `doctor` script.

## Paste into Grok Bot (full setup)

Copy everything in the block below into a Grok Bot chat to have it clone, install, secure-start, wire the agent-bridge routine, and tell you how to connect ChatGPT / Claude / Cursor.

```text
Set up Grok Bot MCP on this machine end-to-end.

Repo: https://github.com/quabug/grok-bot-mcp (private; use gh as the logged-in user).

Do this:
1. Clone into a durable path if missing (prefer ~/grok-bot-mcp or /workspace/grok-bot-mcp). Set GROK_BOT_MCP_ROOT to that path.
2. Create a workspace folder for tool scope (e.g. $GROK_BOT_MCP_ROOT/../chatgpt or /workspace/chatgpt). Export GROK_BOT_WORKSPACE to it.
3. npm install at repo root; also npm install in oauth-gateway/ and runtime/ as needed.
4. Ensure cloudflared is available (install or locate on PATH). Do not commit binaries/symlinks.
5. Run: bash start-secure.sh
6. Read secrets/PUBLIC_BASE_URL.txt and confirm secrets/OWNER_PASSWORD.txt exists (mode 600). Never commit secrets or paste the password into git.
7. Create or update a Grok Bot routine named like "Grok Bot MCP agent-bridge" on @every 5m that:
   - Lists pending agent-bridge/outbox items
   - Delivers each with SendToAgent (preface: relayed from ChatGPT via Grok Bot MCP)
   - Runs agent-bridge/bin/mark-sent.sh <id>
   - On [agent] replies meant for the bridge, runs add-reply.sh so check_replies works
   - Stays quiet when outbox is empty
8. Tell me the public MCP URL (`…/mcp`), that Auth is OAuth, and the path to the owner password file (not the password itself).
9. Give short connect steps for:
   - ChatGPT Developer Mode connector (URL + OAuth; reconnect after tool changes)
   - Claude Desktop / Cursor using examples/ + start-stdio.sh
10. Smoke-check: unauthenticated public /mcp returns 401; local tools/list includes list_agents, message_agent, check_replies.

If something is already running, reuse it and report PIDs/URLs instead of duplicating. Prefer start-secure.sh over any No-Auth public exposure.
```


## License

[MIT](LICENSE) © 2026 quabug
