import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const serverPath = path.resolve(
  import.meta.dirname,
  "../../plugins/claude-design-bridge/server/design-bridge.mjs",
);
const fixturePath = path.resolve(
  import.meta.dirname,
  "../fixtures/design-sync.json",
);
const pluginManifestPath = path.resolve(
  import.meta.dirname,
  "../../plugins/claude-design-bridge/.codex-plugin/plugin.json",
);
const sandboxMetaKey = "codex/sandbox-state-meta";
const designPath = "components/button.html";
const initialDesignContent = '<button data-version="1">One</button>';
const updatedDesignContent = '<button data-version="2">Two</button>';
const localEditContent = '<button data-version="local">Local edit</button>';
const fixtureTemplate = JSON.parse(readFileSync(fixturePath, "utf8"));

const startHarness = (environment = {}) => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ...environment },
  });
  let buffer = "";
  let nextId = 0;
  const messages = [];
  const waiters = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        messages.push(message);
      }
    }
  });

  const nextMessage = () =>
    new Promise((resolve, reject) => {
      if (messages.length) {
        resolve(messages.shift());
        return;
      }
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error("MCP response timeout"));
      }, 5000);
      waiters.push(waiter);
    });

  const request = async (method, params = {}) => {
    const id = ++nextId;
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return nextMessage();
  };

  const initialize = () =>
    request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "lifecycle-test", version: "1.0.0" },
    });

  const close = () => {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill();
    }
  };

  return { child, close, initialize, messages, nextMessage, request };
};

const startFreshnessHarness = async (context, projectId) => {
  const workspaceRoot = mkdtempSync(
    path.join(os.tmpdir(), `codex-design-freshness-${projectId}-`),
  );
  const runtimeFixturePath = path.join(workspaceRoot, "design-sync.json");
  const snapshotDirectory = path.join(
    workspaceRoot,
    ".design",
    "claude",
    projectId,
  );
  const snapshotPath = path.join(snapshotDirectory, ...designPath.split("/"));
  const manifestPath = path.join(snapshotDirectory, ".claude-design.json");
  const setRemoteContent = (content) => {
    const fixture = structuredClone(fixtureTemplate);
    fixture.get_file.content = content;
    writeFileSync(runtimeFixturePath, `${JSON.stringify(fixture)}\n`);
  };
  setRemoteContent(initialDesignContent);
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: runtimeFixturePath,
    DESIGN_BRIDGE_CACHE_DIR: path.join(workspaceRoot, "cache"),
    DESIGN_BRIDGE_CACHE_TTL_MS: "600000",
  });
  context.after(() => {
    harness.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const callTool = async (name, argumentsValue) => {
    const response = await harness.request("tools/call", {
      name,
      arguments: argumentsValue,
      _meta: {
        [sandboxMetaKey]: {
          permissionProfile: { type: "disabled" },
          sandboxCwd: pathToFileURL(workspaceRoot).toString(),
        },
      },
    });
    return {
      isError: response.result.isError,
      data: JSON.parse(response.result.content[0].text),
    };
  };

  const pull = (options = {}) =>
    callTool("design_pull", {
      projectId,
      paths: [designPath],
      ...options,
    });

  return {
    callTool,
    manifestPath,
    projectId,
    pull,
    setRemoteContent,
    snapshotPath,
  };
};

test("should reject requests before initialization", async (context) => {
  const harness = startHarness();
  context.after(harness.close);

  const response = await harness.request("tools/list");

  assert.equal(response.error.code, -32002);
});

test("should respond to ping before initialization", async (context) => {
  const harness = startHarness();
  context.after(harness.close);

  const response = await harness.request("ping");

  assert.deepEqual(response.result, {});
});

test("should require the initialized notification before tool operations", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();

  const response = await harness.request("tools/list");

  assert.equal(response.error.code, -32002);
});

test("should respond to ping before the initialized notification", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();

  const response = await harness.request("ping");

  assert.deepEqual(response.result, {});
});

test("should return the fixed supported protocol version", async (context) => {
  const harness = startHarness();
  context.after(harness.close);

  const response = await harness.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lifecycle-test", version: "1.0.0" },
  });

  assert.equal(response.result.protocolVersion, "2025-06-18");
});

test("should report the plugin manifest version during initialization", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));

  const response = await harness.initialize();

  assert.equal(response.result.serverInfo.version, pluginManifest.version);
});

test("should advertise Codex sandbox-state metadata support", async (context) => {
  const harness = startHarness();
  context.after(harness.close);

  const response = await harness.initialize();

  assert.deepEqual(
    response.result.capabilities.experimental[sandboxMetaKey],
    {},
  );
});

test("should reject repeated initialization", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();

  const response = await harness.initialize();

  assert.equal(response.error.code, -32600);
});

test("should reject JSON-RPC batches", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  harness.child.stdin.write(
    `${JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])}\n`,
  );

  const response = await harness.nextMessage();

  assert.equal(response.error.code, -32600);
});

test("should return a null id for an invalid envelope with a structured id", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "1.0", id: { structured: true }, method: "ping" })}\n`,
  );

  const response = await harness.nextMessage();

  assert.equal(response.id, null);
});

test("should reject a null MCP request id", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" })}\n`,
  );

  const response = await harness.nextMessage();

  assert.equal(response.error.code, -32600);
});

test("should reject an unknown method", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("unknown/method");

  assert.equal(response.error.code, -32601);
});

test("should reject a duplicate active request id", async (context) => {
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
  });
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: "duplicate-request",
    method: "tools/call",
    params: { name: "design_list_projects", arguments: {} },
  });
  harness.child.stdin.write(`${request}\n${request}\n`);

  const responses = await Promise.all([
    harness.nextMessage(),
    harness.nextMessage(),
  ]);

  assert.equal(
    responses.filter((response) => response.error?.code === -32600).length,
    1,
  );
});

test("should reject an active request id reused by another method", async (context) => {
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
  });
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const id = "cross-method-duplicate";
  harness.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "design_list_projects", arguments: {} },
    })}\n${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`,
  );

  const responses = await Promise.all([
    harness.nextMessage(),
    harness.nextMessage(),
  ]);

  assert.equal(
    responses.filter((response) => response.error?.code === -32600).length,
    1,
  );
});

test("should suppress the response for a cancelled request", async (context) => {
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
  });
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const requestId = "cancelled-request";
  harness.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: "design_list_projects", arguments: {} },
    })}\n${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(harness.messages.length, 0);
});

test("should reject notification-only methods sent as requests", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const responses = await Promise.all([
    harness.request("notifications/roots/list_changed"),
    harness.request("notifications/cancelled", { requestId: 1 }),
  ]);

  assert.deepEqual(
    responses.map((response) => response.error.code),
    [-32600, -32600],
  );
});

test("should distinguish active string and number request ids", async (context) => {
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
  });
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const request = (id) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "design_list_projects", arguments: {} },
    });
  harness.child.stdin.write(`${request(99)}\n${request("99")}\n`);

  const responses = await Promise.all([
    harness.nextMessage(),
    harness.nextMessage(),
  ]);

  assert.deepEqual(
    new Set(
      responses
        .filter((response) => response.result)
        .map((response) => `${typeof response.id}:${response.id}`),
    ),
    new Set(["number:99", "string:99"]),
  );
});

test("should reject malformed tools call arguments", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("tools/call", {
    name: "design_list_projects",
    arguments: [],
  });

  assert.equal(response.error.code, -32602);
});

test("should reject an explicit null project result", async (context) => {
  const fixtureRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-null-project-"),
  );
  const nullFixturePath = path.join(fixtureRoot, "fixture.json");
  writeFileSync(
    nullFixturePath,
    JSON.stringify({ get_project: { method: "get_project", project: null } }),
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: nullFixturePath,
  });
  context.after(() => {
    harness.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("tools/call", {
    name: "design_get_project",
    arguments: { projectId: "mock-pid-1" },
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.equal(result.error, "BAD_RESULT");
});

test("should disable cache reuse when the TTL is zero", async (context) => {
  const cacheRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-zero-cache-ttl-"),
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
    DESIGN_BRIDGE_CACHE_DIR: path.join(cacheRoot, "cache"),
    DESIGN_BRIDGE_CACHE_TTL_MS: "0",
  });
  context.after(() => {
    harness.close();
    rmSync(cacheRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const fromCache = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await harness.request("tools/call", {
      name: "design_get_file",
      arguments: {
        projectId: "mock-pid-1",
        path: "components/button.html",
        refresh: false,
      },
    });
    fromCache.push(JSON.parse(response.result.content[0].text).fromCache);
  }

  assert.deepEqual(fromCache, [false, false]);
});

test("should fetch fresh design bytes by default despite a warm cache", async (context) => {
  const state = await startFreshnessHarness(context, "fresh-default");
  const warmed = await state.callTool("design_get_file", {
    projectId: state.projectId,
    path: designPath,
    refresh: false,
  });
  state.setRemoteContent(updatedDesignContent);

  const pulled = await state.pull();

  assert.deepEqual(
    {
      warmedContent: warmed.data.content,
      warmedFromCache: warmed.data.fromCache,
      pullIsError: pulled.isError,
      pulledContent: readFileSync(state.snapshotPath, "utf8"),
      pulledFromCache: pulled.data.written?.[0]?.fromCache,
    },
    {
      warmedContent: initialDesignContent,
      warmedFromCache: false,
      pullIsError: false,
      pulledContent: updatedDesignContent,
      pulledFromCache: false,
    },
  );
});

test("should automatically update an unmodified manifest-managed snapshot", async (context) => {
  const state = await startFreshnessHarness(context, "managed-update");
  const initial = await state.pull();
  const previousManifest = JSON.parse(
    readFileSync(state.manifestPath, "utf8"),
  );
  state.setRemoteContent(updatedDesignContent);

  const updated = await state.pull();
  const currentManifest = JSON.parse(readFileSync(state.manifestPath, "utf8"));

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      updateIsError: updated.isError,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      fromCache: updated.data.written?.[0]?.fromCache,
      unchanged: updated.data.written?.[0]?.unchanged,
      updated: updated.data.written?.[0]?.updated,
      forced: updated.data.written?.[0]?.forced,
      manifestChanged:
        previousManifest.files[0].sha256 !== currentManifest.files[0].sha256,
      manifestMatchesPull:
        currentManifest.files[0].sha256 === updated.data.written?.[0]?.sha256,
    },
    {
      initialIsError: false,
      updateIsError: false,
      localContent: updatedDesignContent,
      fromCache: false,
      unchanged: false,
      updated: true,
      forced: false,
      manifestChanged: true,
      manifestMatchesPull: true,
    },
  );
});

test("should reuse cached design bytes only when refresh is false", async (context) => {
  const state = await startFreshnessHarness(context, "explicit-cache");
  const initial = await state.pull();
  const previousManifest = JSON.parse(
    readFileSync(state.manifestPath, "utf8"),
  );
  state.setRemoteContent(updatedDesignContent);

  const cached = await state.pull({ refresh: false });
  const currentManifest = JSON.parse(readFileSync(state.manifestPath, "utf8"));

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      cachedIsError: cached.isError,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      fromCache: cached.data.written?.[0]?.fromCache,
      unchanged: cached.data.written?.[0]?.unchanged,
      updated: cached.data.written?.[0]?.updated,
      forced: cached.data.written?.[0]?.forced,
      manifestSha256: currentManifest.files[0].sha256,
    },
    {
      initialIsError: false,
      cachedIsError: false,
      localContent: initialDesignContent,
      fromCache: true,
      unchanged: true,
      updated: false,
      forced: false,
      manifestSha256: previousManifest.files[0].sha256,
    },
  );
});

test("should preserve a local snapshot edit without overwrite", async (context) => {
  const state = await startFreshnessHarness(context, "local-conflict");
  const initial = await state.pull();
  const previousManifest = readFileSync(state.manifestPath, "utf8");
  writeFileSync(state.snapshotPath, localEditContent);
  state.setRemoteContent(updatedDesignContent);

  const conflict = await state.pull();
  const fileError = conflict.data.data?.errors.find(
    (error) => error.path === designPath,
  );

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      conflictIsError: conflict.isError,
      error: conflict.data.error,
      fileError: fileError?.error,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      manifestUnchanged:
        readFileSync(state.manifestPath, "utf8") === previousManifest,
    },
    {
      initialIsError: false,
      conflictIsError: true,
      error: "PULL_FAILED",
      fileError: "FILE_EXISTS",
      localContent: localEditContent,
      manifestUnchanged: true,
    },
  );
});

test("should replace a local snapshot edit when overwrite is true", async (context) => {
  const state = await startFreshnessHarness(context, "force-overwrite");
  const initial = await state.pull();
  writeFileSync(state.snapshotPath, localEditContent);
  state.setRemoteContent(updatedDesignContent);

  const forced = await state.pull({ overwrite: true });
  const currentManifest = JSON.parse(readFileSync(state.manifestPath, "utf8"));

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      forcedIsError: forced.isError,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      fromCache: forced.data.written?.[0]?.fromCache,
      unchanged: forced.data.written?.[0]?.unchanged,
      updated: forced.data.written?.[0]?.updated,
      forced: forced.data.written?.[0]?.forced,
      manifestMatchesPull:
        currentManifest.files[0].sha256 === forced.data.written?.[0]?.sha256,
    },
    {
      initialIsError: false,
      forcedIsError: false,
      localContent: updatedDesignContent,
      fromCache: false,
      unchanged: false,
      updated: true,
      forced: true,
      manifestMatchesPull: true,
    },
  );
});

test("should update an unmodified managed snapshot when overwrite is false", async (context) => {
  const state = await startFreshnessHarness(context, "explicit-preserve");
  const initial = await state.pull();
  state.setRemoteContent(updatedDesignContent);

  const updated = await state.pull({ overwrite: false });

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      updatedIsError: updated.isError,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      updated: updated.data.written?.[0]?.updated,
      forced: updated.data.written?.[0]?.forced,
    },
    {
      initialIsError: false,
      updatedIsError: false,
      localContent: updatedDesignContent,
      updated: true,
      forced: false,
    },
  );
});

test("should fail closed when the snapshot manifest is invalid", async (context) => {
  const state = await startFreshnessHarness(context, "invalid-manifest");
  const initial = await state.pull();
  writeFileSync(state.manifestPath, "not-json\n");
  state.setRemoteContent(updatedDesignContent);

  const rejected = await state.pull({ overwrite: true });

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      rejectedIsError: rejected.isError,
      error: rejected.data.error,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      manifestContent: readFileSync(state.manifestPath, "utf8"),
    },
    {
      initialIsError: false,
      rejectedIsError: true,
      error: "MANIFEST_INVALID",
      localContent: initialDesignContent,
      manifestContent: "not-json\n",
    },
  );
});

test("should adopt identical existing bytes when the manifest is missing", async (context) => {
  const state = await startFreshnessHarness(context, "manifest-adoption");
  const initial = await state.pull();
  rmSync(state.manifestPath);

  const adopted = await state.pull();

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      adoptedIsError: adopted.isError,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      unchanged: adopted.data.written?.[0]?.unchanged,
      manifestExists: existsSync(state.manifestPath),
    },
    {
      initialIsError: false,
      adoptedIsError: false,
      localContent: initialDesignContent,
      unchanged: true,
      manifestExists: true,
    },
  );
});

test("should preserve differing untracked bytes when the manifest is missing", async (context) => {
  const state = await startFreshnessHarness(context, "untracked-conflict");
  const initial = await state.pull();
  rmSync(state.manifestPath);
  writeFileSync(state.snapshotPath, localEditContent);
  state.setRemoteContent(updatedDesignContent);

  const rejected = await state.pull();
  const fileError = rejected.data.data?.errors.find(
    (error) => error.path === designPath,
  );

  assert.deepEqual(
    {
      initialIsError: initial.isError,
      rejectedIsError: rejected.isError,
      error: rejected.data.error,
      fileError: fileError?.error,
      localContent: readFileSync(state.snapshotPath, "utf8"),
      manifestExists: existsSync(state.manifestPath),
    },
    {
      initialIsError: false,
      rejectedIsError: true,
      error: "PULL_FAILED",
      fileError: "FILE_EXISTS",
      localContent: localEditContent,
      manifestExists: false,
    },
  );
});

test("should keep unsafe cache paths out of tool warnings", async (context) => {
  const cacheRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-private-cache-warning-"),
  );
  const outside = path.join(cacheRoot, "outside");
  const cacheLink = path.join(cacheRoot, "cache-link");
  mkdirSync(outside);
  symlinkSync(
    outside,
    cacheLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
    DESIGN_BRIDGE_CACHE_DIR: cacheLink,
  });
  context.after(() => {
    harness.close();
    rmSync(cacheRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("tools/call", {
    name: "design_get_file",
    arguments: {
      projectId: "mock-pid-1",
      path: "components/button.html",
    },
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.deepEqual(
    {
      includesCacheRoot: JSON.stringify(result).includes(cacheRoot),
      warnings: result.warnings,
    },
    {
      includesCacheRoot: false,
      warnings: ["Could not validate the configured cache directory"],
    },
  );
});

test("should not respond to tool call notifications", async (context) => {
  const harness = startHarness();
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  harness.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "design_resolve_link",
        arguments: { url: "https://claude.ai/design/p/project-1" },
      },
    })}\n`,
  );

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(harness.messages.length, 0);
});

test("should pull under the per-call Codex sandbox root without MCP roots", async (context) => {
  const workspaceRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-sandbox-root-"),
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
    DESIGN_BRIDGE_CACHE_DIR: path.join(workspaceRoot, "cache"),
  });
  context.after(() => {
    harness.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("tools/call", {
    name: "design_pull",
    arguments: {
      projectId: "mock-pid-1",
      paths: ["components/button.html"],
    },
    _meta: {
      [sandboxMetaKey]: {
        permissionProfile: { type: "disabled" },
        sandboxCwd: pathToFileURL(workspaceRoot).toString(),
      },
    },
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.equal(result.count, 1);
});

test("should reject malformed sandbox metadata without another authorized root", async (context) => {
  const workspaceRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-bad-sandbox-root-"),
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
    DESIGN_BRIDGE_CACHE_DIR: path.join(workspaceRoot, "cache"),
  });
  context.after(() => {
    harness.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("tools/call", {
    name: "design_pull",
    arguments: {
      projectId: "mock-pid-1",
      dir: path.join(workspaceRoot, ".design", "claude", "mock-pid-1"),
      paths: ["components/button.html"],
    },
    _meta: {
      [sandboxMetaKey]: {
        sandboxCwd: "https://example.com/not-a-workspace",
      },
    },
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.equal(result.error, "WORKSPACE_ROOT_UNAVAILABLE");
});

test("should fail closed when configured roots are invalid", async (context) => {
  const workspaceRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-invalid-allowlist-"),
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
    DESIGN_BRIDGE_CACHE_DIR: path.join(workspaceRoot, "cache"),
    DESIGN_BRIDGE_ALLOWED_ROOTS: path.join(workspaceRoot, "missing"),
  });
  context.after(() => {
    harness.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const response = await harness.request("tools/call", {
    name: "design_pull",
    arguments: {
      projectId: "mock-pid-1",
      paths: ["components/button.html"],
    },
    _meta: {
      [sandboxMetaKey]: {
        sandboxCwd: pathToFileURL(workspaceRoot).toString(),
      },
    },
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.equal(result.error, "WORKSPACE_ROOT_UNAVAILABLE");
});

test("should not reuse sandbox metadata from a previous tool call", async (context) => {
  const workspaceRoot = mkdtempSync(
    path.join(os.tmpdir(), "codex-design-ephemeral-root-"),
  );
  const harness = startHarness({
    NODE_ENV: "test",
    DESIGN_BRIDGE_TEST_FIXTURE: fixturePath,
    DESIGN_BRIDGE_CACHE_DIR: path.join(workspaceRoot, "cache"),
  });
  context.after(() => {
    harness.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const argumentsValue = {
    projectId: "mock-pid-1",
    dir: path.join(workspaceRoot, ".design", "claude", "mock-pid-1"),
    paths: ["components/button.html"],
  };
  const first = await harness.request("tools/call", {
    name: "design_pull",
    arguments: argumentsValue,
    _meta: {
      [sandboxMetaKey]: {
        sandboxCwd: pathToFileURL(workspaceRoot).toString(),
      },
    },
  });
  if (first.result.isError) {
    throw new Error(first.result.content[0].text);
  }

  const response = await harness.request("tools/call", {
    name: "design_pull",
    arguments: argumentsValue,
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.equal(result.error, "WORKSPACE_ROOT_UNAVAILABLE");
});

test("should process separately bounded messages delivered in one chunk", async (context) => {
  const harness = startHarness({
    DESIGN_BRIDGE_MAX_INCOMING_MESSAGE_BYTES: "256",
  });
  context.after(harness.close);
  await harness.initialize();
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const firstId = "first-bounded-message";
  const secondId = "second-bounded-message";
  const padding = "x".repeat(120);
  harness.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: firstId, method: "ping", params: { padding } })}\n${JSON.stringify({ jsonrpc: "2.0", id: secondId, method: "ping", params: { padding } })}\n`,
  );

  const responses = await Promise.all([
    harness.nextMessage(),
    harness.nextMessage(),
  ]);

  assert.deepEqual(
    responses.map((response) => response.id),
    [firstId, secondId],
  );
});
