#!/usr/bin/env node

/**
 * chatgpt-local-mcp — server
 * A protected MCP/HTTP bridge that gives an AI assistant access to
 * filesystem, terminal, process, network, and developer tools while protecting
 * the connector's own runtime files and port from tool-initiated changes.
 */

import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import net from "net";
import crypto from "crypto";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath, pathToFileURL } from "url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveGrokBotMcpRoot() {
  if (process.env.GROK_BOT_MCP_ROOT) {
    return path.resolve(process.env.GROK_BOT_MCP_ROOT);
  }
  // Prefer directory containing package.json / start-secure.sh (repo root).
  // server.js lives at <root>/runtime/src/server.js when using the branded runtime.
  const candidates = [
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, "../../.."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    try {
      if (
        fsSync.existsSync(path.join(candidate, "package.json")) &&
        (fsSync.existsSync(path.join(candidate, "start-secure.sh")) ||
          fsSync.existsSync(path.join(candidate, "agent-bridge", "mcp-tools.js")))
      ) {
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return path.resolve(__dirname, "../..");
}

const GROK_BOT_MCP_ROOT = resolveGrokBotMcpRoot();
const agentBridgeModule = path.join(GROK_BOT_MCP_ROOT, "agent-bridge", "mcp-tools.js");
const { agentBridgeTools, handleAgentBridgeTool } = await import(
  pathToFileURL(agentBridgeModule).href
);

function loadEnvFile(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return;

  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

const inferredHome = process.env.AI_PC_MCP_HOME || path.resolve(__dirname, "..");
const envFile = process.env.AI_PC_MCP_ENV_FILE || path.join(inferredHome, ".env");
loadEnvFile(envFile);

const SERVER_NAME = "Grok Bot";
const SERVER_ID   = "grok-bot";
const VERSION     = "1.0.0";
const BYPASS_MODE = process.env.AI_PC_MCP_BYPASS === "true";
const PORT = Number(process.env.AI_PC_MCP_PORT || process.env.PORT || 3001);
const HOST = process.env.AI_PC_MCP_HOST || "0.0.0.0";
const SERVER_HOME = path.resolve(process.env.AI_PC_MCP_HOME || inferredHome);
const ACCESS_ROOT = path.resolve(process.env.AI_PC_MCP_ROOT || process.env.AI_PC_MCP_BASE_PATH || "/");
const DEFAULT_CWD = path.resolve(
  process.env.AI_PC_MCP_DEFAULT_CWD ||
    process.env.WORKSPACE_FOLDER ||
    (fsSync.existsSync("/workspaces/codespaces-blank") ? "/workspaces/codespaces-blank" : process.cwd())
);
const COMMAND_TIMEOUT_MS = Number(process.env.AI_PC_MCP_COMMAND_TIMEOUT_MS || 30000);
const PROTOCOL_VERSION = "2024-11-05";

// Path separator used in AI_PC_MCP_PROTECTED_PATHS is | (pipe).
// Pipe is illegal in file paths on both Windows and Linux, so it is safe.
// We also accept , for config file compatibility. On Linux-only deployments
// the legacy : separator still works because Linux paths never contain :.
const _pathSepRe = process.platform === "win32" ? /[|,]/g : /[|,:]/g;
const protectedPathInput = [
  SERVER_HOME,
  envFile,
  __filename,
  ...(process.env.AI_PC_MCP_PROTECTED_PATHS || "").split(_pathSepRe),
]
  .map((item) => item && item.trim())
  .filter(Boolean)
  .map((item) => path.resolve(item));

const PROTECTED_PATHS = Array.from(new Set(protectedPathInput));
const runningProcesses = new Map();
const app = express();
const liveLogClients = new Set();
const runtimeLogs = [];

// ── per-tool stats ────────────────────────────────────────────────────────────
const toolStats = new Map();   // name → { calls, errors, totalMs, lastCalled }
const sessionStart = new Date();
let totalCalls = 0;
let totalErrors = 0;

function recordToolStat(name, ms, isError) {
  const s = toolStats.get(name) || { calls: 0, errors: 0, totalMs: 0, lastCalled: null };
  s.calls++;
  s.totalMs += ms;
  s.lastCalled = new Date().toISOString();
  if (isError) s.errors++;
  toolStats.set(name, s);
  totalCalls++;
  if (isError) totalErrors++;
}

function pushLiveLog(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: String(message || "")
  };

  runtimeLogs.push(entry);
  if (runtimeLogs.length > 500) runtimeLogs.shift();

  const payload = `data: ${JSON.stringify(entry)}\n\n`;

  for (const client of liveLogClients) {
    try {
      client.write(payload);
    } catch {}
  }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

console.log = (...args) => {
  pushLiveLog("info", args.join(" "));
  originalConsoleLog(...args);
};

console.error = (...args) => {
  pushLiveLog("error", args.join(" "));
  originalConsoleError(...args);
};

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: process.env.AI_PC_MCP_JSON_LIMIT || "100mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,Accept,X-MCP-Token,Mcp-Session-Id,MCP-Protocol-Version"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

// ── request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Skip health polling and robots to avoid log noise
  if (req.path === "/health" || req.path === "/robots.txt") return next();
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "?";
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const statusColor = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    const msg = `${req.method} ${req.path} → ${res.statusCode} (${ms}ms) [${ip}]`;
    if (statusColor === "error") console.error(`[REQ] ${msg}`);
    else console.log(`[REQ] ${msg}`);
  });
  return next();
});

function isSubpath(candidate, parent) {
  // On Windows the filesystem is case-insensitive; normalise before comparing.
  let resolvedCandidate = path.resolve(candidate);
  let resolvedParent = path.resolve(parent);
  if (process.platform === "win32") {
    resolvedCandidate = resolvedCandidate.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isInsideProtectedPath(target) {
  return PROTECTED_PATHS.some((protectedPath) => isSubpath(target, protectedPath));
}

function wouldAffectProtectedPath(target) {
  return PROTECTED_PATHS.some(
    (protectedPath) => isSubpath(target, protectedPath) || isSubpath(protectedPath, target)
  );
}

function assertWithinAccessRoot(target) {
  if (!isSubpath(target, ACCESS_ROOT)) {
    throw new Error(`Access denied: ${target} is outside configured root ${ACCESS_ROOT}`);
  }
}

function assertPathAllowed(target, action = "read") {
  const resolved = path.resolve(target);
  assertWithinAccessRoot(resolved);

  if (action === "read") {
    if (isInsideProtectedPath(resolved)) {
      throw new Error(`Protected path: connector runtime files cannot be read by MCP tools (${resolved})`);
    }
    return;
  }

  if (wouldAffectProtectedPath(resolved)) {
    throw new Error(`Protected path: connector runtime files cannot be changed or deleted (${resolved})`);
  }
}

function resolveTarget(inputPath = ".", cwd = DEFAULT_CWD, action = "read") {
  const base = cwd ? path.resolve(cwd) : DEFAULT_CWD;
  assertWithinAccessRoot(base);
  if (isInsideProtectedPath(base)) {
    throw new Error(`Protected working directory: ${base}`);
  }

  const raw = String(inputPath || ".");
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  assertPathAllowed(resolved, action);
  return resolved;
}

function relativeToUsefulBase(target) {
  const resolved = path.resolve(target);
  if (isSubpath(resolved, DEFAULT_CWD)) return path.relative(DEFAULT_CWD, resolved) || ".";
  if (isSubpath(resolved, ACCESS_ROOT)) return path.relative(ACCESS_ROOT, resolved) || ".";
  return resolved;
}

function publicBaseUrl(req) {
  if (process.env.AI_PC_MCP_PUBLIC_URL) return process.env.AI_PC_MCP_PUBLIC_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, "");
}

function textResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
  };
}

function truncate(value, _max) {
  // Truncation removed — tools return full output.
  return String(value || "");
}

function safeJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val)));
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function looksSecret(name) {
  return /(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|PRIVATE|CREDENTIAL|AUTH|JWT|COOKIE|SESSION)/i.test(name);
}

function redactEnvironment(entries, includeValues = false, revealSecrets = false) {
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (!includeValues) return [key, "<hidden>"];
      if (looksSecret(key) && !revealSecrets) return [key, "<redacted>"];
      return [key, value];
    })
  );
}

function expandShellPath(token, cwd = DEFAULT_CWD) {
  if (!token) return null;
  let cleaned = String(token).trim().replace(/^['"]|['"]$/g, "");
  cleaned = cleaned.replace(/[;,|&]+$/g, "");
  if (!cleaned || cleaned.startsWith("-")) return null;
  if (cleaned === "~") cleaned = os.homedir();
  if (cleaned.startsWith("~/")) cleaned = path.join(os.homedir(), cleaned.slice(2));
  if (cleaned.startsWith("$")) return null;
  if (cleaned.includes("*") || cleaned.includes("?") || cleaned.includes("[")) return null;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
}

function shellTokens(command) {
  return String(command || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

function assertCommandAllowed(command, cwd = DEFAULT_CWD) {
  const text = String(command || "").trim();
  if (!text) throw new Error("Command is required.");

  const workingDirectory = resolveTarget(cwd || DEFAULT_CWD, DEFAULT_CWD, "read");
  if (isInsideProtectedPath(workingDirectory)) {
    throw new Error("Commands cannot run from the protected connector directory.");
  }

  // Block process-control / system commands on all platforms.
  // Linux/macOS: sudo, kill, pkill … Windows: taskkill, tskill …
  const forbiddenProcessControls = /(^|[;&|()`\s])(sudo|su|kill|pkill|killall|fuser|systemctl|service|shutdown|reboot|halt|poweroff|taskkill|tskill)\b/i;
  if (forbiddenProcessControls.test(text)) {
    throw new Error(
      "This connector blocks sudo/system/kill commands so MCP tools cannot stop the MCP port or modify protected runtime files."
    );
  }

  const serverPortPattern = new RegExp(`(:|\b)${PORT}\b`);
  if (serverPortPattern.test(text) && /\b(kill|pkill|killall|fuser|lsof\s+-ti|xargs\s+kill)\b/i.test(text)) {
    throw new Error(`Commands that can stop protected MCP port ${PORT} are blocked.`);
  }

  for (const protectedPath of PROTECTED_PATHS) {
    const aliases = [protectedPath, path.basename(protectedPath)].filter((item) => item && item.length > 4);
    if (aliases.some((alias) => text.includes(alias))) {
      if (/\b(rm|mv|cp|chmod|chown|truncate|dd|tee|sed|perl|python|node|bash|sh|cat)\b|>|>>/i.test(text)) {
        throw new Error(`Command references protected connector path: ${protectedPath}`);
      }
    }
  }

  const tokens = shellTokens(text);
  // Include Windows cmd built-ins that can delete / overwrite protected files.
  const destructiveCommands = new Set([
    "rm", "rmdir", "mv", "chmod", "chown", "truncate", "dd",
    "del", "rd", "move", "attrib", "icacls", "takeown",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const executable = path.basename(tokens[index].replace(/^['"]|['"]$/g, ""));
    if (!destructiveCommands.has(executable)) continue;

    for (const candidate of tokens.slice(index + 1)) {
      const possiblePath = expandShellPath(candidate, workingDirectory);
      if (!possiblePath) continue;
      if (wouldAffectProtectedPath(possiblePath)) {
        throw new Error(`Command would affect protected connector path: ${possiblePath}`);
      }
    }
  }

  return workingDirectory;
}

async function captureSpawn(command, args = [], options = {}) {
  const timeout = Number(options.timeout || COMMAND_TIMEOUT_MS);

  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: options.shell ?? false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500).unref();
    }, timeout);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        command: [command, ...args].join(" "),
        exitCode: null,
        timedOut,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        startedAt,
        finishedAt: new Date(),
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        success: exitCode === 0 && !timedOut,
        command: [command, ...args].join(" "),
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date(),
      });
    });
  });
}

async function listDirectory(args) {
  const directory = resolveTarget(args.path || ".", args.cwd || DEFAULT_CWD, "read");
  const recursive = Boolean(args.recursive);
  const includeHidden = args.includeHidden !== false;
  const items = [];

  async function walk(current, depth = 0) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;

      const fullPath = path.join(current, entry.name);
      if (isInsideProtectedPath(fullPath)) continue;

      try {
        const stats = await fs.lstat(fullPath);
        items.push({
          name: entry.name,
          path: relativeToUsefulBase(fullPath),
          absolutePath: fullPath,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          size: stats.size,
          modified: stats.mtime,
          permissions: `0${(stats.mode & 0o777).toString(8)}`,
        });

        if (recursive && entry.isDirectory() && depth < Number(args.depth || 5)) {
          await walk(fullPath, depth + 1);
        }
      } catch {
        // Skip entries that cannot be read.
      }
    }
  }

  await walk(directory);
  return { path: directory, count: items.length, items };
}

async function buildTree(args) {
  const root = resolveTarget(args.path || ".", args.cwd || DEFAULT_CWD, "read");
  const maxDepth = Number(args.depth || 999);
  const ignore = new Set(args.ignore || [".git", "node_modules", ".cache", "dist", "build"]);
  let count = 0;

  async function walk(current, depth) {
    count += 1;

    const node = {
      name: path.basename(current) || current,
      path: relativeToUsefulBase(current),
      type: "directory",
      children: [],
    };

    if (depth >= maxDepth) return node;

    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      node.error = "unreadable";
      return node;
    }

    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (isInsideProtectedPath(fullPath)) continue;

      if (entry.isDirectory()) {
        node.children.push(await walk(fullPath, depth + 1));
      } else {
        count += 1;
        node.children.push({
          name: entry.name,
          path: relativeToUsefulBase(fullPath),
          type: entry.isSymbolicLink() ? "symlink" : "file",
        });
      }
    }

    return node;
  }

  return { root, tree: await walk(root, 0), count };
}

async function searchFiles(args) {
  const directory = resolveTarget(args.directory || args.path || ".", args.cwd || DEFAULT_CWD, "read");
  const pattern = String(args.pattern || "");
  if (!pattern) throw new Error("pattern is required");

  const useRegex = Boolean(args.regex);
  const matcher = useRegex ? new RegExp(pattern, args.caseSensitive ? "" : "i") : null;
  const maxDepth = Number(args.depth || 9999);
  const results = [];

  async function walk(current, depth) {
    if (depth > maxDepth) return;

    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (isInsideProtectedPath(fullPath)) continue;

      const haystack = args.matchPath ? relativeToUsefulBase(fullPath) : entry.name;
      const matched = useRegex
        ? matcher.test(haystack)
        : args.caseSensitive
          ? haystack.includes(pattern)
          : haystack.toLowerCase().includes(pattern.toLowerCase());

      if (matched) {
        results.push({
          name: entry.name,
          path: relativeToUsefulBase(fullPath),
          absolutePath: fullPath,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        });
      }

      if (entry.isDirectory() && args.recursive !== false) await walk(fullPath, depth + 1);
    }
  }

  await walk(directory, 0);
  return { directory, pattern, count: results.length, results };
}

async function searchText(args) {
  const directory = resolveTarget(args.directory || args.path || ".", args.cwd || DEFAULT_CWD, "read");
  const query = String(args.query || args.pattern || "");
  if (!query) throw new Error("query is required");

  const useRegex = Boolean(args.regex);
  const matcher = useRegex ? new RegExp(query, args.caseSensitive ? "g" : "gi") : null;
  const results = [];

  async function scanFile(filePath) {
    if (isInsideProtectedPath(filePath)) return;

    let stats;
    try {
      stats = await fs.stat(filePath);
      if (!stats.isFile()) return;
    } catch {
      return;
    }

    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      return;
    }

    if (content.includes("\u0000")) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = useRegex
        ? (matcher.lastIndex = 0, matcher.test(line))
        : args.caseSensitive
          ? line.includes(query)
          : line.toLowerCase().includes(query.toLowerCase());
      if (matched) {
        results.push({
          path: relativeToUsefulBase(filePath),
          absolutePath: filePath,
          line: index + 1,
          preview: line.slice(0, 500),
        });
      }
    }
  }

  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (isInsideProtectedPath(fullPath)) continue;
      if (entry.isDirectory() && args.recursive !== false) await walk(fullPath);
      if (entry.isFile()) await scanFile(fullPath);
    }
  }

  const stats = await fs.stat(directory);
  if (stats.isFile()) await scanFile(directory);
  else await walk(directory);

  return { directory, query, count: results.length, results };
}

async function readProcessTable(args) {
  const limit = Math.min(Number(args.limit || 30), 200);

  if (os.platform() === "win32") {
    // Windows: tasklist /FO TABLE lists running processes
    const { stdout } = await execFileAsync("tasklist", ["/FO", "TABLE"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.trim().split(/\r?\n/);
    const dataCount = Math.max(lines.length - 2, 0);
    return { count: dataCount, table: lines.join("\n") };
  }

  // macOS ps does not support --sort; Linux does.
  const psArgs = os.platform() === "linux"
    ? ["-eo", "pid,ppid,stat,comm,args", "--sort=-%mem"]
    : ["-eo", "pid,ppid,stat,comm,args"];
  const { stdout } = await execFileAsync("ps", psArgs, {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const lines = stdout.trim().split(/\r?\n/);
  return { count: Math.max(lines.length - 1, 0), table: lines.join("\n") };
}

async function httpRequest(args) {
  const url = new URL(args.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// URLs are allowed.");
  if (/^(169\.254\.169\.254|metadata\.google\.internal)$/i.test(url.hostname)) {
    throw new Error("Cloud metadata endpoints are blocked.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(args.timeout || 15000), 60000));
  try {
    const response = await fetch(url, {
      method: args.method || "GET",
      headers: args.headers || {},
      body: args.body,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      url: url.toString(),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPort(args) {
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || PORT);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 2000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve({ host, port, open: true });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ host, port, open: false, reason: "timeout" });
    });
    socket.on("error", (error) => resolve({ host, port, open: false, reason: error.message }));
  });
}

function startManagedProcess(args) {
  const cwd = assertCommandAllowed(args.command, args.cwd || DEFAULT_CWD);
  const processId = `proc-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const record = {
    processId,
    command: args.command,
    cwd,
    startedAt: new Date(),
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    running: true,
  };

  const child = spawn(args.command, [], {
    cwd,
    env: { ...process.env, ...(args.env || {}) },
    shell: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  record.pid = child.pid;
  child.stdout?.on("data", (chunk) => {
    record.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    record.stderr += chunk.toString();
  });
  child.on("close", (exitCode, signal) => {
    record.exitCode = exitCode;
    record.signal = signal;
    record.running = false;
    record.finishedAt = new Date();
  });

  record.child = child;
  runningProcesses.set(processId, record);
  return { processId, pid: child.pid, command: args.command, cwd, startedAt: record.startedAt };
}

// ─── agentic coding helpers ────────────────────────────────────────────────────

async function runScript(args) {
  const lang = String(args.language || "").toLowerCase();
  const code = String(args.code || "");
  if (!code.trim()) throw new Error("code is required");
  const extMap = { node: "js", python: "py", powershell: "ps1", bash: "sh", sh: "sh" };
  const ext = extMap[lang];
  if (!ext) throw new Error(`Unsupported language: ${lang}. Use: node, python, powershell, bash, sh`);
  const tmpFile = path.join(os.tmpdir(), `mcp-script-${crypto.randomBytes(6).toString("hex")}.${ext}`);
  try {
    await fs.writeFile(tmpFile, code, "utf8");
    const cwd = args.cwd ? resolveTarget(args.cwd, DEFAULT_CWD, "read") : DEFAULT_CWD;
    const timeout = Math.min(Number(args.timeout || 30000), 300000);
    let command, cmdArgs;
    if (lang === "node") {
      command = process.execPath; cmdArgs = [tmpFile, ...(args.args || [])];
    } else if (lang === "python") {
      command = process.platform === "win32" ? "python" : "python3"; cmdArgs = [tmpFile, ...(args.args || [])];
    } else if (lang === "powershell") {
      command = "powershell"; cmdArgs = ["-NoProfile", "-NonInteractive", "-File", tmpFile];
    } else {
      command = lang === "bash" ? "bash" : "sh"; cmdArgs = [tmpFile, ...(args.args || [])];
    }
    return await captureSpawn(command, cmdArgs, { cwd, shell: false, timeout, env: args.env || {} });
  } finally {
    fs.unlink(tmpFile).catch(() => {});
  }
}

async function findReplaceAll(args) {
  const directory = resolveTarget(args.directory || args.path || ".", args.cwd || DEFAULT_CWD, "write");
  const search = String(args.search || "");
  if (!search) throw new Error("search is required");
  const replacement = String(args.replace ?? "");
  const useRegex = Boolean(args.regex);
  const caseSensitive = Boolean(args.caseSensitive);
  const extensions = args.extensions
    ? (Array.isArray(args.extensions) ? args.extensions : [args.extensions]).map((e) => (e.startsWith(".") ? e : `.${e}`))
    : null;
  const maxFiles = Math.min(Number(args.maxFiles || 500), 2000);
  const maxDepth = Math.min(Number(args.depth || 10), 20);
  const ignore = new Set(["node_modules", ".git", "dist", "build", ".cache", ...(args.ignore || [])]);
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = useRegex
    ? new RegExp(search, caseSensitive ? "g" : "gi")
    : new RegExp(escaped, caseSensitive ? "g" : "gi");
  const changed = []; const errors = []; let scanned = 0;
  async function walk(current, depth) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (changed.length >= maxFiles) return;
      const fullPath = path.join(current, entry.name);
      if (isInsideProtectedPath(fullPath)) continue;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !ignore.has(entry.name)) await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
        scanned++;
        try {
          const content = await fs.readFile(fullPath, "utf8");
          if (content.includes("\u0000")) continue;
          re.lastIndex = 0;
          if (!re.test(content)) continue;
          re.lastIndex = 0;
          const updated = content.replace(re, replacement);
          await fs.writeFile(fullPath, updated, "utf8");
          changed.push(relativeToUsefulBase(fullPath));
        } catch (err) {
          errors.push({ path: relativeToUsefulBase(fullPath), error: err.message });
        }
      }
    }
  }
  await walk(directory, 0);
  return { directory, search, replace: replacement, scanned, changedCount: changed.length, changedFiles: changed, errors };
}

// ── advanced tool helpers ─────────────────────────────────────────────────────

function computeLineDiff(textA, textB) {
  const a = textA.split(/\r?\n/);
  const b = textB.split(/\r?\n/);
  const n = a.length, m = b.length;
  const CTX = 3;

  if (n <= 500 && m <= 500) {
    // LCS-based proper diff
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);

    const ops = [];
    let i = 0, j = 0, added = 0, removed = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push({ op: " ", text: a[i] }); i++; j++; }
      else if (j < m && (i >= n || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ op: "+", text: b[j] }); j++; added++; }
      else { ops.push({ op: "-", text: a[i] }); i++; removed++; }
    }
    if (added === 0 && removed === 0) return { identical: true, aLines: n, bLines: m, diff: "" };

    const shown = new Uint8Array(ops.length);
    for (let k = 0; k < ops.length; k++)
      if (ops[k].op !== " ")
        for (let c = Math.max(0, k - CTX); c <= Math.min(ops.length - 1, k + CTX); c++) shown[c] = 1;

    const out = []; let inHunk = false;
    for (let k = 0; k < ops.length; k++) {
      if (!shown[k]) { inHunk = false; continue; }
      if (!inHunk) { out.push("@@ ... @@"); inHunk = true; }
      out.push(ops[k].op + ops[k].text);
    }
    return { identical: false, aLines: n, bLines: m, added, removed, diff: out.join("\n") };
  }

  // Large file: positional comparison
  const out = [];
  const maxLen = Math.max(n, m);
  let added = 0, removed = 0;
  for (let k = 0; k < maxLen; k++) {
    if (a[k] !== b[k]) {
      if (a[k] !== undefined) { out.push(`-[L${k + 1}] ${a[k]}`); removed++; }
      if (b[k] !== undefined) { out.push(`+[L${k + 1}] ${b[k]}`); added++; }
    }
  }
  return { identical: added === 0 && removed === 0, aLines: n, bLines: m, added, removed, diff: out.join("\n"), note: "Large file: positional diff" };
}

async function readClipboard() {
  const plat = os.platform();
  if (plat === "win32") {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"], { timeout: 5000, maxBuffer: 512 * 1024 });
    return { text: stdout.replace(/\r\n$/, "").replace(/\n$/, "") };
  }
  if (plat === "darwin") {
    const { stdout } = await execFileAsync("pbpaste", [], { timeout: 5000, maxBuffer: 512 * 1024 });
    return { text: stdout };
  }
  try {
    const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], { timeout: 5000, maxBuffer: 512 * 1024 });
    return { text: stdout };
  } catch {
    const { stdout } = await execFileAsync("xsel", ["--clipboard", "--output"], { timeout: 5000, maxBuffer: 512 * 1024 });
    return { text: stdout };
  }
}

async function writeClipboard(text) {
  const plat = os.platform();
  if (plat === "win32") {
    const escaped = text.replace(/'/g, "''");
    await captureSpawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${escaped}'`], { shell: false, timeout: 5000 });
    return { success: true, bytes: Buffer.byteLength(text) };
  }
  const [cmd, cmdArgs] = plat === "darwin"
    ? ["pbcopy", []]
    : ["xclip", ["-selection", "clipboard"]];
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(text, "utf8");
    child.on("close", resolve);
    child.on("error", reject);
  });
  return { success: true, bytes: Buffer.byteLength(text) };
}

function resolveJsonPath(data, queryPath) {
  if (!queryPath || queryPath === "." || queryPath === "$") return data;
  const keys = String(queryPath).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current = data;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[Array.isArray(current) && /^\d+$/.test(key) ? Number(key) : key];
  }
  return current;
}

async function callTool(name, args = {}, req = null) {
  switch (name) {
    case "current_context": {
      return {
        server: SERVER_NAME,
        version: VERSION,
        accessRoot: ACCESS_ROOT,
        defaultCwd: DEFAULT_CWD,
        port: PORT,
        mcpEndpoint: req ? `${publicBaseUrl(req)}/mcp` : "/mcp",
        protectedPathCount: PROTECTED_PATHS.length,
        tools: tools.length,
        scopeMode: BYPASS_MODE ? "bypass" : "folder-scoped",
        scopeRoot: ACCESS_ROOT,
        session: {
          start: sessionStart.toISOString(),
          uptimeSeconds: Math.floor(process.uptime()),
          totalCalls,
          totalErrors,
          activeProcesses: runningProcesses.size,
          liveLogClients: liveLogClients.size,
        },
      };
    }

    case "system_info": {
      return {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptimeSeconds: os.uptime(),
        user: os.userInfo().username,
        home: os.homedir(),
        temp: os.tmpdir(),
        node: process.version,
        cpus: os.cpus().map((cpu) => cpu.model),
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        loadAverage: os.loadavg(),
        accessRoot: ACCESS_ROOT,
        defaultCwd: DEFAULT_CWD,
      };
    }

    case "disk_usage": {
      const target = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "read");
      if (os.platform() === "win32") {
        // Windows: use PowerShell to get drive usage
        const { stdout, stderr } = await execFileAsync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command",
            "Get-PSDrive -PSProvider FileSystem | "
            + "Select-Object Name,"
            + "@{n='Used(GB)';e={[math]::Round($_.Used/1GB,2)}},"
            + "@{n='Free(GB)';e={[math]::Round($_.Free/1GB,2)}},"
            + "@{n='Total(GB)';e={[math]::Round(($_.Used+$_.Free)/1GB,2)}} "
            + "| Format-Table -AutoSize | Out-String"
          ],
          { timeout: 8000, maxBuffer: 1024 * 1024 }
        );
        return { target, output: stdout || stderr };
      }
      const { stdout, stderr } = await execFileAsync("df", ["-h", target], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return { target, output: stdout || stderr };
    }

    case "list_directory":
      return listDirectory(args);

    case "directory_tree":
      return buildTree(args);

    case "file_info": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const stats = await fs.lstat(target);
      return {
        path: relativeToUsefulBase(target),
        absolutePath: target,
        type: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "file",
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        permissions: `0${(stats.mode & 0o777).toString(8)}`,
        uid: stats.uid,
        gid: stats.gid,
      };
    }

    case "read_file": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const stats = await fs.stat(target);
      if (!stats.isFile()) throw new Error("Target is not a file.");
      const buffer = await fs.readFile(target);
      const offset = Number(args.offset || 0);
      const sliced = offset > 0 ? buffer.subarray(offset) : buffer;
      return {
        path: relativeToUsefulBase(target),
        absolutePath: target,
        size: buffer.length,
        encoding: args.base64 ? "base64" : args.encoding || "utf8",
        content: args.base64 ? sliced.toString("base64") : sliced.toString(args.encoding || "utf8"),
      };
    }

    case "write_file": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      await ensureParent(target);
      await fs.writeFile(target, args.content ?? "", args.encoding || "utf8");
      return { success: true, path: relativeToUsefulBase(target), absolutePath: target, bytes: Buffer.byteLength(args.content ?? "") };
    }

    case "append_file": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      await ensureParent(target);
      await fs.appendFile(target, args.content ?? "", args.encoding || "utf8");
      return { success: true, path: relativeToUsefulBase(target), absolutePath: target, appendedBytes: Buffer.byteLength(args.content ?? "") };
    }

    case "touch_file": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      await ensureParent(target);
      const now = new Date();
      if (await pathExists(target)) await fs.utimes(target, now, now);
      else await fs.writeFile(target, "");
      return { success: true, path: relativeToUsefulBase(target), absolutePath: target };
    }

    case "create_directory": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      await fs.mkdir(target, { recursive: args.recursive !== false });
      return { success: true, path: relativeToUsefulBase(target), absolutePath: target };
    }

    case "delete_path": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "delete");
      await fs.rm(target, { recursive: Boolean(args.recursive), force: Boolean(args.force) });
      return { success: true, deleted: relativeToUsefulBase(target), absolutePath: target };
    }

    case "copy_path": {
      const source = resolveTarget(args.source, args.cwd || DEFAULT_CWD, "read");
      const destination = resolveTarget(args.destination, args.cwd || DEFAULT_CWD, "write");
      await ensureParent(destination);
      const stats = await fs.stat(source);
      if (stats.isDirectory()) await fs.cp(source, destination, { recursive: true, force: args.force !== false });
      else await fs.copyFile(source, destination);
      return { success: true, source: relativeToUsefulBase(source), destination: relativeToUsefulBase(destination) };
    }

    case "move_path": {
      const source = resolveTarget(args.source, args.cwd || DEFAULT_CWD, "delete");
      const destination = resolveTarget(args.destination, args.cwd || DEFAULT_CWD, "write");
      await ensureParent(destination);
      await fs.rename(source, destination);
      return { success: true, source: relativeToUsefulBase(source), destination: relativeToUsefulBase(destination) };
    }

    case "make_executable": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      const stats = await fs.stat(target);
      await fs.chmod(target, stats.mode | 0o111);
      return { success: true, path: relativeToUsefulBase(target), permissions: "executable bits added" };
    }

    case "search_files":
      return searchFiles(args);

    case "search_text":
      return searchText(args);

    case "replace_text": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      const original = await fs.readFile(target, args.encoding || "utf8");
      const search = String(args.search ?? "");
      if (!search) throw new Error("search is required");
      const replacement = String(args.replace ?? "");
      const updated = args.regex
        ? original.replace(new RegExp(search, args.all === false ? "" : "g"), replacement)
        : args.all === false
          ? original.replace(search, replacement)
          : original.split(search).join(replacement);
      await fs.writeFile(target, updated, args.encoding || "utf8");
      return {
        success: true,
        path: relativeToUsefulBase(target),
        changed: original !== updated,
        deltaBytes: Buffer.byteLength(updated) - Buffer.byteLength(original),
      };
    }

    case "run_command": {
      const cwd = assertCommandAllowed(args.command, args.cwd || DEFAULT_CWD);
      return captureSpawn(args.command, [], {
        cwd,
        shell: true,
        timeout: Math.min(Number(args.timeout || COMMAND_TIMEOUT_MS), 10 * 60 * 1000),
        env: args.env || {},
      });
    }

    case "start_process":
      return startManagedProcess(args);

    case "read_process": {
      const record = runningProcesses.get(args.processId);
      if (!record) throw new Error("Process not found.");
      return safeJson({ ...record, child: undefined });
    }

    case "stop_process": {
      const record = runningProcesses.get(args.processId);
      if (!record) throw new Error("Process not found.");
      if (!record.running) return { success: true, message: "Process already stopped.", process: safeJson({ ...record, child: undefined }) };
      record.child.kill(args.signal || "SIGTERM");
      return { success: true, message: `Signal sent to managed process ${args.processId}.` };
    }

    case "list_processes": {
      return {
        count: runningProcesses.size,
        processes: Array.from(runningProcesses.values()).map((record) => safeJson({ ...record, child: undefined })),
      };
    }

    case "list_system_processes":
      return readProcessTable(args);

    case "environment_list": {
      const filter = args.filter ? String(args.filter).toUpperCase() : "";
      const entries = Object.entries(process.env).filter(([key]) => !filter || key.toUpperCase().includes(filter));
      return { count: entries.length, variables: redactEnvironment(entries, Boolean(args.includeValues), Boolean(args.revealSecrets)) };
    }

    case "environment_get": {
      const name = String(args.name || "");
      if (!name) throw new Error("name is required");
      const value = process.env[name];
      return {
        name,
        exists: value !== undefined,
        value: looksSecret(name) && !args.revealSecret ? "<redacted>" : value,
      };
    }

    case "environment_set": {
      const name = String(args.name || "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid environment variable name.");
      process.env[name] = String(args.value ?? "");

      let persistedTo = null;
      if (args.persistFile) {
        const persistTarget = resolveTarget(args.persistFile, args.cwd || DEFAULT_CWD, "write");
        await fs.appendFile(persistTarget, `\nexport ${name}=${JSON.stringify(String(args.value ?? ""))}\n`, "utf8");
        persistedTo = persistTarget;
      }

      return { success: true, name, processUpdated: true, persistedTo };
    }

    case "http_request":
      return httpRequest(args);

    case "port_check":
      return checkPort(args);

    case "git_status": {
      const repo = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "read");
      const { stdout, stderr } = await execFileAsync("git", ["-C", repo, "status", "--short", "--branch"], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      return { repo, output: stdout || stderr };
    }

    case "git_diff": {
      const repo = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "read");
      const diffArgs = ["-C", repo, "--no-pager", "diff"];
      if (args.staged) diffArgs.push("--staged");
      if (args.file) diffArgs.push("--", args.file);
      const { stdout, stderr } = await execFileAsync("git", diffArgs, { timeout: 10000, maxBuffer: 512 * 1024 * 1024 });
      return { repo, output: stdout || stderr };
    }

    case "open_url": {
      const url = new URL(args.url).toString();
      let child;
      if (os.platform() === "win32") {
        // Windows: 'start' is a cmd built-in; use cmd /c start
        child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
      } else if (os.platform() === "darwin") {
        child = spawn("open", [url], { detached: true, stdio: "ignore" });
      } else {
        const browser = process.env.BROWSER || (process.env.DISPLAY ? "xdg-open" : null);
        if (!browser) return { success: false, message: "No browser available in this headless environment.", url };
        child = spawn(browser, [url], { detached: true, stdio: "ignore" });
      }
      child.unref();
      return { success: true, url };
    }

    // ─── agentic coding tools ──────────────────────────────────────────────────

    case "read_file_lines": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const stats = await fs.stat(target);
      if (!stats.isFile()) throw new Error("Target is not a file.");
      const content = await fs.readFile(target, "utf8");
      const allLines = content.split(/\r?\n/);
      const totalLines = allLines.length;
      const startLine = Math.max(1, Number(args.startLine || 1));
      const endLine = args.endLine !== undefined
        ? Math.min(totalLines, Number(args.endLine))
        : totalLines;
      if (startLine > totalLines) throw new Error(`startLine (${startLine}) exceeds file length (${totalLines} lines)`);
      const slice = allLines.slice(startLine - 1, endLine);
      return {
        path: relativeToUsefulBase(target),
        absolutePath: target,
        totalLines,
        startLine,
        endLine: Math.min(endLine, totalLines),
        returnedLines: slice.length,
        content: slice.join("\n"),
      };
    }

    case "patch_file": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "write");
      let content = await fs.readFile(target, args.encoding || "utf8");
      const patches = Array.isArray(args.patches) ? args.patches : [];
      if (!patches.length) throw new Error("patches array is required and must not be empty");
      const results = [];
      for (const patch of patches) {
        const searchStr = String(patch.search ?? "");
        const replaceStr = String(patch.replace ?? "");
        if (!searchStr) { results.push({ search: searchStr, applied: false, reason: "empty search" }); continue; }
        const before = content;
        if (patch.regex) {
          content = content.replace(new RegExp(searchStr, patch.all === false ? "" : "g"), replaceStr);
        } else {
          content = patch.all === false ? content.replace(searchStr, replaceStr) : content.split(searchStr).join(replaceStr);
        }
        results.push({ search: searchStr.slice(0, 80), applied: content !== before });
      }
      await fs.writeFile(target, content, args.encoding || "utf8");
      return {
        success: true,
        path: relativeToUsefulBase(target),
        patchCount: patches.length,
        applied: results.filter((r) => r.applied).length,
        results,
      };
    }

    case "read_many_files": {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      if (!paths.length) throw new Error("paths array is required and must not be empty");
      const files = await Promise.all(
        paths.map(async (p) => {
          try {
            const target = resolveTarget(p, args.cwd || DEFAULT_CWD, "read");
            const buffer = await fs.readFile(target);
            return {
              path: relativeToUsefulBase(target),
              absolutePath: target,
              size: buffer.length,
              content: buffer.toString(args.encoding || "utf8"),
            };
          } catch (err) {
            return { path: p, error: err.message };
          }
        })
      );
      return { count: files.length, files };
    }

    case "write_many_files": {
      const files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) throw new Error("files array is required and must not be empty");
      const defaultEncoding = args.encoding || "utf8";
      const results = await Promise.all(
        files.map(async (f) => {
          try {
            const target = resolveTarget(f.path, args.cwd || DEFAULT_CWD, "write");
            await ensureParent(target);
            await fs.writeFile(target, f.content ?? "", f.encoding || defaultEncoding);
            return { path: relativeToUsefulBase(target), success: true, bytes: Buffer.byteLength(f.content ?? "") };
          } catch (err) {
            return { path: f.path, success: false, error: err.message };
          }
        })
      );
      const succeeded = results.filter((r) => r.success).length;
      return { total: files.length, succeeded, failed: files.length - succeeded, results };
    }

    case "git_log": {
      const repo = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "read");
      const limit = Math.min(Number(args.limit || 20), 200);
      const GIT_SEP = "---GIT-LOG-RECORD---";
      const logArgs = [
        "-C", repo, "--no-pager", "log",
        `--max-count=${limit}`,
        `--pretty=format:${GIT_SEP}%n%H%n%h%n%an%n%ae%n%ai%n%s`,
        ...(args.file ? ["--", args.file] : []),
      ];
      const { stdout, stderr } = await execFileAsync("git", logArgs, { timeout: 15000, maxBuffer: 512 * 1024 * 1024 });
      if (!stdout && stderr) throw new Error(stderr.trim());
      const blocks = stdout.split(GIT_SEP).filter((b) => b.trim());
      const commits = blocks.map((block) => {
        const lines = block.trim().split("\n");
        const [hash, shortHash, authorName, authorEmail, date, ...rest] = lines;
        return { hash, shortHash, author: { name: authorName, email: authorEmail }, date, subject: rest.join(" ").trim() };
      });
      return { repo, count: commits.length, commits };
    }

    case "git_commit": {
      const repo = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "write");
      const message = String(args.message || "");
      if (!message) throw new Error("message is required");
      const toAdd = args.add !== undefined
        ? (Array.isArray(args.add) ? args.add : [String(args.add)])
        : ["."];
      await execFileAsync("git", ["-C", repo, "add", ...toAdd], { timeout: 15000, maxBuffer: 1024 * 1024 });
      const commitArgs = ["-C", repo, "commit", "-m", message];
      if (args.noVerify) commitArgs.push("--no-verify");
      const { stdout, stderr } = await execFileAsync("git", commitArgs, { timeout: 15000, maxBuffer: 1024 * 1024 });
      return { repo, success: true, output: (stdout || stderr || "").trim() };
    }

    case "git_branch": {
      const repo = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "read");
      const action = String(args.action || "list");
      if (action === "list") {
        const [{ stdout: branchOut }, { stdout: currentOut }] = await Promise.all([
          execFileAsync("git", ["-C", repo, "branch", "-a"], { timeout: 10000, maxBuffer: 1024 * 1024 }),
          execFileAsync("git", ["-C", repo, "branch", "--show-current"], { timeout: 5000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" })),
        ]);
        const current = currentOut.trim();
        const branches = branchOut.trim().split(/\r?\n/).filter(Boolean).map((line) => {
          const name = line.replace(/^\*\s+/, "").trim();
          return { name, current: name === current, remote: name.startsWith("remotes/") };
        });
        return { repo, action, current, branches };
      }
      if (action === "create") {
        const name = String(args.name || "");
        if (!name) throw new Error("name is required for create");
        const createArgs = ["-C", repo, "checkout", "-b", name, ...(args.from ? [args.from] : [])];
        const { stdout, stderr } = await execFileAsync("git", createArgs, { timeout: 10000, maxBuffer: 1024 * 1024 });
        return { repo, action, name, output: (stdout || stderr || "").trim() };
      }
      if (action === "switch") {
        const name = String(args.name || "");
        if (!name) throw new Error("name is required for switch");
        const { stdout, stderr } = await execFileAsync("git", ["-C", repo, "checkout", name], { timeout: 10000, maxBuffer: 1024 * 1024 });
        return { repo, action, name, output: (stdout || stderr || "").trim() };
      }
      if (action === "delete") {
        const name = String(args.name || "");
        if (!name) throw new Error("name is required for delete");
        const { stdout, stderr } = await execFileAsync("git", ["-C", repo, "branch", args.force ? "-D" : "-d", name], { timeout: 10000, maxBuffer: 1024 * 1024 });
        return { repo, action, name, output: (stdout || stderr || "").trim() };
      }
      throw new Error(`Unknown git_branch action: ${action}. Use: list, create, switch, delete`);
    }

    case "find_replace_all":
      return findReplaceAll(args);

    case "run_script":
      return runScript(args);

    case "send_to_process": {
      const record = runningProcesses.get(args.processId);
      if (!record) throw new Error("Process not found.");
      if (!record.running) throw new Error("Process is not running.");
      if (!record.child || !record.child.stdin || record.child.stdin.destroyed) {
        throw new Error("Process stdin is not available or has been closed.");
      }
      const input = String(args.input ?? "");
      await new Promise((resolve, reject) => {
        record.child.stdin.write(input + (args.newline !== false ? "\n" : ""), (err) => {
          if (err) reject(err); else resolve();
        });
      });
      return { success: true, processId: args.processId, sentBytes: Buffer.byteLength(input) };
    }

    case "list_installed_packages": {
      const projectPath = resolveTarget(args.path || DEFAULT_CWD, args.cwd || DEFAULT_CWD, "read");
      const type = String(args.type || "auto").toLowerCase();
      const result = {};
      if (type === "auto" || type === "npm") {
        const pkgFile = path.join(projectPath, "package.json");
        if (await pathExists(pkgFile)) {
          try {
            const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8"));
            result.npm = {
              name: pkg.name,
              version: pkg.version,
              scripts: pkg.scripts || {},
              dependencies: pkg.dependencies || {},
              devDependencies: pkg.devDependencies || {},
              peerDependencies: pkg.peerDependencies || {},
            };
          } catch (err) {
            result.npm = { error: err.message };
          }
        }
      }
      if (type === "auto" || type === "pip") {
        const reqFile = path.join(projectPath, "requirements.txt");
        if (await pathExists(reqFile)) {
          const content = await fs.readFile(reqFile, "utf8");
          result.pip = {
            file: "requirements.txt",
            packages: content.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("#")),
          };
        }
        const pyprojectFile = path.join(projectPath, "pyproject.toml");
        if (await pathExists(pyprojectFile)) {
          result.pyproject = { file: "pyproject.toml", content: await fs.readFile(pyprojectFile, "utf8") };
        }
      }
      if (type === "auto" || type === "cargo") {
        const cargoFile = path.join(projectPath, "Cargo.toml");
        if (await pathExists(cargoFile)) {
          result.cargo = { file: "Cargo.toml", content: await fs.readFile(cargoFile, "utf8") };
        }
      }
      return { path: projectPath, managers: Object.keys(result), result };
    }

    case "hash_file": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const stats = await fs.stat(target);
      if (!stats.isFile()) throw new Error("Target is not a file.");
      const buffer = await fs.readFile(target);
      const algorithm = ["sha256", "sha1", "md5", "sha512"].includes(String(args.algorithm || "")) ? args.algorithm : "sha256";
      const hash = crypto.createHash(algorithm).update(buffer).digest("hex");
      return { path: relativeToUsefulBase(target), absolutePath: target, algorithm, hash, size: stats.size };
    }

    case "count_lines": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const stats = await fs.stat(target);
      if (!stats.isFile()) throw new Error("Target is not a file.");
      const content = await fs.readFile(target, "utf8");
      const lines = content.split(/\r?\n/);
      return {
        path: relativeToUsefulBase(target),
        totalLines: lines.length,
        nonEmptyLines: lines.filter((l) => l.trim()).length,
        characters: content.length,
        bytes: stats.size,
        words: content.split(/\s+/).filter((w) => w).length,
      };
    }

    // ── advanced tools ────────────────────────────────────────────────────────

    case "diff_files": {
      const pathA = resolveTarget(args.pathA, args.cwd || DEFAULT_CWD, "read");
      const pathB = resolveTarget(args.pathB, args.cwd || DEFAULT_CWD, "read");
      const [stA, stB] = await Promise.all([fs.stat(pathA), fs.stat(pathB)]);
      if (!stA.isFile()) throw new Error("pathA is not a file.");
      if (!stB.isFile()) throw new Error("pathB is not a file.");
      const [textA, textB] = await Promise.all([fs.readFile(pathA, "utf8"), fs.readFile(pathB, "utf8")]);
      const result = computeLineDiff(textA, textB);
      return { pathA: relativeToUsefulBase(pathA), pathB: relativeToUsefulBase(pathB), ...result };
    }

    case "clipboard_read":
      return readClipboard();

    case "clipboard_write": {
      const text = String(args.text ?? "");
      return writeClipboard(text);
    }

    case "network_info": {
      const ifaces = os.networkInterfaces();
      const interfaces = {};
      for (const [ifName, addrs] of Object.entries(ifaces)) {
        interfaces[ifName] = (addrs || []).map((a) => ({
          family: a.family,
          address: a.address,
          netmask: a.netmask,
          cidr: a.cidr,
          internal: a.internal,
          mac: a.mac,
        }));
      }
      return {
        hostname: os.hostname(),
        platform: os.platform(),
        interfaces,
        interfaceCount: Object.keys(interfaces).length,
      };
    }

    case "json_query": {
      const target = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const raw = await fs.readFile(target, "utf8");
      let data;
      try { data = JSON.parse(raw); } catch (e) { throw new Error(`JSON parse error: ${e.message}`); }
      const qResult = resolveJsonPath(data, args.query || ".");
      return {
        path: relativeToUsefulBase(target),
        query: args.query || ".",
        resultType: qResult === null ? "null" : Array.isArray(qResult) ? "array" : typeof qResult,
        result: qResult,
      };
    }

    case "archive_create": {
      const sources = (Array.isArray(args.sources) ? args.sources : [args.sources || args.source || "."])
        .map((s) => resolveTarget(s, args.cwd || DEFAULT_CWD, "read"));
      const dest = resolveTarget(args.destination || args.dest, args.cwd || DEFAULT_CWD, "write");
      await ensureParent(dest);
      const ext = path.extname(dest).toLowerCase();
      let archResult;
      if (os.platform() === "win32") {
        if (ext !== ".zip") throw new Error("On Windows only .zip archives are supported (PowerShell Compress-Archive).");
        const srcList = sources.map((s) => s.replace(/\\/g, "/")).join("','");
        const cmd = `Compress-Archive -Path '${srcList}' -DestinationPath '${dest.replace(/\\/g, "/")}' -Force`;
        archResult = await captureSpawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { shell: false, timeout: 60000 });
      } else if (ext === ".zip") {
        archResult = await captureSpawn("zip", ["-r", dest, ...sources], { timeout: 60000 });
      } else {
        archResult = await captureSpawn("tar", ["-czf", dest, ...sources], { timeout: 60000 });
      }
      if (!archResult.success) throw new Error(`Archive creation failed: ${archResult.stderr || archResult.stdout}`);
      const destStat = await fs.stat(dest).catch(() => null);
      return { success: true, destination: relativeToUsefulBase(dest), absolutePath: dest, sizeBytes: destStat?.size ?? null };
    }

    case "archive_extract": {
      const archivePath = resolveTarget(args.path, args.cwd || DEFAULT_CWD, "read");
      const destDir = resolveTarget(args.destination || args.dest || ".", args.cwd || DEFAULT_CWD, "write");
      await fs.mkdir(destDir, { recursive: true });
      const ext = path.extname(archivePath).toLowerCase();
      let exResult;
      if (os.platform() === "win32") {
        const cmd = `Expand-Archive -Path '${archivePath.replace(/\\/g, "/")}' -DestinationPath '${destDir.replace(/\\/g, "/")}' -Force`;
        exResult = await captureSpawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { shell: false, timeout: 120000 });
      } else if (ext === ".zip") {
        exResult = await captureSpawn("unzip", ["-o", archivePath, "-d", destDir], { timeout: 120000 });
      } else {
        exResult = await captureSpawn("tar", ["-xf", archivePath, "-C", destDir], { timeout: 120000 });
      }
      if (!exResult.success) throw new Error(`Extraction failed: ${exResult.stderr || exResult.stdout}`);
      return { success: true, archive: relativeToUsefulBase(archivePath), destination: relativeToUsefulBase(destDir) };
    }

    case "generate_token": {
      const type = String(args.type || "hex").toLowerCase();
      const length = Math.min(Math.max(Number(args.length || 32), 1), 512);
      if (type === "uuid") {
        const value = crypto.randomUUID();
        return { type: "uuid", value, length: value.length };
      }
      if (type === "base64") {
        const value = crypto.randomBytes(Math.ceil(length * 0.75)).toString("base64url").slice(0, length);
        return { type: "base64url", value, length: value.length };
      }
      if (type === "alphanumeric") {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const bytes = crypto.randomBytes(length);
        const value = Array.from(bytes, (b) => chars[b % chars.length]).join("");
        return { type: "alphanumeric", value, length };
      }
      // default: hex
      const value = crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
      return { type: "hex", value, length: value.length };
    }

    default: {
      const bridged = await handleAgentBridgeTool(name, args);
      if (bridged !== undefined) return bridged;
      throw new Error(`Unknown tool: ${name}`);
    }
  }
}

const tools = [
  {
    name: "current_context",
    description: "Show connector context: MCP endpoint, access root, default working directory, auth mode, and protection status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "system_info",
    description: "Get OS, CPU, memory, Node.js, user, and configured filesystem context information.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "disk_usage",
    description: "Run df for a path and return disk usage.",
    inputSchema: { type: "object", properties: { path: { type: "string", default: "." }, cwd: { type: "string" } } },
  },
  {
    name: "list_directory",
    description: "List directory contents with file type, size, modification time, permissions, and optional recursion.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "." },
        cwd: { type: "string" },
        recursive: { type: "boolean", default: false },
        depth: { type: "number", default: 5 },
        includeHidden: { type: "boolean", default: true },
        maxEntries: { type: "number", default: 1000 },
      },
    },
  },
  {
    name: "directory_tree",
    description: "Return a nested directory tree, skipping protected connector files and large default folders.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "." },
        cwd: { type: "string" },
        depth: { type: "number", default: 4 },
        maxEntries: { type: "number", default: 500 },
        ignore: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "file_info",
    description: "Get metadata for a file, directory, or symlink.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_file",
    description: "Read a text or binary file by path. Relative paths use the default workspace; absolute paths can access the configured root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        cwd: { type: "string" },
        encoding: { type: "string", default: "utf8" },
        base64: { type: "boolean", default: false },
        offset: { type: "number", default: 0 },
        maxBytes: { type: "number", default: 4194304 },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file, automatically creating parent directories. Protected connector files are blocked.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, cwd: { type: "string" }, content: { type: "string" }, encoding: { type: "string", default: "utf8" } },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description: "Append text to a file. Protected connector files are blocked.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, cwd: { type: "string" }, content: { type: "string" }, encoding: { type: "string", default: "utf8" } },
      required: ["path", "content"],
    },
  },
  {
    name: "touch_file",
    description: "Create an empty file or update timestamps.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" } }, required: ["path"] },
  },
  {
    name: "create_directory",
    description: "Create a directory recursively.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" }, recursive: { type: "boolean", default: true } }, required: ["path"] },
  },
  {
    name: "delete_path",
    description: "Delete a file or directory. Deleting anything that contains the connector runtime is blocked.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" }, recursive: { type: "boolean", default: false }, force: { type: "boolean", default: false } }, required: ["path"] },
  },
  {
    name: "copy_path",
    description: "Copy a file or directory.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, cwd: { type: "string" }, force: { type: "boolean", default: true } }, required: ["source", "destination"] },
  },
  {
    name: "move_path",
    description: "Move or rename a file or directory. Protected connector files are blocked.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, cwd: { type: "string" } }, required: ["source", "destination"] },
  },
  {
    name: "make_executable",
    description: "Add executable permission bits to a file.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search_files",
    description: "Search file and directory names by substring or regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", default: "." },
        cwd: { type: "string" },
        pattern: { type: "string" },
        regex: { type: "boolean", default: false },
        caseSensitive: { type: "boolean", default: false },
        recursive: { type: "boolean", default: true },
        matchPath: { type: "boolean", default: false },
        depth: { type: "number", default: 10 },
        maxResults: { type: "number", default: 200 },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_text",
    description: "Search text inside files by plain text or regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", default: "." },
        cwd: { type: "string" },
        query: { type: "string" },
        regex: { type: "boolean", default: false },
        caseSensitive: { type: "boolean", default: false },
        recursive: { type: "boolean", default: true },
        maxResults: { type: "number", default: 100 },
        maxFileBytes: { type: "number", default: 1048576 },
      },
      required: ["query"],
    },
  },
  {
    name: "replace_text",
    description: "Replace text inside one file. Protected connector files are blocked.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" }, search: { type: "string" }, replace: { type: "string" }, regex: { type: "boolean", default: false }, all: { type: "boolean", default: true }, encoding: { type: "string", default: "utf8" } }, required: ["path", "search", "replace"] },
  },
  {
    name: "run_command",
    description: "Run a shell command and return stdout/stderr. sudo, kill/system control, and protected connector paths are blocked.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number", default: COMMAND_TIMEOUT_MS }, env: { type: "object" } }, required: ["command"] },
  },
  {
    name: "start_process",
    description: "Start a long-running managed shell process and return a process ID for polling.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, env: { type: "object" } }, required: ["command"] },
  },
  {
    name: "read_process",
    description: "Read stdout/stderr and status for a managed process started by start_process.",
    inputSchema: { type: "object", properties: { processId: { type: "string" } }, required: ["processId"] },
  },
  {
    name: "stop_process",
    description: "Stop only a managed child process. It cannot stop the connector server or protected port.",
    inputSchema: { type: "object", properties: { processId: { type: "string" }, signal: { type: "string", default: "SIGTERM" } }, required: ["processId"] },
  },
  {
    name: "list_processes",
    description: "List managed processes started through this connector.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_system_processes",
    description: "List top OS processes using ps for observability.",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 30 } } },
  },
  {
    name: "environment_list",
    description: "List environment variables. Values are hidden by default and secrets are redacted unless explicitly revealed.",
    inputSchema: { type: "object", properties: { filter: { type: "string" }, includeValues: { type: "boolean", default: false }, revealSecrets: { type: "boolean", default: false } } },
  },
  {
    name: "environment_get",
    description: "Get one environment variable. Secret-looking names are redacted unless revealSecret is true.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, revealSecret: { type: "boolean", default: false } }, required: ["name"] },
  },
  {
    name: "environment_set",
    description: "Set an environment variable for the connector process and optionally append an export line to a non-protected file.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, persistFile: { type: "string" }, cwd: { type: "string" } }, required: ["name", "value"] },
  },
  {
    name: "http_request",
    description: "Make an HTTP/HTTPS request and return status, headers, and a truncated body. Cloud metadata endpoints are blocked.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string", default: "GET" }, headers: { type: "object" }, body: { type: "string" }, timeout: { type: "number", default: 15000 } }, required: ["url"] },
  },
  {
    name: "port_check",
    description: "Check whether a TCP host:port is open.",
    inputSchema: { type: "object", properties: { host: { type: "string", default: "127.0.0.1" }, port: { type: "number", default: PORT } } },
  },
  {
    name: "git_status",
    description: "Run git status --short --branch in a repository.",
    inputSchema: { type: "object", properties: { path: { type: "string", default: "." }, cwd: { type: "string" } } },
  },
  {
    name: "git_diff",
    description: "Return git diff output for a repository, optionally staged or limited to a file.",
    inputSchema: { type: "object", properties: { path: { type: "string", default: "." }, cwd: { type: "string" }, staged: { type: "boolean", default: false }, file: { type: "string" } } },
  },
  {
    name: "open_url",
    description: "Open a URL in the host browser when the Codespaces BROWSER helper is available.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },

  // ─── agentic coding tools ───────────────────────────────────────────────────
  {
    name: "read_file_lines",
    description: "Read a specific line range from a file (1-based, inclusive). Use this instead of read_file when you only need part of a large file — avoids loading thousands of lines unnecessarily.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        cwd: { type: "string" },
        startLine: { type: "number", description: "First line to return (1-based)", default: 1 },
        endLine: { type: "number", description: "Last line to return (1-based, inclusive). Omit to read to end of file." },
      },
      required: ["path"],
    },
  },
  {
    name: "patch_file",
    description: "Apply multiple search-and-replace patches to a file in a single call. More efficient than calling replace_text many times. Patches are applied in order.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        cwd: { type: "string" },
        encoding: { type: "string", default: "utf8" },
        patches: {
          type: "array",
          description: "Ordered list of patches to apply",
          items: {
            type: "object",
            properties: {
              search: { type: "string", description: "Exact text or regex pattern to find" },
              replace: { type: "string", description: "Replacement text (supports $1 back-references if regex)" },
              regex: { type: "boolean", default: false },
              all: { type: "boolean", default: true, description: "Replace all occurrences (true) or only the first (false)" },
            },
            required: ["search", "replace"],
          },
        },
      },
      required: ["path", "patches"],
    },
  },
  {
    name: "read_many_files",
    description: "Read multiple files at once and return an array of their contents. Much faster than calling read_file individually for each file. Failed reads are reported per-file.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "List of file paths to read" },
        cwd: { type: "string" },
        encoding: { type: "string", default: "utf8" },
        maxBytes: { type: "number", description: "Max bytes returned per file" },
      },
      required: ["paths"],
    },
  },
  {
    name: "write_many_files",
    description: "Write multiple files at once, creating parent directories as needed. Ideal for scaffolding entire project structures or applying coordinated multi-file changes in one step.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "List of files to write",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path (relative or absolute)" },
              content: { type: "string", description: "File content to write" },
              encoding: { type: "string", default: "utf8" },
            },
            required: ["path", "content"],
          },
        },
        cwd: { type: "string" },
        encoding: { type: "string", default: "utf8", description: "Default encoding for all files (can be overridden per file)" },
      },
      required: ["files"],
    },
  },
  {
    name: "git_log",
    description: "Get git commit history with hash, author, date, and subject. Optionally filter to commits that touched a specific file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: ".", description: "Repository path" },
        cwd: { type: "string" },
        limit: { type: "number", default: 20, description: "Maximum number of commits to return (max 200)" },
        file: { type: "string", description: "Filter to commits that modified this file" },
      },
    },
  },
  {
    name: "git_commit",
    description: "Stage files and create a git commit. Stages '.' (all changes) by default. Use add to specify exact files or patterns.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: ".", description: "Repository path" },
        cwd: { type: "string" },
        message: { type: "string", description: "Commit message" },
        add: {
          description: "Files or patterns to stage. Use '.' for all changes. Defaults to ['.'].",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        noVerify: { type: "boolean", default: false, description: "Skip pre-commit hooks (--no-verify)" },
      },
      required: ["message"],
    },
  },
  {
    name: "git_branch",
    description: "List, create, switch, or delete git branches. Use action='list' to see all branches and the current one.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: ".", description: "Repository path" },
        cwd: { type: "string" },
        action: { type: "string", enum: ["list", "create", "switch", "delete"], default: "list" },
        name: { type: "string", description: "Branch name (required for create, switch, delete)" },
        from: { type: "string", description: "Starting point for branch creation (commit, tag, or branch name)" },
        force: { type: "boolean", default: false, description: "Force delete even if branch has unmerged commits (-D)" },
      },
      required: ["action"],
    },
  },
  {
    name: "find_replace_all",
    description: "Search and replace text across every matching file in a directory tree. Returns a list of changed files. Skip node_modules/.git/dist automatically. Great for renaming symbols or updating imports across a codebase.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", default: ".", description: "Root directory to scan" },
        cwd: { type: "string" },
        search: { type: "string", description: "Text or regex pattern to find" },
        replace: { type: "string", description: "Replacement text" },
        regex: { type: "boolean", default: false, description: "Treat search as a regular expression" },
        caseSensitive: { type: "boolean", default: false },
        extensions: {
          description: "Limit to files with these extensions, e.g. [\".js\",\".ts\"] or \".py\"",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        ignore: { type: "array", items: { type: "string" }, description: "Additional directory names to skip" },
        depth: { type: "number", default: 10, description: "Max directory depth to traverse" },
        maxFiles: { type: "number", default: 500, description: "Max number of files to change" },
      },
      required: ["search", "replace"],
    },
  },
  {
    name: "run_script",
    description: "Execute a code snippet inline without creating a permanent file. Supports Node.js, Python, PowerShell, Bash, and sh. Perfect for quick calculations, data transformations, testing snippets, or running automation logic.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["node", "python", "powershell", "bash", "sh"], description: "Runtime to use" },
        code: { type: "string", description: "Source code to execute" },
        args: { type: "array", items: { type: "string" }, description: "Command-line arguments passed to the script" },
        cwd: { type: "string", description: "Working directory for the script" },
        env: { type: "object", description: "Extra environment variables for the script" },
        timeout: { type: "number", default: 30000, description: "Timeout in milliseconds (max 5 minutes)" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "send_to_process",
    description: "Send text to the stdin of a running managed process (started via start_process). Use to interact with interactive programs like REPLs, shells, or CLI prompts.",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process ID returned by start_process" },
        input: { type: "string", description: "Text to send to the process stdin" },
        newline: { type: "boolean", default: true, description: "Append a newline after the input (simulates pressing Enter)" },
      },
      required: ["processId", "input"],
    },
  },
  {
    name: "list_installed_packages",
    description: "Read installed package manifests for a project directory. Detects npm (package.json), pip (requirements.txt / pyproject.toml), and Cargo (Cargo.toml) automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: ".", description: "Project directory to inspect" },
        cwd: { type: "string" },
        type: { type: "string", enum: ["auto", "npm", "pip", "cargo"], default: "auto", description: "Package manager to query (auto detects all)" },
      },
    },
  },
  {
    name: "hash_file",
    description: "Compute a cryptographic hash (SHA-256 by default) of a file. Useful for verifying integrity, detecting changes, or comparing files without reading their full contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        cwd: { type: "string" },
        algorithm: { type: "string", enum: ["sha256", "sha1", "md5", "sha512"], default: "sha256" },
      },
      required: ["path"],
    },
  },
  {
    name: "count_lines",
    description: "Count lines, words, and characters in a file without loading its full content. Use this to gauge file size before deciding how to read it (e.g., whether to use read_file_lines for a large file).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["path"],
    },
  },

  // ── advanced tools ──────────────────────────────────────────────────────────
  {
    name: "diff_files",
    description: "Compare two text files and return a unified-style diff showing added (+) and removed (-) lines with surrounding context. Returns identical:true if files are equal. Perfect for reviewing changes before committing, or validating a transformation was applied correctly.",
    inputSchema: {
      type: "object",
      properties: {
        pathA: { type: "string", description: "First file (original / before)" },
        pathB: { type: "string", description: "Second file (modified / after)" },
        cwd: { type: "string" },
      },
      required: ["pathA", "pathB"],
    },
  },
  {
    name: "clipboard_read",
    description: "Read the current system clipboard contents as text. Works on Windows (PowerShell Get-Clipboard), macOS (pbpaste), and Linux (xclip/xsel). Useful for ingesting user-copied content without needing a file path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clipboard_write",
    description: "Write text to the system clipboard. Works on Windows (PowerShell Set-Clipboard), macOS (pbcopy), and Linux (xclip). Useful for sharing generated content, tokens, or results directly to the user's clipboard.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to write to clipboard" },
      },
      required: ["text"],
    },
  },
  {
    name: "network_info",
    description: "List all network interfaces with their IPv4/IPv6 addresses, netmasks, CIDR notation, MAC addresses, and whether they are internal loopback adapters. Useful for checking available interfaces or what IP the machine is reachable on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "json_query",
    description: "Read a JSON file and extract a value using a dot-path query (e.g. 'user.name', 'items[0].price', 'settings.theme'). Use '.' to return the full parsed document. Returns the result with its type.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the JSON file" },
        cwd: { type: "string" },
        query: { type: "string", default: ".", description: "Dot-path query, e.g. 'user.address.city' or 'items[2].name'. Use '.' for the full document." },
      },
      required: ["path"],
    },
  },
  {
    name: "archive_create",
    description: "Create a zip or tar.gz archive from one or more files/directories. On Windows uses PowerShell Compress-Archive (zip only). On Unix uses zip or tar. Destination file extension determines format (.zip → zip, anything else → tar.gz).",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          description: "File or directory paths to include (string or array of strings)",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        destination: { type: "string", description: "Output archive path, e.g. 'backup.zip' or 'dist.tar.gz'" },
        cwd: { type: "string" },
      },
      required: ["sources", "destination"],
    },
  },
  {
    name: "archive_extract",
    description: "Extract a zip or tar archive to a destination directory. On Windows uses PowerShell Expand-Archive. On Unix uses unzip or tar. Format is auto-detected from the file extension. Destination directory is created if it does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Archive file to extract (.zip, .tar.gz, .tar.bz2, etc.)" },
        destination: { type: "string", description: "Directory to extract files into (created if missing)" },
        cwd: { type: "string" },
      },
      required: ["path", "destination"],
    },
  },
  {
    name: "generate_token",
    description: "Generate a cryptographically secure random token, UUID, or password using Node.js crypto. Types: hex (default, lowercase hex string), uuid (RFC 4122 v4), base64 (URL-safe base64), alphanumeric (A-Z a-z 0-9). Use for API keys, session tokens, test data, secure identifiers, or one-time codes.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["hex", "uuid", "base64", "alphanumeric"], default: "hex", description: "Token format" },
        length: { type: "number", default: 32, description: "Character length of the token (1–512). Ignored for uuid type." },
      },
    },
  },
];

// Agent-messaging bridge (list_agents / message_agent / check_replies)
tools.push(...agentBridgeTools);

async function handleMcpMessage(message, req) {
  const { id, method, params } = message || {};

  if (!method) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid request" } };
  }

  if (method === "initialize") {
    const clientName = params?.clientInfo?.name || params?.clientInfo?.title || "unknown client";
    const clientVer  = params?.clientInfo?.version || "";
    console.log(`[MCP] initialize ← ${clientName}${clientVer ? ` v${clientVer}` : ""}`);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_ID, title: SERVER_NAME, version: VERSION },
        instructions:
          `Grok Bot v${VERSION} — 56 tools for agentic coding and system control on Windows/Linux/macOS.\n\n`
          + `SCOPE: ${BYPASS_MODE ? "BYPASS MODE — full filesystem access." : `Folder-scoped — restricted to: ${ACCESS_ROOT}`}\n\n`
          + "CODING WORKFLOW:\n"
          + "• count_lines → read_file_lines: gauge a large file then read only the range you need.\n"
          + "• patch_file: apply multiple surgical edits to one file in a single call (faster than replace_text × N).\n"
          + "• diff_files: compare two files and review changes before committing.\n"
          + "• write_many_files: scaffold an entire project or apply coordinated multi-file changes atomically.\n"
          + "• read_many_files: load several source files at once for review or refactoring.\n"
          + "• run_script: execute Node.js, Python, or PowerShell snippets inline without creating permanent files.\n"
          + "• find_replace_all: rename a symbol or update imports across an entire codebase in one shot.\n"
          + "• json_query: extract values from JSON files with dot-path queries like 'user.name' or 'items[0].id'.\n"
          + "• generate_token: generate secure tokens, UUIDs, or random passwords.\n"
          + "• clipboard_read / clipboard_write: share content with the user's clipboard.\n"
          + "• archive_create / archive_extract: create and unpack zip archives.\n"
          + "• git_log / git_branch / git_commit: full version-control workflow.\n"
          + "• start_process + send_to_process + read_process: drive interactive CLIs and long-running servers.\n\n"
          + "SAFETY: Connector runtime files are write-protected. sudo / kill / taskkill commands are blocked."
      },
    };
  }

  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    console.log(`[MCP] tools/list → ${tools.length} tools`);
    return { jsonrpc: "2.0", id, result: { tools } };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    // Build a compact args summary (redact long values)
    const argSummary = Object.entries(toolArgs)
      .map(([k, v]) => {
        const s = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
        return `${k}=${s.length > 60 ? s.slice(0, 57) + "…" : s}`;
      })
      .join(", ");
    console.log(`[TOOL] ▶ ${toolName}${argSummary ? `  {${argSummary}}` : ""}`);
    const t0 = Date.now();
    try {
      const result = await callTool(toolName, toolArgs, req);
      const ms = Date.now() - t0;
      recordToolStat(toolName, ms, false);
      // Show a brief result summary (first 120 chars of JSON)
      const preview = JSON.stringify(result);
      const short = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
      console.log(`[TOOL] ✓ ${toolName} (${ms}ms) → ${short}`);
      return { jsonrpc: "2.0", id, result: textResult(result) };
    } catch (error) {
      const ms = Date.now() - t0;
      recordToolStat(toolName, ms, true);
      console.error(`[TOOL] ✗ ${toolName} (${ms}ms) → ${error.message}`);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: error.message }],
        },
      };
    }
  }

  if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
  if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function handleMcpRequest(req, res) {
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map((message) => handleMcpMessage(message, req)))).filter(Boolean);
      if (!responses.length) return res.status(202).end();
      return res.json(responses);
    }

    const response = await handleMcpMessage(body, req);
    if (!response) return res.status(202).end();
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: error.message } });
  }
}

function dashboardHtml(req) {
  const base = publicBaseUrl(req);
  const mcpUrl = `${base}/mcp`;
  const cards = [
    ["Tools", tools.length, "filesystem, shell, processes, git, network"],
    ["Access root", ACCESS_ROOT, "absolute paths allowed inside this root"],
    ["Default cwd", DEFAULT_CWD, "relative file paths start here"],
    ["Protection", `${PROTECTED_PATHS.length} paths`, "runtime files and startup script guarded"],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${SERVER_NAME}</title>
<style>
:root { color-scheme: dark; --bg:#070b18; --panel:#111832cc; --panel2:#0e1428; --text:#eef4ff; --muted:#9db1d6; --line:#253154; --brand:#7c5cff; --accent:#00d4ff; --ok:#2ff0a2; --warn:#ffd166; }
*{box-sizing:border-box} body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:radial-gradient(circle at top left,#24306f55,transparent 32rem),radial-gradient(circle at top right,#0abbd455,transparent 28rem),var(--bg);color:var(--text);min-height:100vh}.wrap{width:min(1120px,92vw);margin:0 auto;padding:48px 0}.hero{border:1px solid var(--line);background:linear-gradient(145deg,#101832dd,#090e1ddd);border-radius:28px;padding:34px;box-shadow:0 24px 90px #0008;position:relative;overflow:hidden}.hero:before{content:"";position:absolute;inset:-2px;background:linear-gradient(120deg,var(--brand),transparent,var(--accent));opacity:.18;filter:blur(28px)}.hero>*{position:relative}.badge{display:inline-flex;gap:8px;align-items:center;border:1px solid #37507a;background:#10203d;padding:8px 12px;border-radius:999px;color:#bfe9ff;font-weight:700;font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 18px var(--ok)}h1{font-size:clamp(38px,6vw,78px);line-height:.95;margin:22px 0 14px;letter-spacing:-.07em}.sub{font-size:19px;line-height:1.65;color:var(--muted);max-width:820px}.actions{display:flex;flex-wrap:wrap;gap:14px;margin-top:26px}.pill{border:1px solid var(--line);background:#10172c;padding:14px 16px;border-radius:16px;color:var(--text);text-decoration:none}.primary{background:linear-gradient(135deg,var(--brand),#13b9ff);border:0;font-weight:800}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:22px 0}.card{border:1px solid var(--line);background:var(--panel);border-radius:22px;padding:20px;min-height:150px}.label{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.12em}.value{font-size:24px;font-weight:850;overflow-wrap:anywhere;margin:12px 0}.desc{color:var(--muted);line-height:1.45}.panel{border:1px solid var(--line);background:var(--panel);border-radius:22px;padding:22px;margin-top:16px}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre{white-space:pre-wrap;background:#060a14;border:1px solid #202a48;border-radius:18px;padding:18px;color:#d7e7ff;overflow:auto}.tools{display:flex;flex-wrap:wrap;gap:8px}.tool{padding:7px 10px;border-radius:999px;background:#17213f;border:1px solid #2a3a66;color:#cbd9ff;font-size:13px}@media (max-width:900px){.grid{grid-template-columns:1fr 1fr}}@media (max-width:620px){.grid{grid-template-columns:1fr}.wrap{padding:22px 0}.hero{padding:24px}h1{font-size:42px}}
</style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="badge"><span class="dot"></span> Running on port ${PORT}</div>
      <h1>Grok Bot</h1>
      <p class="sub">A protected desktop-style bridge for ChatGPT/MCP clients. It exposes advanced filesystem, terminal, process, git, network, and system tools while guarding the connector runtime from tool calls.</p>
      <div class="actions">
        <a class="pill primary" href="${mcpUrl}">MCP endpoint</a>
        <a class="pill" href="/health">Health JSON</a>
      </div>
    </section>

    <section class="grid">
      ${cards
        .map(
          ([label, value, desc]) => `<article class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="desc">${desc}</div></article>`
        )
        .join("")}
    </section>

    <section class="panel">
      <div class="label">ChatGPT MCP URL</div>
      <pre>${mcpUrl}</pre>
      <p class="desc">Paste this URL in ChatGPT &rarr; Settings &rarr; Connectors &rarr; New App. Set Authentication to <strong>No Auth</strong>.</p>
    </section>

    <section class="panel">
      <div class="label">Tool catalog</div>
      <div class="tools">${tools.map((tool) => `<span class="tool">${tool.name}</span>`).join("")}</div>
    </section>
  </main>
</body>
</html>`;
}

app.get("/", (req, res) => res.type("html").send(dashboardHtml(req)));
app.get("/logs/live", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  liveLogClients.add(res);

  for (const log of runtimeLogs.slice(-100)) {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  }

  req.on("close", () => {
    liveLogClients.delete(res);
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    name: SERVER_NAME,
    id: SERVER_ID,
    version: VERSION,
    port: PORT,
    mcpEndpoint: `${publicBaseUrl(req)}/mcp`,
    accessRoot: ACCESS_ROOT,
    defaultCwd: DEFAULT_CWD,
    protectedPathCount: PROTECTED_PATHS.length,
    tools: tools.length,
    uptimeSeconds: process.uptime(),
  });
});

app.get("/robots.txt", (_req, res) => res.type("text").send("User-agent: *\nDisallow: /\n"));
app.get("/tools", (_req, res) => res.json({ tools }));
app.get("/stats", (_req, res) => {
  const topTools = Array.from(toolStats.entries())
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 15)
    .map(([tName, s]) => ({
      name: tName,
      calls: s.calls,
      errors: s.errors,
      avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0,
      lastCalled: s.lastCalled,
    }));
  res.json({
    status: "ok",
    sessionStart: sessionStart.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    totalCalls,
    totalErrors,
    totalTools: tools.length,
    activeProcesses: runningProcesses.size,
    liveLogClients: liveLogClients.size,
    topTools,
  });
});
app.post("/mcp", handleMcpRequest);
app.post("/sse", handleMcpRequest);
app.post("/execute", async (req, res) => {
  try {
    const toolName = req.body.tool || req.body.name;
    const args = { ...req.body };
    delete args.tool;
    delete args.name;
    const result = await callTool(toolName, args, req);
    return res.json({ success: true, result });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

function sseHandler(_req, res) {
  const ip =
    (_req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    _req.socket?.remoteAddress ||
    "?";
  console.log(`[SSE] client connected [${ip}]`);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`event: ready\ndata: ${JSON.stringify({ name: SERVER_ID, version: VERSION, mcp: "/mcp" })}\n\n`);
  const timer = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  }, 25000);
  res.on("close", () => {
    clearInterval(timer);
    console.log(`[SSE] client disconnected [${ip}]`);
  });
}

app.get("/mcp", sseHandler);
app.get("/sse", sseHandler);

const server = app.listen(PORT, HOST, () => {
  const localUrl = `http://localhost:${PORT}`;
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║ ${SERVER_NAME.padEnd(60)} ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║ Status: running                                              ║`);
  console.log(`║ Local:  ${localUrl.padEnd(53)} ║`);
  console.log(`║ MCP:    ${(localUrl + "/mcp").padEnd(53)} ║`);
  console.log(`║ Tools:  ${String(tools.length).padEnd(53)} ║`);
  console.log(`║ Root:   ${ACCESS_ROOT.slice(0, 53).padEnd(53)} ║`);
  console.log(`║ Scope:  ${(BYPASS_MODE ? "bypass (full filesystem)" : "folder-scoped").padEnd(53)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
});

server.on("error", (error) => {
  console.error(`Failed to start ${SERVER_NAME}:`, error.message);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`${signal} received. Shutting down connector process.`);
    server.close(() => process.exit(0));
  });
}
