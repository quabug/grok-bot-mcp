import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const agentTools = ["list_agents", "message_agent", "check_replies"];

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function launch(t, { setting, envFile, bridge = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-mode-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "sample.txt"), "general tools work");
  await fs.writeFile(path.join(temp, "package.json"), '{"type":"module"}');
  if (bridge) {
    await fs.mkdir(path.join(temp, "agent-bridge"));
    await fs.copyFile(path.join(root, "agent-bridge/mcp-tools.js"), path.join(temp, "agent-bridge/mcp-tools.js"));
  }
  const configPath = path.join(temp, ".env");
  await fs.writeFile(configPath, envFile || "");
  const port = await freePort();
  const env = {
    ...process.env,
    GROK_BOT_MCP_ROOT: temp,
    GROK_BOT_AGENTS_DIR: path.join(temp, "no-agents"),
    AGENT_BRIDGE_NOTIFY_PORT: String(await freePort()),
    AI_PC_MCP_ENV_FILE: configPath,
    AI_PC_MCP_HOME: path.join(temp, "runtime"),
    AI_PC_MCP_ROOT: workspace,
    AI_PC_MCP_DEFAULT_CWD: workspace,
    AI_PC_MCP_BYPASS: "false",
    AI_PC_MCP_HOST: "127.0.0.1",
    AI_PC_MCP_PORT: String(port),
  };
  delete env.GROK_BOT_MCP_GENERAL_ONLY;
  if (setting !== undefined) env.GROK_BOT_MCP_GENERAL_ONLY = setting;
  const child = spawn(process.execPath, [path.join(root, "runtime/src/server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const url = `http://127.0.0.1:${port}`;
  async function ready() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`${url}/health`);
        if (response.ok) return response.json();
      } catch {}
      await delay(50);
    }
    throw new Error(`Server did not become ready: ${output}`);
  }
  async function rpc(method, params = {}) {
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { ready, rpc, temp, exited, output: () => output };
}

for (const config of [
  { label: "environment", setting: "true" },
  { label: "env file", envFile: "GROK_BOT_MCP_GENERAL_ONLY=true\n" },
]) {
  test(`general-only mode via ${config.label} works without an agent bridge`, async t => {
    const server = await launch(t, config);
    const health = await server.ready();
    assert.equal(health.generalOnly, true);
    assert.equal(health.id, "workspace-mcp");
    const initialized = await server.rpc("initialize");
    assert.equal(initialized.result.serverInfo.title, "Workspace MCP");
    const listed = await server.rpc("tools/list");
    const names = listed.result.tools.map(tool => tool.name);
    for (const name of ["read_file", "write_file", "run_command", "git_status", "start_process"]) {
      assert.ok(names.includes(name), name);
    }
    for (const name of agentTools) {
      assert.ok(!names.includes(name));
      const result = await server.rpc("tools/call", { name });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /Unknown tool/);
    }
    const read = await server.rpc("tools/call", { name: "read_file", arguments: { path: "sample.txt" } });
    assert.ok(!read.result.isError);
    assert.match(read.result.content[0].text, /general tools work/);
    const outside = await server.rpc("tools/call", { name: "read_file", arguments: { path: path.join(server.temp, "package.json") } });
    assert.equal(outside.result.isError, true);
    await assert.rejects(fs.access(path.join(server.temp, "agent-bridge")), { code: "ENOENT" });
  });
}

for (const setting of [undefined, "false"]) {
  test(`agent tools remain available with setting ${setting ?? "unset"}`, async t => {
    const server = await launch(t, { setting, bridge: true, envFile: setting === "false" ? "GROK_BOT_MCP_GENERAL_ONLY=true\n" : "" });
    assert.equal((await server.ready()).generalOnly, false);
    const listed = await server.rpc("tools/list");
    for (const name of agentTools) assert.ok(listed.result.tools.some(tool => tool.name === name));
    const result = await server.rpc("tools/call", { name: "check_replies" });
    assert.ok(!result.result.isError);
    await fs.access(path.join(server.temp, "agent-bridge/inbox"));
  });
}

test("invalid mode fails clearly before bridge initialization", async t => {
  const server = await launch(t, { setting: "yes" });
  const [code] = await server.exited;
  assert.notEqual(code, 0);
  assert.match(server.output(), /GROK_BOT_MCP_GENERAL_ONLY must be true or false/);
  await assert.rejects(fs.access(path.join(server.temp, "agent-bridge")), { code: "ENOENT" });
});
