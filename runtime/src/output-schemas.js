/**
 * Wire-format contracts for every workspace MCP action.
 * Describe structuredContent, not the MCP CallToolResult envelope.
 * Dates are serialized; undefined properties are omitted.
 */
const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const yes = { type: "boolean", const: true };
const no = { type: "boolean", const: false };
const enumeration = (...values) => ({ type: "string", enum: values });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const array = (items) => ({ type: "array", items });
const dictionary = (values) => ({ type: "object", additionalProperties: values });
const object = (required, optional = {}) => ({
  type: "object",
  properties: { ...required, ...optional },
  required: Object.keys(required),
  additionalProperties: false,
});
const variants = (...schemas) => ({ type: "object", oneOf: schemas });

const location = { path: string, absolutePath: string };
const fileType = enumeration("file", "directory", "symlink");
const fileEntry = { name: string, ...location, type: fileType };
const fileContents = object({ ...location, size: integer, content: string });
const pathError = object({ path: string, error: string });
const fileMutation = object({ success: yes, ...location });
const moveOrCopy = object({ success: yes, source: string, destination: string });
const gitOutput = object({ repo: string, output: string });

const commandResult = object({
  success: boolean, command: string, exitCode: nullable(integer), timedOut: boolean,
  stdout: string, stderr: string, startedAt: string, finishedAt: string,
}, {
  // spawn's error event has no signal; its close event includes null or a signal.
  signal: nullable(string),
});
const processStart = {
  processId: string, command: string, cwd: string, startedAt: string,
};
const processRecord = object({
  ...processStart, stdout: string, stderr: string,
  exitCode: nullable(integer), signal: nullable(string), running: boolean,
}, { pid: integer, finishedAt: string });

const treeNode = variants(
  object({
    name: string, path: string, type: enumeration("directory"),
    children: array({ $ref: "#/$defs/treeNode" }),
  }, { error: string }),
  object({ name: string, path: string, type: enumeration("file", "symlink") }),
);
const packageManifest = variants(
  object({
    scripts: dictionary(string), dependencies: dictionary(string),
    devDependencies: dictionary(string), peerDependencies: dictionary(string),
  }, { name: string, version: string }),
  object({ error: string }),
);
const manifestText = object({ file: string, content: string });

export const generalOutputSchemas = {
  current_context: object({
    server: string, version: string, accessRoot: string, defaultCwd: string,
    port: number, mcpEndpoint: string, protectedPathCount: integer, tools: integer,
    scopeMode: enumeration("bypass", "folder-scoped"), scopeRoot: string,
    session: object({
      start: string, uptimeSeconds: integer, totalCalls: integer, totalErrors: integer,
      activeProcesses: integer, liveLogClients: integer,
    }),
  }),
  system_info: object({
    platform: string, release: string, arch: string, hostname: string,
    uptimeSeconds: number, user: string, home: string, temp: string, node: string,
    cpus: array(string), totalMemory: number, freeMemory: number,
    loadAverage: array(number), accessRoot: string, defaultCwd: string,
  }),
  disk_usage: object({ target: string, output: string }),
  list_directory: object({
    path: string, count: integer,
    items: array(object({ ...fileEntry, size: integer, modified: string, permissions: string })),
  }),
  directory_tree: {
    ...object({ root: string, tree: { $ref: "#/$defs/treeNode" }, count: integer }),
    $defs: { treeNode },
  },
  file_info: object({
    ...location, type: fileType, size: integer, created: string, modified: string,
    accessed: string, permissions: string, uid: integer, gid: integer,
  }),
  read_file: object({ ...location, size: integer, encoding: string, content: string }),
  write_file: object({ success: yes, ...location, bytes: integer }),
  append_file: object({ success: yes, ...location, appendedBytes: integer }),
  touch_file: fileMutation,
  create_directory: fileMutation,
  delete_path: object({ success: yes, deleted: string, absolutePath: string }),
  copy_path: moveOrCopy,
  move_path: moveOrCopy,
  make_executable: object({ success: yes, path: string, permissions: string }),
  search_files: object({
    directory: string, pattern: string, count: integer, results: array(object(fileEntry)),
  }),
  search_text: object({
    directory: string, query: string, count: integer,
    results: array(object({ ...location, line: integer, preview: string })),
  }),
  replace_text: object({ success: yes, path: string, changed: boolean, deltaBytes: integer }),
  run_command: commandResult,
  start_process: object(processStart, { pid: integer }),
  read_process: processRecord,
  stop_process: object({ success: yes, message: string }, { process: processRecord }),
  list_processes: object({ count: integer, processes: array(processRecord) }),
  list_system_processes: object({ count: integer, table: string }),
  environment_list: object({ count: integer, variables: dictionary(string) }),
  environment_get: object({ name: string, exists: boolean }, {
    value: { ...string, description: "Omitted when unset, unless secret-name redaction applies." },
  }),
  environment_set: object({
    success: yes, name: string, processUpdated: yes, persistedTo: nullable(string),
  }),
  http_request: object({
    url: string, status: integer, statusText: string, headers: dictionary(string), body: string,
  }),
  port_check: variants(
    object({ host: string, port: number, open: yes }),
    object({ host: string, port: number, open: no, reason: string }),
  ),
  git_status: gitOutput,
  git_diff: gitOutput,
  open_url: variants(
    object({ success: yes, url: string }),
    object({ success: no, message: string, url: string }),
  ),
  read_file_lines: object({
    ...location, totalLines: integer, startLine: number, endLine: number,
    returnedLines: integer, content: string,
  }),
  patch_file: object({
    success: yes, path: string, patchCount: integer, applied: integer,
    results: array(object({ search: string, applied: boolean }, { reason: string })),
  }),
  read_many_files: object({ count: integer, files: array(variants(fileContents, pathError)) }),
  write_many_files: object({
    total: integer, succeeded: integer, failed: integer,
    results: array(variants(
      object({ path: string, success: yes, bytes: integer }),
      object({ path: string, success: no, error: string }),
    )),
  }),
  git_log: object({
    repo: string, count: integer,
    commits: array(object({
      hash: string, shortHash: string, author: object({ name: string, email: string }),
      date: string, subject: string,
    })),
  }),
  git_commit: object({ repo: string, success: yes, output: string }),
  git_branch: variants(
    object({
      repo: string, action: enumeration("list"), current: string,
      branches: array(object({ name: string, current: boolean, remote: boolean })),
    }),
    object({ repo: string, action: enumeration("create", "switch", "delete"), name: string, output: string }),
  ),
  find_replace_all: object({
    directory: string, search: string, replace: string, scanned: integer,
    changedCount: integer, changedFiles: array(string), errors: array(pathError),
  }),
  run_script: commandResult,
  send_to_process: object({ success: yes, processId: string, sentBytes: integer }),
  list_installed_packages: object({
    path: string, managers: array(enumeration("npm", "pip", "pyproject", "cargo")),
    result: object({}, {
      npm: packageManifest,
      pip: object({ file: string, packages: array(string) }),
      pyproject: manifestText, cargo: manifestText,
    }),
  }),
  hash_file: object({ ...location, algorithm: enumeration("sha256", "sha1", "md5", "sha512"), hash: string, size: integer }),
  count_lines: object({
    path: string, totalLines: integer, nonEmptyLines: integer,
    characters: integer, bytes: integer, words: integer,
  }),
  diff_files: object({
    pathA: string, pathB: string, identical: boolean, aLines: integer, bLines: integer, diff: string,
  }, { added: integer, removed: integer, note: string }),
  clipboard_read: object({ text: string }),
  clipboard_write: object({ success: yes, bytes: integer }),
  network_info: object({
    hostname: string, platform: string, interfaceCount: integer,
    interfaces: dictionary(array(object({
      // Early Node 18 releases exposed a numeric family; later versions use names.
      family: { anyOf: [enumeration("IPv4", "IPv6"), { type: "integer", enum: [4, 6] }] },
      address: string, netmask: string, cidr: nullable(string), internal: boolean, mac: string,
    }))),
  }),
  json_query: object({
    path: string, query: string,
    resultType: enumeration("null", "array", "object", "string", "number", "boolean", "undefined", "function"),
  }, {
    // Queried JSON values may have any shape. Missing values and selected
    // inherited methods disappear during serialization, rather than become null.
    result: { description: "Selected JSON value; omitted for undefined or function results." },
  }),
  archive_create: object({ success: yes, destination: string, absolutePath: string, sizeBytes: nullable(integer) }),
  archive_extract: object({ success: yes, archive: string, destination: string }),
  generate_token: object({ type: enumeration("uuid", "base64url", "alphanumeric", "hex"), value: string, length: number }),
};

/** Use a tool-owned schema (e.g. agent bridge) or its explicit workspace contract. */
export function withOutputSchema(tool) {
  const outputSchema = tool.outputSchema ?? (
    Object.hasOwn(generalOutputSchemas, tool.name) ? generalOutputSchemas[tool.name] : undefined
  );
  if (!outputSchema || outputSchema.type !== "object") {
    throw new Error("Missing object output schema for MCP action: " + tool.name);
  }
  return { ...tool, outputSchema };
}
