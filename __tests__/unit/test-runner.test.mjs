import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { discoverTestFiles } from "../../scripts/run-tests.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("should discover only unit and integration test modules", () => {
  const files = discoverTestFiles([
    path.join(repositoryRoot, "__tests__", "unit"),
    path.join(repositoryRoot, "__tests__", "integration"),
  ]).map((file) =>
    path.relative(repositoryRoot, file).split(path.sep).join("/"),
  );

  assert.deepEqual(files, [
    "__tests__/integration/mcp-lifecycle.test.mjs",
    "__tests__/integration/mcp.test.mjs",
    "__tests__/unit/browser-export.test.mjs",
    "__tests__/unit/claude-delegate.test.mjs",
    "__tests__/unit/design-bridge.test.mjs",
    "__tests__/unit/design-source.test.mjs",
    "__tests__/unit/package.test.mjs",
    "__tests__/unit/test-runner.test.mjs",
  ]);
});
