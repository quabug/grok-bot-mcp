import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { launch } from "./helpers/server.js";

const agentTools = ["list_agents", "message_agent", "check_replies"];

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
