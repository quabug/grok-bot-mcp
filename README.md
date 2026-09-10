# Grok Bot MCP

Portable **Model Context Protocol** server that exposes a **Grok Bot** tool surface to **any MCP-compatible agent** — ChatGPT, Claude Desktop/Code, Cursor, and other HTTP or stdio MCP clients.

- **Remote clients** connect over **HTTPS + OAuth 2.1** (Streamable HTTP `/mcp`).
- **Local clients** use a **stdio** bridge to the same loopback MCP (no tunnel).
- Workspace tools stay folder-scoped; an optional **agent-bridge** mailbox talks to other Grok Bot agents.

From Grok Bot, paste the **One-phase install** prompt below (or run `bash start-secure.sh`) to launch this MCP and wire agent-bridge. The install asks which MCP client(s) to connect — ChatGPT, Claude, Cursor, Codex, or your own — then gives matching connect steps.
## Use cases

What this MCP is for:

1. **Give an external AI your Grok Bot workstation** — A remote MCP client gets a scoped shell/files/`gh` workspace on the same machine as Grok Bot, without handing over the whole disk.
2. **Orchestrate Grok Bot teammates from outside** — Via agent-bridge (`list_agents` / `message_agent` / `check_replies`), a client can ask specialized agents (QA, X, VPS, research, …) and pull replies back into its own chat.
3. **End-to-end “agent of agents” pipelines** — Example: ChatGPT or Claude plans work → MCP tools edit a repo / open PRs → MCP messages a Grok Bot specialist → results return through `check_replies`.
4. **Local IDE / desktop agents** — Claude Desktop, Cursor, or Codex CLI attach over **stdio** for the same tools without a public tunnel.
5. **Secure remote demos** — HTTPS + OAuth (owner password / CIMD including `private_key_jwt`) so the connector is not a No-Auth open URL.
6. **Keep secrets and scope on your box** — Workspace root is explicit (`GROK_BOT_WORKSPACE`); credentials stay in gitignored `secrets/`; mailboxes stay local.

Not a use case by itself: hosting a public unauthenticated filesystem/shell on the internet.

<details>
<summary>Real session: how ChatGPT used Grok Bot MCP to implement ShiningPie's Yarn extension</summary>

In a real session on September 10, 2026, **ChatGPT acted as the coding agent, while Grok Bot MCP provided access to a remote development environment.** The work covered ShiningPie's Yarn tooling and the companion ParadiseEngine tray integration. ChatGPT did not hand the implementation to a separate Grok agent and wait for it to solve the task.

The interaction looked like this:

```text
User request
    ↓
ChatGPT: decide the next action and prepare code, patches, or commands
    ↓
Discover tools through api_tool
    ↓
Call Grok Bot MCP tools
    ↓
Remote workspace: files, Git, dotnet, Azure CLI, GitHub CLI
    ↓
Receive file contents, command output, exit codes, or process status
    ↓
ChatGPT: inspect the result, make corrections, and issue the next call
```

This walkthrough describes the calls and results visible in that conversation, rather than assumptions about Grok Bot's internal implementation. The paths, tool namespaces, process identifiers, and commands below are examples from that session, not required settings for every installation.

### 1. Discovering the available tools

ChatGPT first used its tool-discovery interface to load Grok Bot's available actions. For example, the following discovery call appeared in the session:

```python
api_tool.list_resources(
    paths=["Grok_Bot_MCP"],
    query="run_script"
)
```

That call **does not execute a script**. It discovers the matching functions and their argument schemas. After discovery, ChatGPT can invoke a function such as `Grok_Bot_MCP.run_script`. The `api_tool` discovery interface shown here belongs to the ChatGPT client; it is not an MCP protocol method that every client uses.

Earlier turns exposed the connector under `Grok_Bot`; later turns used `Grok_Bot_MCP`. Those are the tool namespaces shown in the conversation. The trace alone does not establish whether that naming change corresponds to a different underlying server.

There were repeated discovery calls during the session. These were not repeated clones, builds, or edits—just additional tool discovery. Several were redundant and added overhead.

### 2. Reading and changing the remote workspace

The repository operations happened under these paths in the environment reached through Grok Bot:

```text
/workspace/chatgpt/ShiningPie
/workspace/chatgpt/ParadiseEngine
```

ChatGPT used a mixture of dedicated filesystem/Git tools and command execution:

| Work | Grok Bot tools used |
|------|---------------------|
| Read source and repository guidance | `read_many_files`, `read_file_lines`, `search_text` |
| Create or modify source | `write_file`, `write_many_files`, `patch_file`, `copy_path` |
| Inspect repository changes | `git_status`, `git_diff`, plus Git commands |
| Run builds, tests, and repository operations | `run_command`, `run_script` |
| Start and inspect longer-running commands | `start_process`, `read_process` |

For example, ChatGPT read `AGENTS.md`, the existing Yarn compiler, launcher build targets, and the native tray implementations before editing them.

**ChatGPT supplied the implementation content and edits.** The MCP tools applied them to the workspace and returned results such as the number of files written or patches applied. ChatGPT then read files or diffs back to inspect the changes.

The uploaded document's `/mnt/data/...` path was separate from these remote repository paths. They should not be assumed to refer to the same filesystem.

### 3. Using `run_script` as a programmable execution interface

For multi-step operations, ChatGPT sent Python code to `run_script`. One actual call in the session had the following shape; the script body is omitted here:

```python
Grok_Bot_MCP.run_script(
    language="python",
    cwd="/workspace/chatgpt/ParadiseEngine",
    timeout=120000,
    code="...Python code..."
)
```

The returned execution records showed commands such as:

```text
python3 /tmp/mcp-script-89a02476a406.py
```

Inside those scripts, ChatGPT used `subprocess.run(...)` to invoke Git, `dotnet`, Azure CLI, and GitHub CLI. This combined related operations, parsed their JSON output, asserted expected results, and stopped when a condition failed.

A concrete example was the concurrency regression check. The script temporarily introduced a lost-edit defect, rebuilt and ran the Coyote tests, required the expected test to fail, restored the original source in a `finally` block, then rebuilt and required the tests to pass.

That was **Python executing a test procedure supplied by ChatGPT**, not a natural-language assignment sent to another agent.

### 4. Running longer commands and checking their results

For builds and test suites, ChatGPT often used `start_process`. It returned a process identifier and PID, for example:

```text
processId: proc-1789025731562-3079ba9e
pid: 969105
```

The command could continue executing while ChatGPT made other tool calls. ChatGPT subsequently used `read_process` or read its redirected log file to determine what happened.

The execution tools returned fields including:

```text
success
exitCode
timedOut
stdout
stderr
startedAt
finishedAt
```

**A successful tool invocation was not sufficient evidence that the build or tests passed.** ChatGPT inspected the actual output and test summaries.

This distinction mattered in the session: some commands combined a build with `tail` to display its log. The shell could return success because `tail` succeeded even though the earlier build failed. The logs exposed those failures, which were corrected or addressed before rerunning the checks.

### 5. Accessing Azure DevOps and GitHub through command-line tools

For this workflow, ChatGPT did not use a browser to click through Azure DevOps or GitHub, nor a separate native repository connector. It invoked the tools installed in Grok Bot's environment:

```text
git → fetch, branch, diff, commit, push
az  → Azure DevOps work items and pull requests
gh  → GitHub pull requests and account/repository queries
```

Examples from the session include:

```sh
az repos pr show --id 87 --organization https://dev.azure.com/ShiningPie
```

and:

```sh
gh pr create \
  --repo ParadiseEngine/ParadiseEngine \
  --base main \
  --head feat/tray-task-submenus \
  --title "Add project task submenus to the existing watch tray" \
  --body-file /workspace/chatgpt/ShiningPie/.editor/tray-engine-pr.md \
  --assignee quabug
```

Those commands used authentication available in that environment. For example, `gh api user` returned `quabug`. The complete credential-storage or provisioning mechanism cannot be determined from the visible execution records.

After creating or updating resources, ChatGPT queried them again to verify the saved title, source and target branches, commit, reviewer or assignee, and issue linkage.

### 6. What this was—and was not

For the ShiningPie implementation work, **ChatGPT did not use `list_agents`, `message_agent`, or `check_replies`**. Those are a different, agent-messaging workflow from the direct tool execution used here. Their absence from this workflow does not imply that the optional agent bridge is unavailable.

The distinction is:

```text
What happened:
ChatGPT → Grok Bot tool → filesystem/command → result → ChatGPT

What did not happen:
ChatGPT → message_agent("implement this") → another AI develops it independently
```

The trace also does not reveal the MCP transport configuration, the server's internal architecture, or which physical machine hosts the workspace. It shows the functions invoked and the execution environment's reported results—not a packet-level protocol trace or proof that execution occurred on the user's desktop.

**In practical terms, Grok Bot MCP functioned as ChatGPT's remote terminal, file editor, and process interface. ChatGPT directed the development and verification loop; MCP carried out the requested operations and returned their results.**

</details>

## Features

- **Workspace tools** (via `chatgpt-local-mcp`): files, shell, git/`gh`, and related utilities, scoped to `GROK_BOT_WORKSPACE`
- **OAuth 2.1 gateway**: DCR + PKCE, owner-password consent; unauthenticated public `/mcp` → `401`
- **Cloudflare tunnel** in front of the gateway only (quick tunnel by default; optional named tunnel token for a stable hostname)
- **stdio bridge** (`start-stdio.sh`): Claude Desktop / Cursor command transport → `http://127.0.0.1:3851/mcp`
- **Agent bridge**: `list_agents`, `message_agent`, `check_replies` for teammate messaging (optional webhook for faster outbox notify)
- **`npm run doctor`**: readiness checks against the live stack

## Requirements

- Node.js 20+
- `cloudflared` (for remote HTTPS; `start-secure.sh` will locate or download linux-amd64 if missing; not needed for stdio-only)
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

**Stable hostname (recommended for production):**

```bash
export CLOUDFLARE_TUNNEL_TOKEN='...'          # from Cloudflare Zero Trust → Tunnels
export GROK_BOT_PUBLIC_BASE_URL='https://mcp.example.com'
bash start-secure.sh
```

Or if ingress is already provided externally:

```bash
export GROK_BOT_PUBLIC_BASE_URL='https://mcp.example.com'
export GROK_BOT_SKIP_QUICK_TUNNEL=1
bash start-secure.sh
```

Stop:

```bash
bash stop-secure.sh
```

> Do **not** use `start.sh` for public exposure. Prefer `start-secure.sh`.

Cloudflare **quick** tunnels change URL on restart — update remote connectors, or use a named tunnel token as above.

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

### Doctor

```bash
npm run doctor
# or: bash doctor.sh
```

Checks Node version, deps, ports `3851`/`3860`/`3861`, MCP `tools/list` (agent tools), gateway `401` without auth, secrets file presence (not contents), cloudflared, outbox pending count, and optional webhook config. Exits non-zero on hard failures.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `GROK_BOT_MCP_ROOT` | directory of `start-secure.sh` / `start-stdio.sh` | Repo root (agent-bridge, scripts, secrets) |
| `GROK_BOT_WORKSPACE` | `/workspace/chatgpt` if present, else `$ROOT/../chatgpt` or `$ROOT/workspace` | Folder scope for workspace tools |
| `GROK_BOT_MCP_PORT` | `3851` | Loopback MCP HTTP port |
| `GROK_BOT_GATEWAY_PORT` | `3860` | OAuth gateway port |
| `GROK_BOT_MCP_URL` | `http://127.0.0.1:$PORT/mcp` | Upstream URL for stdio bridge |
| `GROK_BOT_AGENTS_DIR` | `/home/box/agent-data/agents` if present, else `$ROOT/../agent-data/agents` | Agent profiles for `list_agents` |
| `GROK_BOT_SELF_AGENT_ID` | legacy box UUID (override on other hosts) | This agent's id (self flag / from field) |
| `GROK_BOT_PUBLIC_BASE_URL` | (from quick tunnel) | Stable public HTTPS base for named/external ingress |
| `CLOUDFLARE_TUNNEL_TOKEN` | unset | Named Cloudflare tunnel (`cloudflared tunnel run --token`) |
| `GROK_BOT_SKIP_QUICK_TUNNEL` | unset | If `1` with `GROK_BOT_PUBLIC_BASE_URL`, do not start quick tunnel |
| `AGENT_BRIDGE_WEBHOOK_URL` | unset | POST `{event:"outbox",id,to_agent_id,to_name}` after queue (or use `agent-bridge/webhook.url`) |
| `ALLOW_NO_AUTH_LOCAL` | `1` when started via scripts | Documents loopback no-auth intent (with `AI_PC_MCP_ALLOW_NO_AUTH`) |

## Agent bridge

| Tool | Purpose |
|------|---------|
| `list_agents` | List Grok Bot agents discovered from local agent profiles |
| `message_agent` | Queue a message to an agent (by id or name); optional webhook notify |
| `check_replies` | Read replies recorded in the inbox |

The MCP process **cannot** call Grok Bot’s `SendToAgent` directly. It writes an **outbox**; the parent Grok Bot agent must deliver and write replies into the **inbox**. See [`agent-bridge/PARENT.md`](agent-bridge/PARENT.md).

Faster notify (optional): set `AGENT_BRIDGE_WEBHOOK_URL` or put the URL on the first line of `agent-bridge/webhook.url` (gitignored). On each `message_agent`, the bridge POSTs JSON `{event:"outbox", id, to_agent_id, to_name}` fire-and-forget.

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
  doctor.sh          # readiness checks
  examples/          # Claude / Cursor / ChatGPT client snippets
  secrets/           # gitignored — passwords, public URL
```

## Security

- Loopback-only MCP; public traffic hits OAuth first
- Owner password gates consent; prefer storing only the bcrypt hash long-term
- Workspace tools are folder-scoped — treat the tunnel + password as highly sensitive
- Never commit `secrets/`, live mailboxes, tokens, or downloaded `cloudflared` binaries

## Before you publish / known issues

### Fixed in-repo (this release)

1. **Faster outbox notify** — optional webhook (`AGENT_BRIDGE_WEBHOOK_URL` / `agent-bridge/webhook.url`) fires on `message_agent` (still needs a parent to `SendToAgent`).
2. **Configurable agents dir / self id** — `GROK_BOT_AGENTS_DIR`, `GROK_BOT_SELF_AGENT_ID`.
3. **`add-reply.sh` resolves names → UUID** — `from_agent_id` stored as UUID when found in `agents.json`.
4. **`cloudflared` discovery / download** — PATH, `~/.local/bin`, npm paths; can fetch linux-amd64 into gitignored `bin/cloudflared`.
5. **Stable tunnel support** — `CLOUDFLARE_TUNNEL_TOKEN` + `GROK_BOT_PUBLIC_BASE_URL`, or skip quick tunnel when external ingress is already set.
6. **`npm run doctor` / `doctor.sh`** — hard checks for Node, deps, ports, agent tools, gateway 401, secrets presence.

### Still operator-dependent

1. **Named Cloudflare tunnel token** — create a tunnel in Cloudflare Zero Trust, set `CLOUDFLARE_TUNNEL_TOKEN` + `GROK_BOT_PUBLIC_BASE_URL`. Quick tunnels still rotate on restart.
2. **ChatGPT reconnect** — after tool list changes, **Disconnect → Reconnect** the connector (re-consent) or ChatGPT may keep a stale tool cache without `list_agents` / `message_agent` / `check_replies`.
3. **Parent routine + webhook URL** — MCP only queues mail. Wire a Grok Bot routine (and preferably a webhook that wakes it) to deliver outbox → `SendToAgent` and `add-reply` for inbox. Without that, `message_agent` appears to hang.
4. **OAuth owner password** — under `secrets/` (gitignored). Treat like a root password; rotate; never paste into chat/git.
5. **Workspace scope** — point `GROK_BOT_WORKSPACE` at an intentional folder; do not use `--bypass` for shared tunnels.
6. **High privilege tools** — shell + file write + `gh` mean a stolen OAuth session is serious. Keep the connector private.
7. **Client differences** — ChatGPT remote = HTTPS + OAuth. Claude / Cursor often prefer stdio (`start-stdio.sh`).
8. **Repo hygiene** — keep `secrets/`, mailboxes, `STATUS.txt`, `webhook.url`, and binaries out of git.

## One-phase install (paste into Grok Bot)

**One phrase you can send:**

```text
Install and run https://github.com/quabug/grok-bot-mcp, wire agent-bridge to my other Grok Bot agents, ask me which MCP client(s) to connect, then finish setup for those clients.
```

**Full one-phase prompt** (copy the whole block):

```text
ONE-PHASE SETUP: Grok Bot MCP + agent-bridge + chosen MCP client(s)

Repo: https://github.com/quabug/grok-bot-mcp (private; use gh as the logged-in GitHub user).

Goal: Install the MCP on this machine, wire agent-bridge so *any* connected MCP client can message my other Grok Bot agents, then finish connect steps only for the client(s) I choose.

Before connecting a client, ASK ME which MCP client(s) to set up. Offer choices (multi-select OK) and allow a custom answer:
- ChatGPT (HTTPS + OAuth connector)
- Claude Desktop / Claude Code (usually stdio)
- Cursor (stdio or HTTP)
- Codex / Codex CLI
- Other (I will type the agent/product name and preferred transport: HTTPS+OAuth or stdio)

Do not assume ChatGPT. If I pick several, cover each. If I type my own, adapt steps to that product.

Then do:

A) Install & run MCP
1. Clone if missing (prefer /workspace/grok-bot-mcp or ~/grok-bot-mcp). Export GROK_BOT_MCP_ROOT.
2. Workspace folder for tool scope (prefer /workspace/chatgpt or $GROK_BOT_MCP_ROOT/../chatgpt). Export GROK_BOT_WORKSPACE. Set GROK_BOT_SELF_AGENT_ID to this agent's id; GROK_BOT_AGENTS_DIR if needed.
3. npm install at repo root; npm install in oauth-gateway/ and runtime/.
4. Start transport appropriately:
   - If any chosen client needs a public HTTPS URL → bash start-secure.sh (named tunnel token if available; else quick tunnel).
   - If only local stdio clients → bash start-stdio.sh may suffice (still fine to run start-secure.sh if I also want remote later).
5. npm run doctor; fix hard failures.
6. Confirm secrets paths exist when using HTTPS (PUBLIC_BASE_URL.txt, OWNER_PASSWORD.txt mode 600). Never commit secrets or paste the password into chat/git — report file paths only.

B) Wire other Grok Bot agents (agent-bridge) — always
7. Create/update routine "Grok Bot MCP agent-bridge" (webhook and/or @every 5m):
   - Flush outbox with SendToAgent (preface: relayed via Grok Bot MCP from the external client), then mark-sent.sh
   - On bridged [agent] replies: add-reply.sh so check_replies works
   - Stay quiet when outbox empty
8. Save routine Webhook URL to agent-bridge/webhook.url when available; soft-reload MCP without needlessly rotating the tunnel.
9. Smoke agent tools: list_agents / message_agent / check_replies.

C) Finish only for my chosen client(s)
10. Report MCP URL (if HTTPS), Auth mode, password file path (not value), routine/webhook status, doctor result.
11. Give short connect steps **only for the client(s) I selected** (and the custom one if any). Include reconnect-after-tool-change notes where that client caches tools.
12. Reuse running PIDs/URLs when possible. Never expose No-Auth on a public URL.
```

## License

[MIT](LICENSE) © 2026 quabug
