import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.MCP_TEST_URL || "http://127.0.0.1:3851";
let health;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      health = await response.json();
      break;
    }
  } catch {}
  await delay(500);
}
assert.ok(health, "Container did not become healthy");
assert.equal(health.generalOnly, true);
assert.equal(health.accessRoot, "/workspace");

async function rpc(method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.ok(!message.error, JSON.stringify(message.error));
  return message.result;
}

const initialized = await rpc("initialize");
assert.equal(initialized.serverInfo.name, "workspace-mcp");
const { tools } = await rpc("tools/list");
for (const name of ["read_file", "write_file", "run_command", "git_status"]) {
  assert.ok(tools.some(tool => tool.name === name), name);
}
for (const name of ["list_agents", "message_agent", "check_replies"]) {
  assert.ok(!tools.some(tool => tool.name === name), name);
  assert.equal((await rpc("tools/call", { name })).isError, true);
}
const write = await rpc("tools/call", {
  name: "write_file", arguments: { path: "docker-smoke.txt", content: "container workspace is writable" },
});
assert.ok(!write.isError, JSON.stringify(write));
const read = await rpc("tools/call", { name: "read_file", arguments: { path: "docker-smoke.txt" } });
assert.ok(!read.isError, JSON.stringify(read));
assert.match(read.content[0].text, /container workspace is writable/);
console.log("Docker smoke test passed: general tools available, agent tools disabled, workspace writable.");
