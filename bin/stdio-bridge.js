#!/usr/bin/env node
/**
 * stdio ↔ local Streamable HTTP MCP bridge.
 *
 * Speaks MCP over stdio (for Claude Desktop, Cursor command transport, etc.)
 * and forwards JSON-RPC to a loopback HTTP MCP at GROK_BOT_MCP_URL
 * (default http://127.0.0.1:3851/mcp). No OAuth — loopback only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const MCP_URL =
  process.env.GROK_BOT_MCP_URL ||
  `http://127.0.0.1:${process.env.GROK_BOT_MCP_PORT || 3851}/mcp`;

function log(...args) {
  // Never write operational logs to stdout (stdio MCP protocol).
  console.error("[stdio-bridge]", ...args);
}

async function forward(message) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
  });

  // Notifications → upstream may return 202 with empty body.
  if (res.status === 202) return null;

  const text = await res.text();
  if (!text) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Upstream returned non-JSON (${res.status}): ${text.slice(0, 200)}`
    );
  }

  if (!res.ok && data && typeof data === "object" && !("jsonrpc" in data)) {
    throw new Error(`Upstream HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

async function main() {
  log(`forwarding stdio → ${MCP_URL}`);
  const transport = new StdioServerTransport();

  transport.onmessage = async (message) => {
    try {
      const response = await forward(message);
      if (response == null) return;
      if (Array.isArray(response)) {
        for (const item of response) {
          if (item) await transport.send(item);
        }
        return;
      }
      await transport.send(response);
    } catch (err) {
      log("forward error:", err?.message || err);
      if (message && typeof message === "object" && "id" in message) {
        await transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: String(err?.message || err),
          },
        });
      }
    }
  };

  transport.onerror = (err) => {
    log("stdio error:", err?.message || err);
  };

  transport.onclose = () => {
    log("stdio closed");
    process.exit(0);
  };

  await transport.start();
}

main().catch((err) => {
  log("fatal:", err?.message || err);
  process.exit(1);
});
