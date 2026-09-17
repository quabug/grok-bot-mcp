import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export async function launch(t, { setting, envFile, bridge = false, desktopStubs = false, desktopPlatform = "" } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-mode-"));
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
    // Never inherit a real agent notification target or desktop state in tests.
    AGENT_BRIDGE_WEBHOOK_URL: "",
    MCP_TEST_DESKTOP_PLATFORM: desktopPlatform,
    BROWSER: "", DISPLAY: "",
    AI_PC_MCP_LOG: "false",
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
  const child = spawn(process.execPath, [
    ...(desktopStubs ? ["--require", path.join(root, "test/helpers/desktop-stubs.cjs")] : []),
    path.join(root, "runtime/src/server.js"),
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { ready, rpc, temp, workspace, url, port, exited, output: () => output };
}
