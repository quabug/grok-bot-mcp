import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { generalOutputSchemas, withOutputSchema } from "../runtime/src/output-schemas.js";
import { launch, freePort } from "./helpers/server.js";

// Validation is a development dependency only; production needs no validator.
const require = createRequire(new URL("../runtime/package.json", import.meta.url));
const Ajv = require("ajv");
const exec = promisify(execFile);

async function contracts(server) {
  const { result: { tools } } = await server.rpc("tools/list");
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validators = new Map();
  for (const tool of tools) {
    assert.equal(tool.outputSchema?.type, "object", tool.name);
    const validate = ajv.compile(tool.outputSchema);
    assert.equal(validate({}), false, tool.name + " must not accept an untyped empty result");
    assert.equal(validate("text"), false, tool.name + " must require an object");
    validators.set(tool.name, validate);
  }
  return { tools, validators };
}

function checkedCaller(server, validators) {
  const called = new Set();
  async function call(name, args = {}) {
    const message = await server.rpc("tools/call", { name, arguments: args });
    assert.ok(!message.error, JSON.stringify(message.error));
    const result = message.result;
    assert.ok(!result.isError, name + ": " + JSON.stringify(result));
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text), name + " text/JSON parity");
    const validate = validators.get(name);
    assert.ok(validate, "No advertised contract for " + name);
    assert.ok(validate(result.structuredContent), name + ": " + JSON.stringify(validate.errors));
    called.add(name);
    return result.structuredContent;
  }
  return { call, called };
}

async function until(read, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(30);
  }
  assert.fail("Timed out waiting for test-owned process");
}

test("registration rejects missing contracts, including inherited object names", () => {
  for (const name of ["new_action", "constructor", "toString"]) {
    assert.throws(() => withOutputSchema({ name }), /Missing object output schema/);
  }
  assert.throws(() => withOutputSchema({ name: "read_file", outputSchema: { type: "string" } }), /Missing object/);
  assert.equal(Object.keys(generalOutputSchemas).length, 53);
});

test("all 53 workspace actions return their advertised structured contract", { timeout: 120000 }, async t => {
  const server = await launch(t, { setting: "true", desktopStubs: true });
  await server.ready();
  const initialized = await server.rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  const { tools, validators } = await contracts(server);
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(generalOutputSchemas).sort());
  const { call, called } = checkedCaller(server, validators);

  await call("current_context");
  await call("system_info");
  await call("disk_usage", { path: "." });
  await call("create_directory", { path: "files/nested" });
  await call("write_file", { path: "files/one.txt", content: "alpha\nbeta\n" });
  await call("append_file", { path: "files/one.txt", content: "gamma\n" });
  await call("touch_file", { path: "files/empty.txt" });
  await call("copy_path", { source: "files/one.txt", destination: "files/copy.txt" });
  await call("move_path", { source: "files/copy.txt", destination: "files/moved.txt" });
  await call("make_executable", { path: "files/one.txt" });
  await call("list_directory", { path: "files", recursive: true });
  await call("directory_tree", { path: "files" });
  await call("directory_tree", { path: "does-not-exist" });
  await call("directory_tree", { path: "files", depth: 1 });
  await call("file_info", { path: "files/one.txt" });
  await call("file_info", { path: "files" });
  await call("read_file", { path: "files/one.txt" });
  await call("read_file", { path: "files/one.txt", base64: true });
  await call("read_file_lines", { path: "files/one.txt", startLine: 2, endLine: 3 });
  await call("count_lines", { path: "files/one.txt" });
  await call("hash_file", { path: "files/one.txt" });
  await call("search_files", { directory: "files", pattern: ".txt" });
  await call("search_text", { directory: "files", query: "alpha" });
  await call("replace_text", { path: "files/one.txt", search: "alpha", replace: "ALPHA" });
  await call("patch_file", { path: "files/one.txt", patches: [
    { search: "beta", replace: "BETA" }, { search: "", replace: "unused" },
  ] });
  const batch = await call("read_many_files", { paths: ["files/one.txt", "absent.txt"] });
  assert.ok(batch.files[1].error);
  const written = await call("write_many_files", { files: [
    { path: "files/batch.txt", content: "alpha" }, { path: "files", content: "cannot overwrite a directory" },
  ] });
  assert.equal(written.failed, 1);
  await call("find_replace_all", { directory: "files", search: "alpha", replace: "delta", extensions: ["txt"] });
  await call("diff_files", { pathA: "files/one.txt", pathB: "files/one.txt" });
  await call("diff_files", { pathA: "files/one.txt", pathB: "files/moved.txt" });
  await fs.writeFile(path.join(server.workspace, "large.txt"), "line\n".repeat(501));
  await call("diff_files", { pathA: "large.txt", pathB: "large.txt" });
  await call("delete_path", { path: "files/empty.txt" });

  await call("environment_set", { name: "MCP_SCHEMA_FIXTURE", value: "test" });
  await call("environment_get", { name: "MCP_SCHEMA_FIXTURE" });
  assert.equal((await call("environment_get", { name: "MCP_SCHEMA_UNSET_97B6813" })).exists, false);
  await call("environment_get", { name: "MCP_SCHEMA_SECRET_UNSET" });
  await call("environment_list", { filter: "MCP_SCHEMA_", includeValues: true });
  await call("environment_set", { name: "MCP_SCHEMA_FIXTURE", value: "persisted", persistFile: "environment.sh" });
  await call("http_request", { url: server.url + "/health" });
  assert.equal((await call("port_check", { port: server.port })).open, true);
  assert.equal((await call("port_check", { port: await freePort() })).open, false);
  await call("network_info");
  await call("list_system_processes");
  await call("run_command", { command: "echo schema-test" });
  await call("run_script", { language: "node", code: "console.log('schema-test')" });
  assert.equal((await call("run_script", { language: "node", code: "process.exit(7)" })).success, false);
  assert.equal((await call("run_script", { language: "node", code: "setInterval(() => {}, 1000)", timeout: 100 })).timedOut, true);

  // All managed commands are test-owned and self-terminate, even after a failure.
  await fs.writeFile(path.join(server.workspace, "worker.cjs"),
    "console.log('ready'); setTimeout(() => process.exit(0), 2000); process.stdin.on('data', () => process.exit(0));");
  const started = await call("start_process", { command: "node worker.cjs" });
  await until(() => call("read_process", { processId: started.processId }), value => value.stdout.includes("ready"));
  await call("list_processes");
  await call("send_to_process", { processId: started.processId, input: "exit" });
  await until(() => call("read_process", { processId: started.processId }), value => !value.running);
  assert.ok((await call("stop_process", { processId: started.processId })).process);
  const active = await call("start_process", { command: "node worker.cjs" });
  await call("stop_process", { processId: active.processId });

  await fs.mkdir(path.join(server.workspace, "repo"));
  const repo = path.join(server.workspace, "repo");
  await exec("git", ["init", "--initial-branch=main", repo]);
  await exec("git", ["-C", repo, "config", "user.name", "Schema Test"]);
  await exec("git", ["-C", repo, "config", "user.email", "schema-test@example.invalid"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  await exec("git", ["-C", repo, "config", "core.hooksPath", path.join(repo, "no-hooks")]);
  await fs.writeFile(path.join(repo, "fixture.txt"), "initial\n");
  await call("git_status", { path: "repo" });
  await call("git_commit", { path: "repo", message: "Contract test fixture" });
  await fs.appendFile(path.join(repo, "fixture.txt"), "changed\n");
  await call("git_diff", { path: "repo" });
  await call("git_log", { path: "repo" });
  await call("git_branch", { path: "repo", action: "list" });
  await call("git_branch", { path: "repo", action: "create", name: "schema-test" });
  await call("git_branch", { path: "repo", action: "switch", name: "main" });
  await call("git_branch", { path: "repo", action: "delete", name: "schema-test" });

  await fs.mkdir(path.join(server.workspace, "manifests"));
  await call("list_installed_packages", { path: "manifests" });
  await fs.writeFile(path.join(server.workspace, "manifests/package.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", scripts: { test: "node test.js" }, dependencies: { example: "1.0.0" },
  }));
  for (const filename of ["requirements.txt", "pyproject.toml", "Cargo.toml"]) {
    await fs.writeFile(path.join(server.workspace, "manifests", filename), "# fixture\n");
  }
  await call("list_installed_packages", { path: "manifests" });
  await fs.writeFile(path.join(server.workspace, "manifests/package.json"), "invalid json");
  await call("list_installed_packages", { path: "manifests", type: "npm" });
  await fs.writeFile(path.join(server.workspace, "query.json"), JSON.stringify({ n: null, list: [1], flag: true, text: "ok" }));
  for (const query of [".", "n", "list", "list[0]", "flag", "text", "missing", "toString"]) {
    await call("json_query", { path: "query.json", query });
  }
  const archive = process.platform === "win32" ? "bundle.zip" : "bundle.tar.gz";
  await call("archive_create", { sources: ["files"], destination: archive });
  await call("archive_extract", { path: archive, destination: "extracted" });
  for (const type of ["uuid", "hex", "base64", "alphanumeric"]) await call("generate_token", { type });

  // Preloaded test doubles intercept desktop subprocesses; no real desktop IO.
  await call("open_url", { url: "https://example.invalid/schema-test" });
  await call("clipboard_read");
  await call("clipboard_write", { text: "fixture text" });
  assert.deepEqual([...called].sort(), tools.map(tool => tool.name).sort(), "Every advertised action must be exercised");
});

test("all agent contracts work with empty, populated and extended mailbox data", async t => {
  const server = await launch(t, { setting: "false", bridge: true });
  await server.ready();
  const { tools, validators } = await contracts(server);
  assert.equal(tools.length, 56);
  const { call } = checkedCaller(server, validators);
  assert.ok((await call("list_agents")).error);
  assert.equal((await call("check_replies")).count, 0);
  const agentId = "11111111-1111-4111-8111-111111111111";
  const profiles = path.join(server.temp, "no-agents");
  await fs.mkdir(path.join(profiles, agentId), { recursive: true });
  await fs.writeFile(path.join(profiles, agentId, "profile.json"), JSON.stringify({ name: "Fixture", serverId: 42 }));
  await fs.mkdir(path.join(profiles, "bare-directory"));
  const agents = await call("list_agents");
  assert.equal(agents.count, 2);
  const sent = await call("message_agent", { agent_id: agentId, message: "Contract test only" });
  assert.equal(sent.webhook_notify_attempted, false);
  await fs.access(sent.path);
  const inbox = path.join(server.temp, "agent-bridge/inbox/fixture.json");
  await fs.writeFile(inbox, JSON.stringify({
    id: "fixture-reply", from_agent_id: agentId, from_name: "Fixture", message: "Done",
    created_at: new Date().toISOString(), read: false, metadata: { parentExtension: true },
  }));
  const unread = await call("check_replies", { unread_only: true, mark_read: false });
  assert.equal(unread.messages[0].read, false);
  assert.equal(unread.messages[0].metadata.parentExtension, true);
  assert.equal((await call("check_replies", { mark_read: true })).messages[0].read, true);
  assert.equal((await call("check_replies", { unread_only: true })).count, 0);
});

test("execution errors retain the MCP error envelope, not a fake success payload", async t => {
  const server = await launch(t, { setting: "true" });
  await server.ready();
  for (const [name, args] of [
    ["read_file", { path: "absent.txt" }], ["unknown_action", {}],
    ["run_script", { language: "invalid", code: "test" }], ["read_process", { processId: "missing" }],
  ]) {
    const { result } = await server.rpc("tools/call", { name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, "text");
    assert.equal(Object.hasOwn(result, "structuredContent"), false);
  }
});

for (const platform of ["linux", "darwin", "win32"]) {
  test(`desktop result variants on ${platform} use isolated subprocess doubles`, async t => {
    const server = await launch(t, { setting: "true", desktopStubs: true, desktopPlatform: platform });
    await server.ready();
    const { validators } = await contracts(server);
    const { call } = checkedCaller(server, validators);
    const opened = await call("open_url", { url: "https://example.invalid/schema-test" });
    assert.equal(opened.success, platform !== "linux");
    await call("environment_set", { name: "BROWSER", value: "mcp-test-browser" });
    assert.equal((await call("open_url", { url: "https://example.invalid/schema-test" })).success, true);
    assert.match((await call("clipboard_read")).text, /fixture clipboard/);
    await call("clipboard_write", { text: "fixture's clipboard" });
  });
}

test("command spawn failures allow an absent signal but still enforce typed fields", () => {
  const validate = new Ajv({ strict: true }).compile(generalOutputSchemas.run_script);
  const failure = {
    success: false, command: "missing-interpreter", exitCode: null, timedOut: false,
    stdout: "", stderr: "spawn ENOENT", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
  assert.equal(validate(failure), true);
  assert.equal(validate({ ...failure, exitCode: "0" }), false);
  assert.equal(validate({ ...failure, signal: 15 }), false);
});
