# Agent-bridge — parent dispatch instructions

Mailbox root: `<repo>/agent-bridge/`

## When ChatGPT queues a message (`message_agent`)
1. MCP writes `outbox/<uuid>.json` and touches `NOTIFY` (+ appends `notify.log`).
2. If `AGENT_BRIDGE_WEBHOOK_URL` or `webhook.url` is set, POSTs `{event:"outbox",id,to_agent_id,to_name}` (fire-and-forget).
3. Optional poll: `curl -s http://127.0.0.1:3861/notify`

## Parent loop (Grok Bot with SendToAgent)
1. `bash agent-bridge/bin/list-outbox.sh` — see pending items
2. For each pending item, call **SendToAgent** with:
   - `to_agent_id` (or resolve by name)
   - `message` body
3. On success: `bash agent-bridge/bin/mark-sent.sh <outbox-id>` (moves to `sent/`)

## When a teammate replies
Append to inbox:
```bash
bash agent-bridge/bin/add-reply.sh <from_agent_id> "reply text here"
# or
echo "reply text" | bash agent-bridge/bin/add-reply.sh <from_agent_id>
# or by name
bash agent-bridge/bin/add-reply.sh --from VPS --message "done"
```
ChatGPT then sees it via MCP tool `check_replies`.

## Layout
- `agents.json` — refreshed by `list_agents`
- `outbox/` — pending outbound
- `sent/` — archived after dispatch
- `inbox/` — replies for ChatGPT
- `NOTIFY` — last notify stamp
- `notify.log` — append-only queue log
