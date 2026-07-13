import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const serverPath = path.join(
  repositoryRoot,
  "plugins",
  "claude-design-bridge",
  "server",
  "design-bridge.mjs",
);
const fixturePath = path.join(
  repositoryRoot,
  "__tests__",
  "fixtures",
  "design-sync.json",
);

let child;
let workspaceRoot;
let pullDirectory;
let cacheDirectory;
let nextId = 0;
let stdoutBuffer = "";
const pending = new Map();
const unsolicited = [];
const unsolicitedWaiters = [];

const cachePathFor = (projectId, filePath, extension) => {
  const key = createHash("sha256")
    .update(`${projectId}\0${filePath}`)
    .digest("hex");
  return path.join(cacheDirectory, "objects", `${key}.${extension}`);
};

const nextUnsolicitedMessage = () =>
  new Promise((resolve, reject) => {
    if (unsolicited.length) {
      resolve(unsolicited.shift());
      return;
    }
    const waiter = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    const timer = setTimeout(() => {
      const index = unsolicitedWaiters.indexOf(waiter);
      if (index >= 0) {
        unsolicitedWaiters.splice(index, 1);
      }
      reject(new Error("Unsolicited message timeout"));
    }, 10000);
    unsolicitedWaiters.push(waiter);
  });

const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout for ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });

const callTool = async (name, args = {}, meta) => {
  const response = await rpc("tools/call", {
    name,
    arguments: args,
    ...(meta ? { _meta: meta } : {}),
  });
  return {
    isError: response.result.isError,
    data: JSON.parse(response.result.content[0].text),
  };
};

const waitForServerReady = (server) =>
  new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (chunk.includes("ready v")) {
        clearTimeout(timer);
        server.stderr.off("data", onData);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      server.stderr.off("data", onData);
      reject(new Error("Server startup timeout"));
    }, 5000);
    server.stderr.on("data", onData);
  });

before(async () => {
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codex-design-mcp-test-"));
  pullDirectory = path.join(workspaceRoot, ".design", "claude", "mock-pid-1");
  cacheDirectory = path.join(workspaceRoot, "cache");
  child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
      DESIGN_BRIDGE_CACHE_DIR: cacheDirectory,
    },
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.method === "roots/list") {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              roots: [
                { uri: pathToFileURL(workspaceRoot).toString(), name: "test" },
              ],
            },
          })}\n`,
        );
        continue;
      }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        request.resolve(message);
      } else if (unsolicitedWaiters.length) {
        unsolicitedWaiters.shift()(message);
      } else {
        unsolicited.push(message);
      }
    }
  });
  child.once("exit", (code, signal) => {
    for (const request of pending.values()) {
      request.resolve({
        error: { message: `Server exited: ${code}/${signal}` },
      });
    }
    pending.clear();
  });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
});

after(() => {
  child.stdin.end();
  if (child.exitCode === null) {
    child.kill();
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
});

test("should advertise only the seven intended bridge tools", async () => {
  const response = await rpc("tools/list");

  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
    [
      "design_list_projects",
      "design_resolve_link",
      "design_get_project",
      "design_list_files",
      "design_get_file",
      "design_pull",
      "design_doctor",
    ],
  );
});

test("should advertise the hard pull path limit", async () => {
  const response = await rpc("tools/list");
  const pullTool = response.result.tools.find(
    (tool) => tool.name === "design_pull",
  );

  assert.equal(pullTool.inputSchema.properties.paths.maxItems, 12);
});

test("should report malformed JSON as a JSON-RPC parse error", async () => {
  const responsePromise = nextUnsolicitedMessage();
  child.stdin.write("not-json\n");
  const response = await responsePromise;

  assert.equal(response.error.code, -32700);
});

test("should reject an invalid JSON-RPC envelope", async () => {
  const responsePromise = nextUnsolicitedMessage();
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "1.0", id: "invalid-envelope", method: "ping" })}\n`,
  );
  const response = await responsePromise;

  assert.equal(response.error.code, -32600);
});

test("should reject an unknown tool as invalid params", async () => {
  const response = await rpc("tools/call", {
    name: "design_write_file",
    arguments: {},
  });

  assert.equal(response.error.code, -32602);
});

test("should return project metadata", async () => {
  const result = await callTool("design_get_project", {
    projectId: "mock-pid-1",
  });

  assert.equal(result.data.name, "Mock Design");
});

test("should return normalized project file paths", async () => {
  const result = await callTool("design_list_files", {
    projectId: "mock-pid-1",
  });

  assert.deepEqual(result.data.paths, [
    "components",
    "components/button.html",
    "tokens/colors.css",
  ]);
});

test("should keep local cache paths out of doctor results", async () => {
  const result = await callTool("design_doctor");

  assert.equal(Object.hasOwn(result.data, "cacheDir"), false);
});

test("should resolve a linked file query without delegation", async () => {
  const result = await callTool("design_resolve_link", {
    url: "https://claude.ai/design/p/mock-pid-1?file=components%2Fbutton.html",
  });

  assert.equal(result.data.path, "components/button.html");
});

test("should reject a design URL on another host", async () => {
  const result = await callTool("design_resolve_link", {
    url: "https://example.com/design/p/mock-pid-1",
  });

  assert.equal(result.data.error, "BAD_LINK");
});

test("should return small text content inline", async () => {
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
  });

  assert.equal(result.data.content, '<button class="btn">Hi</button>');
});

test("should keep local cache paths out of file results", async () => {
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
  });

  assert.equal(Object.hasOwn(result.data, "cachedPath"), false);
});

test("should serve a validated file from cache on the second read", async () => {
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
    refresh: false,
  });

  assert.equal(result.data.fromCache, true);
});

test("should replace existing cache objects during an explicit refresh", async () => {
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
    refresh: true,
  });

  assert.equal(result.data.fromCache, false);
});

test("should refetch a stale cache object", async () => {
  await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
  });
  const metadataPath = cachePathFor(
    "mock-pid-1",
    "components/button.html",
    "json",
  );
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.fetchedAtMs = 0;
  writeFileSync(metadataPath, JSON.stringify(metadata));
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
    refresh: false,
  });

  assert.equal(result.data.fromCache, false);
});

test("should refetch a cache object that fails integrity validation", async () => {
  await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
  });
  writeFileSync(
    cachePathFor("mock-pid-1", "components/button.html", "data"),
    "corrupted",
  );
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
    refresh: false,
  });

  assert.equal(result.data.fromCache, false);
});

test("should pull selected files under an MCP workspace root", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: ["components/button.html", "tokens/colors.css"],
  });

  assert.equal(result.data.count, 2);
});

test("should reject invalid maxFiles values before creating snapshots", async () => {
  const invalidValues = [null, 0, -1, 1.5, "5", 13];
  const outcomes = [];
  for (const [index, maxFiles] of invalidValues.entries()) {
    const projectId = `invalid-max-${index}`;
    const directory = path.join(
      workspaceRoot,
      ".design",
      "claude",
      projectId,
    );
    const result = await callTool("design_pull", {
      projectId,
      dir: directory,
      paths: ["components/button.html"],
      maxFiles,
    });
    outcomes.push({ error: result.data.error, exists: existsSync(directory) });
  }

  assert.deepEqual(
    outcomes,
    invalidValues.map(() => ({ error: "BAD_MAX_FILES", exists: false })),
  );
});

test("should reject oversized path selections before creating a snapshot", async () => {
  const projectId = "oversized-selection";
  const directory = path.join(
    workspaceRoot,
    ".design",
    "claude",
    projectId,
  );
  const result = await callTool("design_pull", {
    projectId,
    dir: directory,
    paths: Array.from(
      { length: 20000 },
      (_, index) => `screens/screen-${index}.html`,
    ),
  });

  assert.deepEqual(
    { error: result.data.error, exists: existsSync(directory) },
    { error: "TOO_MANY_FILES", exists: false },
  );
});

test("should reject malformed path selections before creating snapshots", async () => {
  const selections = [[], ["valid.html", 1], ["same.html", "same.html"]];
  const outcomes = [];
  for (const [index, paths] of selections.entries()) {
    const projectId = `invalid-paths-${index}`;
    const directory = path.join(
      workspaceRoot,
      ".design",
      "claude",
      projectId,
    );
    const result = await callTool("design_pull", {
      projectId,
      dir: directory,
      paths,
    });
    outcomes.push({ error: result.data.error, exists: existsSync(directory) });
  }

  assert.deepEqual(outcomes, [
    { error: "BAD_PATHS", exists: false },
    { error: "BAD_PATH", exists: false },
    { error: "BAD_PATHS", exists: false },
  ]);
});

test("should reject invalid freshness options before creating snapshots", async () => {
  const options = [
    { refresh: "true" },
    { overwrite: null },
  ];
  const outcomes = [];
  for (const [index, option] of options.entries()) {
    const projectId = `invalid-freshness-${index}`;
    const directory = path.join(
      workspaceRoot,
      ".design",
      "claude",
      projectId,
    );
    const result = await callTool("design_pull", {
      projectId,
      dir: directory,
      paths: ["components/button.html"],
      ...option,
    });
    outcomes.push({ error: result.data.error, exists: existsSync(directory) });
  }

  assert.deepEqual(outcomes, [
    { error: "BAD_REFRESH", exists: false },
    { error: "BAD_OVERWRITE", exists: false },
  ]);
});

test("should reject an invalid get-file freshness option", async () => {
  const result = await callTool("design_get_file", {
    projectId: "mock-pid-1",
    path: "components/button.html",
    refresh: "true",
  });

  assert.equal(result.data.error, "BAD_REFRESH");
});

test("should preserve pulled file bytes", () => {
  assert.equal(
    readFileSync(path.join(pullDirectory, "components", "button.html"), "utf8"),
    '<button class="btn">Hi</button>',
  );
});

test("should write a provenance manifest", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(pullDirectory, ".claude-design.json"), "utf8"),
  );

  assert.equal(manifest.files.length, 2);
});

test("should reject pulls outside MCP workspace roots", async () => {
  const outside = path.resolve(workspaceRoot, "..", "outside-snapshot");
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: outside,
    paths: ["components/button.html"],
  });

  assert.equal(result.data.error, "DIR_OUTSIDE_WORKSPACE");
});

test("should not let sandbox metadata widen advertised MCP roots", async () => {
  const otherRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-other-root-"),
  );
  let result;
  try {
    result = await callTool(
      "design_pull",
      {
        projectId: "mock-pid-1",
        dir: path.join(otherRoot, ".design", "claude", "mock-pid-1"),
        paths: ["components/button.html"],
      },
      {
        "codex/sandbox-state-meta": {
          sandboxCwd: pathToFileURL(otherRoot).toString(),
        },
      },
    );
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
  }

  assert.equal(result.data.error, "DIR_OUTSIDE_WORKSPACE");
});

test("should reject a workspace directory that is not the dedicated snapshot path", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: path.join(workspaceRoot, "snapshot"),
    paths: ["components/button.html"],
  });

  assert.equal(result.data.error, "DEDICATED_SNAPSHOT_REQUIRED");
});

test("should refuse a symlinked snapshot parent", async () => {
  const projectId = "symlinked-parent";
  const directory = path.join(
    workspaceRoot,
    ".design",
    "claude",
    projectId,
  );
  const outside = mkdtempSync(path.join(os.tmpdir(), "codex-design-outside-"));
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    outside,
    path.join(directory, "components"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let result;
  try {
    result = await callTool("design_pull", {
      projectId,
      dir: directory,
      paths: ["components/button.html"],
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  assert.equal(result.data.data.errors[0].error, "SYMLINK_ESCAPE");
});

test("should reserve the provenance manifest path", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: [".claude-design.json"],
  });

  assert.equal(result.data.error, "RESERVED_PATH");
});

test("should reserve the provenance manifest path prefix", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: [".claude-design.json/payload.html"],
  });

  assert.equal(result.data.error, "RESERVED_PATH");
});

test("should reserve the snapshot lock path", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: [".claude-design.lock"],
  });

  assert.equal(result.data.error, "RESERVED_PATH");
});

test("should reject portable case-folded path collisions", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: ["components/Screen.html", "components/screen.html"],
  });

  assert.equal(result.data.error, "PATH_COLLISION");
});

test("should reject file and parent-directory path collisions", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: ["components", "components/screen.html"],
  });

  assert.equal(result.data.error, "PATH_COLLISION");
});

test("should reject a pull while another process owns the snapshot lock", async () => {
  const lockPath = path.join(pullDirectory, ".claude-design.lock");
  writeFileSync(lockPath, "external lock", { flag: "wx" });
  let result;
  try {
    result = await callTool("design_pull", {
      projectId: "mock-pid-1",
      dir: pullDirectory,
      paths: ["components/button.html"],
    });
  } finally {
    rmSync(lockPath, { force: true });
  }

  assert.equal(result.data.error, "SNAPSHOT_BUSY");
});

test("should keep live and foreign-host snapshot locks busy", async () => {
  const lockPath = path.join(pullDirectory, ".claude-design.lock");
  const locks = [
    { hostname: os.hostname(), pid: process.pid },
    { hostname: "another-host.invalid", pid: process.pid },
  ];
  const errors = [];
  for (const [index, lock] of locks.entries()) {
    writeFileSync(
      lockPath,
      JSON.stringify({
        id: `busy-test-lock-${index}`,
        ...lock,
        createdAt: new Date().toISOString(),
      }),
      { flag: "wx" },
    );
    try {
      const result = await callTool("design_pull", {
        projectId: "mock-pid-1",
        dir: pullDirectory,
        paths: ["components/button.html"],
      });
      errors.push(result.data.error);
    } finally {
      rmSync(lockPath, { force: true });
    }
  }

  assert.deepEqual(errors, ["SNAPSHOT_BUSY", "SNAPSHOT_BUSY"]);
});

test("should diagnose a dead same-host snapshot lock without removing it", async () => {
  const owner = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => owner.once("exit", resolve));
  const lockPath = path.join(pullDirectory, ".claude-design.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({
      id: "stale-test-lock",
      pid: owner.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }),
    { flag: "wx" },
  );
  let result;
  try {
    result = await callTool("design_pull", {
      projectId: "mock-pid-1",
      dir: pullDirectory,
      paths: ["components/button.html"],
    });
    assert.deepEqual(
      { error: result.data.error, lockExists: existsSync(lockPath) },
      { error: "SNAPSHOT_STALE", lockExists: true },
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test("should reject overwrite when existing bytes differ", async () => {
  const target = path.join(pullDirectory, "components", "button.html");
  const original = readFileSync(target);
  original[0] = original[0] === 60 ? 61 : 60;
  writeFileSync(target, original);
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: ["components/button.html"],
  });

  assert.equal(result.data.error, "PULL_FAILED");
});

test("should report partial pulls as errors with partial result data", async () => {
  const previousManifest = JSON.parse(
    readFileSync(path.join(pullDirectory, ".claude-design.json"), "utf8"),
  );
  const previousButton = previousManifest.files.find(
    (entry) => entry.path === "components/button.html",
  );
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: ["components/button.html", "components/new.html"],
  });
  const currentManifest = JSON.parse(
    readFileSync(path.join(pullDirectory, ".claude-design.json"), "utf8"),
  );
  const currentButton = currentManifest.files.find(
    (entry) => entry.path === "components/button.html",
  );

  assert.deepEqual(
    {
      error: result.data.error,
      buttonProvenanceUnchanged: currentButton.sha256 === previousButton.sha256,
      newPathTracked: currentManifest.files.some(
        (entry) => entry.path === "components/new.html",
      ),
    },
    {
      error: "PARTIAL_PULL",
      buttonProvenanceUnchanged: true,
      newPathTracked: true,
    },
  );
});

test("should replace changed snapshot bytes only with explicit overwrite", async () => {
  const result = await callTool("design_pull", {
    projectId: "mock-pid-1",
    dir: pullDirectory,
    paths: ["components/button.html"],
    overwrite: true,
  });

  assert.equal(result.isError, false);
});

test("should not prune through a cache object-directory junction", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-cache-junction-"),
  );
  const cache = path.join(root, "cache");
  const outside = path.join(root, "outside");
  const protectedFile = path.join(outside, `${"a".repeat(64)}.data`);
  mkdirSync(cache);
  mkdirSync(outside);
  writeFileSync(protectedFile, "keep");
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(protectedFile, old, old);
  symlinkSync(
    outside,
    path.join(cache, "objects"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const cacheChild = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DESIGN_BRIDGE_CACHE_DIR: cache },
  });
  cacheChild.stderr.setEncoding("utf8");
  try {
    await waitForServerReady(cacheChild);
    const survived = existsSync(protectedFile);
    assert.equal(survived, true);
  } finally {
    cacheChild.stdin.end();
    if (cacheChild.exitCode === null) {
      cacheChild.kill();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("should enforce the configured cache entry cap", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-design-cache-cap-"));
  const cache = path.join(root, "cache");
  const objects = path.join(cache, "objects");
  const oldKey = "a".repeat(64);
  const newKey = "b".repeat(64);
  mkdirSync(objects, { recursive: true });
  for (const extension of ["data", "json"]) {
    writeFileSync(path.join(objects, `${oldKey}.${extension}`), "old");
    writeFileSync(path.join(objects, `${newKey}.${extension}`), "new");
  }
  const old = new Date(Date.now() - 60 * 1000);
  for (const extension of ["data", "json"]) {
    utimesSync(path.join(objects, `${oldKey}.${extension}`), old, old);
  }
  const cacheChild = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DESIGN_BRIDGE_CACHE_DIR: cache,
      DESIGN_BRIDGE_CACHE_MAX_ENTRIES: "1",
    },
  });
  cacheChild.stderr.setEncoding("utf8");
  try {
    await waitForServerReady(cacheChild);
    assert.deepEqual(
      {
        oldData: existsSync(path.join(objects, `${oldKey}.data`)),
        oldMetadata: existsSync(path.join(objects, `${oldKey}.json`)),
        newData: existsSync(path.join(objects, `${newKey}.data`)),
        newMetadata: existsSync(path.join(objects, `${newKey}.json`)),
      },
      {
        oldData: false,
        oldMetadata: false,
        newData: true,
        newMetadata: true,
      },
    );
  } finally {
    cacheChild.stdin.end();
    if (cacheChild.exitCode === null) {
      cacheChild.kill();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("should prune stale cache write leftovers", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-cache-leftover-"),
  );
  const cache = path.join(root, "cache");
  const objects = path.join(cache, "objects");
  const temporary = path.join(
    objects,
    `.${"d".repeat(64)}.data.00000000-0000-4000-8000-000000000000.tmp`,
  );
  mkdirSync(objects, { recursive: true });
  writeFileSync(temporary, "leftover");
  const old = new Date(Date.now() - 1000);
  utimesSync(temporary, old, old);
  const cacheChild = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DESIGN_BRIDGE_CACHE_DIR: cache,
      DESIGN_BRIDGE_CACHE_RETENTION_MS: "10",
    },
  });
  cacheChild.stderr.setEncoding("utf8");
  try {
    await waitForServerReady(cacheChild);
    assert.equal(existsSync(temporary), false);
  } finally {
    cacheChild.stdin.end();
    if (cacheChild.exitCode === null) {
      cacheChild.kill();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("should prune expired cache entries while running", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-cache-periodic-"),
  );
  const cache = path.join(root, "cache");
  const objects = path.join(cache, "objects");
  const key = "c".repeat(64);
  const cacheChild = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DESIGN_BRIDGE_CACHE_DIR: cache,
      DESIGN_BRIDGE_CACHE_RETENTION_MS: "10",
    },
  });
  cacheChild.stderr.setEncoding("utf8");
  try {
    await waitForServerReady(cacheChild);
    for (const extension of ["data", "json"]) {
      const cachePath = path.join(objects, `${key}.${extension}`);
      writeFileSync(cachePath, "expired");
      const old = new Date(Date.now() - 1000);
      utimesSync(cachePath, old, old);
    }
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (
          !existsSync(path.join(objects, `${key}.data`)) &&
          !existsSync(path.join(objects, `${key}.json`))
        ) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("Periodic cache prune timeout"));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });

    assert.equal(existsSync(path.join(objects, `${key}.data`)), false);
  } finally {
    cacheChild.stdin.end();
    if (cacheChild.exitCode === null) {
      cacheChild.kill();
    }
    rmSync(root, { recursive: true, force: true });
  }
});
