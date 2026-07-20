import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";

const designUrl = process.env.DESIGN_BRIDGE_LIVE_URL;
const expectedBytes = Number(process.env.DESIGN_BRIDGE_LIVE_BYTES);
const expectedSha256 = process.env.DESIGN_BRIDGE_LIVE_SHA256;
const serverPath = path.resolve(
  import.meta.dirname,
  "../../server/design-bridge.mjs",
);

test(
  "should pull the live linked Claude Design file byte-for-byte",
  { skip: !designUrl, timeout: 240000 },
  async () => {
    const workspaceRoot = mkdtempSync(
      path.join(os.tmpdir(), "codex-design-live-test-"),
    );
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        DESIGN_BRIDGE_CACHE_DIR: path.join(workspaceRoot, "cache"),
      },
    });
    let nextId = 0;
    let stdoutBuffer = "";
    const pending = new Map();
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(
          () => reject(new Error(`RPC timeout for ${method}`)),
          210000,
        );
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
      const data = JSON.parse(response.result.content[0].text);
      if (response.result.isError) {
        throw new Error(`${data.error}: ${data.detail}`);
      }
      return data;
    };
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
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          request.resolve(message);
        }
      }
    });

    try {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "live-test-client", version: "1.0.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const resolved = await callTool("design_resolve_link", {
        url: designUrl,
      });
      const pulled = await callTool(
        "design_pull",
        {
          projectId: resolved.projectId,
          paths: [resolved.path],
          refresh: true,
        },
        {
          "codex/sandbox-state-meta": {
            permissionProfile: { type: "disabled" },
            sandboxCwd: pathToFileURL(workspaceRoot).toString(),
          },
        },
      );
      const file = pulled.written[0];

      assert.deepEqual(
        { bytes: file.bytes, sha256: file.sha256 },
        { bytes: expectedBytes, sha256: expectedSha256 },
      );
    } finally {
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill();
      }
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);
