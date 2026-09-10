/**
 * Agent-messaging bridge for Grok Bot MCP.
 * Mailbox under /workspace/grok-bot-mcp/agent-bridge/
 * Parent Grok Bot dispatches outbox via SendToAgent; replies → inbox/.
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = __dirname;
const AGENTS_DIR = "/home/box/agent-data/agents";
const SELF_ID = "bb94f793-40f2-418c-89d3-2c1579564da6";
const NOTIFY_PATH = path.join(BRIDGE_ROOT, "NOTIFY");
const QUEUE_LOG = path.join(BRIDGE_ROOT, "notify.log");
const AGENTS_JSON = path.join(BRIDGE_ROOT, "agents.json");
const OUTBOX = path.join(BRIDGE_ROOT, "outbox");
const INBOX = path.join(BRIDGE_ROOT, "inbox");
const SENT = path.join(BRIDGE_ROOT, "sent");
const NOTIFY_PORT = Number(process.env.AGENT_BRIDGE_NOTIFY_PORT || 3861);

for (const d of [OUTBOX, INBOX, SENT]) {
  fsSync.mkdirSync(d, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

async function refreshAgents() {
  const agents = [];
  let entries = [];
  try {
    entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
  } catch (err) {
    return { agents: [], error: `Cannot read agents dir: ${err.message}` };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    const profilePath = path.join(AGENTS_DIR, id, "profile.json");
    let profile = {};
    try {
      profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
    } catch {
      // include bare dirs with id-only entry
    }
    const name = profile.name || id;
    const description = profile.description || profile.title || "";
    const item = {
      id,
      name,
      description,
      title: profile.title || "",
      serverId: profile.serverId || null,
      harness: profile.harness || null,
      self: id === SELF_ID,
    };
    agents.push(item);
  }

  agents.sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });

  await fs.writeFile(AGENTS_JSON, JSON.stringify({ refreshed_at: nowIso(), self_id: SELF_ID, agents }, null, 2) + "\n");
  return { agents, refreshed_at: nowIso(), self_id: SELF_ID };
}

function resolveAgent(agents, agentIdOrName) {
  const key = String(agentIdOrName || "").trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  // exact id
  let hit = agents.find((a) => a.id === key);
  if (hit) return hit;
  // serverId
  hit = agents.find((a) => a.serverId && String(a.serverId) === key);
  if (hit) return hit;
  // exact name (case-insensitive)
  hit = agents.find((a) => String(a.name).toLowerCase() === lower);
  if (hit) return hit;
  // partial name
  const partial = agents.filter((a) => String(a.name).toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  return null;
}

async function touchNotify(outboxId) {
  const line = `${nowIso()} outbox=${outboxId}\n`;
  await fs.writeFile(NOTIFY_PATH, line, "utf8");
  await fs.appendFile(QUEUE_LOG, line, "utf8");
}

let notifyServerStarted = false;
function ensureNotifyHttp() {
  if (notifyServerStarted) return;
  notifyServerStarted = true;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${NOTIFY_PORT}`);
      if (url.pathname === "/notify" || url.pathname === "/status") {
        let pending = [];
        try {
          const files = await fs.readdir(OUTBOX);
          pending = files.filter((f) => f.endsWith(".json"));
        } catch {}
        let notify = null;
        try {
          notify = await fs.readFile(NOTIFY_PATH, "utf8");
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          pending_outbox: pending.length,
          outbox_ids: pending.map((f) => f.replace(/\.json$/, "")),
          notify: notify?.trim() || null,
          bridge: BRIDGE_ROOT,
        }));
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      res.writeHead(500);
      res.end(String(err.message || err));
    }
  });
  server.on("error", (err) => {
    console.error(`[agent-bridge] notify HTTP ${NOTIFY_PORT}: ${err.message}`);
  });
  server.listen(NOTIFY_PORT, "127.0.0.1", () => {
    console.log(`[agent-bridge] notify HTTP on 127.0.0.1:${NOTIFY_PORT}/notify`);
  });
}

export const agentBridgeTools = [
  {
    name: "list_agents",
    description:
      "List other Grok Bot agents (and self) available for messaging. Refreshes from /home/box/agent-data/agents/*/profile.json. Returns id, name, description, serverId, and self flag.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_agent",
    description:
      "Queue a message to another Grok Bot agent via the mailbox bridge. Provide agent_id (UUID), serverId, or name, plus message text. Returns outbox id; parent agent dispatches with SendToAgent. Use check_replies later for responses.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Target agent UUID (preferred)" },
        name: { type: "string", description: "Target agent name (resolved to id)" },
        message: { type: "string", description: "Message body to send" },
      },
      required: ["message"],
    },
  },
  {
    name: "check_replies",
    description:
      "Fetch replies in the agent-bridge inbox (messages recorded by the parent after teammate responses). Optional since (ISO timestamp) and unread_only. Set mark_read=true to mark fetched messages as read.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp; only return messages created at/after this time" },
        unread_only: { type: "boolean", default: false, description: "If true, only unread inbox items" },
        mark_read: { type: "boolean", default: true, description: "Mark returned messages as read" },
      },
    },
  },
];

export async function handleAgentBridgeTool(name, args = {}) {
  ensureNotifyHttp();

  if (name === "list_agents") {
    const result = await refreshAgents();
    return {
      self_id: SELF_ID,
      count: result.agents.length,
      agents: result.agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        serverId: a.serverId,
        self: a.self,
      })),
      mailbox: BRIDGE_ROOT,
      note: "Use message_agent to queue outbound; parent dispatches via SendToAgent. check_replies for inbox.",
    };
  }

  if (name === "message_agent") {
    const message = String(args.message ?? "").trim();
    if (!message) throw new Error("message is required");
    const targetKey = args.agent_id || args.name || args.agentId || args.to;
    if (!targetKey) throw new Error("agent_id or name is required");

    const { agents } = await refreshAgents();
    const target = resolveAgent(agents, targetKey);
    if (!target) {
      throw new Error(
        `Unknown agent: ${targetKey}. Use list_agents. Known: ${agents.map((a) => `${a.name}(${a.id.slice(0, 8)})`).join(", ")}`
      );
    }
    if (target.id === SELF_ID) {
      throw new Error("Cannot message self; pick another agent from list_agents");
    }

    const id = crypto.randomUUID();
    const item = {
      id,
      to_agent_id: target.id,
      to_name: target.name,
      to_server_id: target.serverId || null,
      message,
      created_at: nowIso(),
      status: "pending",
      from_agent_id: SELF_ID,
    };
    const file = path.join(OUTBOX, `${id}.json`);
    await fs.writeFile(file, JSON.stringify(item, null, 2) + "\n");
    await touchNotify(id);

    return {
      ok: true,
      outbox_id: id,
      to_agent_id: target.id,
      to_name: target.name,
      status: "pending",
      queued: true,
      hint: "queued; use check_replies later",
      path: file,
    };
  }

  if (name === "check_replies") {
    const unreadOnly = Boolean(args.unread_only);
    const markRead = args.mark_read !== false && args.markRead !== false;
    const since = args.since ? Date.parse(String(args.since)) : null;
    if (args.since && Number.isNaN(since)) throw new Error("since must be a valid ISO timestamp");

    let files = [];
    try {
      files = (await fs.readdir(INBOX)).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }

    const messages = [];
    for (const f of files) {
      const fp = path.join(INBOX, f);
      let item;
      try {
        item = JSON.parse(await fs.readFile(fp, "utf8"));
      } catch {
        continue;
      }
      if (unreadOnly && item.read) continue;
      if (since != null) {
        const t = Date.parse(item.created_at || "");
        if (Number.isNaN(t) || t < since) continue;
      }
      messages.push({ ...item, _file: f });
    }

    messages.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    if (markRead) {
      for (const m of messages) {
        if (m.read) continue;
        m.read = true;
        const { _file, ...rest } = m;
        await fs.writeFile(path.join(INBOX, _file), JSON.stringify(rest, null, 2) + "\n");
      }
    }

    return {
      count: messages.length,
      messages: messages.map(({ _file, ...rest }) => rest),
      inbox: INBOX,
    };
  }

  return undefined;
}

// Start notify listener eagerly when module loads (MCP process)
ensureNotifyHttp();
