#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE_PATTERN = /\.test\.mjs$/;

/**
 * Discover test modules recursively without relying on shell glob expansion.
 *
 * @param {Array<string>} roots Test directories relative to the current directory.
 * @returns {Array<string>} Sorted absolute test-module paths.
 */
export const discoverTestFiles = (roots) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        files.push(candidate);
      }
    }
  };

  for (const root of roots) {
    visit(path.resolve(root));
  }
  return files.sort();
};

const run = () => {
  const roots = process.argv.slice(2);
  if (!roots.length) {
    throw new Error("At least one test directory is required");
  }
  const files = discoverTestFiles(roots);
  if (!files.length) {
    throw new Error(`No test modules were found under: ${roots.join(", ")}`);
  }
  const child = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
  });
  if (child.error) {
    throw new Error("Could not start the Node test process", {
      cause: child.error,
    });
  }
  if (child.status === null) {
    throw new Error(
      `Node test process ended without an exit status (signal=${String(child.signal)})`,
    );
  }
  process.exitCode = child.status;
};

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  run();
}
