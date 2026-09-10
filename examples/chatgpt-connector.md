# ChatGPT / remote HTTP MCP clients (OAuth)

Remote agents (ChatGPT Developer Mode connectors, or any HTTP MCP client) use the
**Streamable HTTP** surface at `/mcp` behind the OAuth gateway.

## Launch

```bash
cd /path/to/grok-bot-mcp
npm install
(cd oauth-gateway && npm install)   # first time
bash start-secure.sh
```

Printed / saved URL:

- File: `secrets/PUBLIC_BASE_URL.txt`
- Connector URL: `https://<tunnel>.trycloudflare.com/mcp`
- Auth: **OAuth**

Complete the consent page with the owner password from `secrets/OWNER_PASSWORD.txt`
(never commit that file).

## Notes

- Cloudflare quick tunnels **change URL on restart** — update the connector if you
  restart `cloudflared` / `start-secure.sh`.
- Loopback MCP (`http://127.0.0.1:3851/mcp`) stays unauthenticated for local/stdio
  clients (`AI_PC_MCP_ALLOW_NO_AUTH` / `ALLOW_NO_AUTH_LOCAL=1`). Public HTTPS still
  requires the OAuth gateway.
- Workspace tools are scoped by `GROK_BOT_WORKSPACE` (see README).
