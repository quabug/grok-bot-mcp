// Test-only preload: never open a host browser or read/write its clipboard.
// Other subprocesses (git, archives, scripts, managed processes) remain real.
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { promisify } = require("node:util");
const { syncBuiltinESMExports } = require("node:module");
const os = require("node:os");

const realSpawn = childProcess.spawn;
const realExecFile = childProcess.execFile;
const execFileAsync = promisify(realExecFile);

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => child;
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function isClipboardRead(command, args = []) {
  return command === "pbpaste" ||
    (command === "powershell" && args.includes("Get-Clipboard")) ||
    (command === "xclip" && args.includes("-o")) ||
    (command === "xsel" && args.includes("--output"));
}

childProcess.execFile = function (command, ...rest) {
  if (!isClipboardRead(command, rest[0])) return realExecFile(command, ...rest);
  const callback = rest.at(-1);
  process.nextTick(() => callback(null, "fixture clipboard\n", ""));
  return fakeChild();
};
childProcess.execFile[promisify.custom] = (command, ...rest) => {
  if (!isClipboardRead(command, rest[0])) return execFileAsync(command, ...rest);
  return Promise.resolve({ stdout: "fixture clipboard\n", stderr: "" });
};

childProcess.spawn = function (command, args = [], options) {
  const browser = command === "open" || command === "xdg-open" ||
    command === "mcp-test-browser" || (command === "cmd" && args.includes("start"));
  const clipboard = command === "pbcopy" || command === "xclip" || command === "xsel" ||
    (command === "powershell" && args.some(arg => arg.startsWith("Set-Clipboard ")));
  if (browser || clipboard) return fakeChild();
  return realSpawn(command, args, options);
};
if (process.env.MCP_TEST_DESKTOP_PLATFORM) {
  os.platform = () => process.env.MCP_TEST_DESKTOP_PLATFORM;
}
syncBuiltinESMExports();
