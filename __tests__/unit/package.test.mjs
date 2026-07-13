import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const pluginRoot = path.join(repositoryRoot, "plugins", "claude-design-bridge");
const serverRoot = path.join(pluginRoot, "server");
const skillRoot = path.join(pluginRoot, "skills", "claude-design-bridge");
const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
const manifest = JSON.parse(
  readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
);
const mcpConfig = JSON.parse(
  readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"),
);

test("should front-load the Claude Design URL trigger", () => {
  assert.match(skill, /description:[\s\S]*claude\.ai\/design/);
});

test("should exclude generic design work from implicit routing", () => {
  assert.match(skill, /Do not use for generic UI\/design work/);
});

test("should explicitly enable implicit skill invocation", () => {
  const metadata = readFileSync(
    path.join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );

  assert.match(metadata, /allow_implicit_invocation: true/);
});

test("should declare remote reads and local snapshot writes", () => {
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);
});

test("should keep every default prompt within the Codex limit", () => {
  assert.equal(
    manifest.interface.defaultPrompt.every((prompt) => prompt.length <= 128),
    true,
  );
});

test("should run the bundled MCP entrypoint from the plugin root", () => {
  const server = mcpConfig.mcpServers["claude-design-bridge"];

  assert.deepEqual(
    { args: server.args, cwd: server.cwd },
    { args: ["./server/design-bridge.mjs"], cwd: "." },
  );
});

test("should include the bundled MCP server entrypoint", () => {
  assert.equal(
    existsSync(path.join(pluginRoot, "server", "design-bridge.mjs")),
    true,
  );
});

test("should include the license claimed by the plugin manifest", () => {
  assert.equal(existsSync(path.join(pluginRoot, "LICENSE")), true);
});

test("should use Apache-2.0 SPDX headers in every server module", () => {
  const filesWithUnexpectedHeaders = readdirSync(serverRoot)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => {
      const source = readFileSync(path.join(serverRoot, name), "utf8");
      return !/^(?:#![^\n]*\r?\n)?\/\/ SPDX-License-Identifier: Apache-2\.0(?:\r?\n|$)/.test(
        source,
      );
    });

  assert.deepEqual(filesWithUnexpectedHeaders, []);
});
