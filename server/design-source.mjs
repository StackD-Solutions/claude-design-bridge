// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { delegate } from "./claude-delegate.mjs";

const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  read: true,
  write: false,
  revisions: false,
  remoteChecksums: false,
});

/**
 * Create the read-only Claude Code DesignSync source adapter.
 *
 * The adapter intentionally returns the delegate's structured result unchanged. Raw
 * payload validation, decoding, hashing, and snapshot policy belong to the shared
 * bridge layer so every future transport must pass through the same checks.
 *
 * @param {object} [options] Adapter dependencies.
 * @param {typeof delegate} [options.delegateRead] Read delegate used by the adapter.
 * @returns {Readonly<object>} Immutable DesignSource implementation.
 */
export const createClaudeCodeDesignSource = ({ delegateRead = delegate } = {}) => {
  if (typeof delegateRead !== "function") {
    throw new TypeError("delegateRead must be a function");
  }

  return Object.freeze({
    id: "claude-code-designsync",
    transport: "claude-cli",
    capabilities: CLAUDE_CODE_CAPABILITIES,
    listProjects: ({ signal } = {}) => {
      return delegateRead("list_projects", {}, { signal });
    },
    getProject: (projectId, { signal } = {}) => {
      return delegateRead("get_project", { projectId }, { signal });
    },
    listFiles: (projectId, { signal } = {}) => {
      return delegateRead("list_files", { projectId }, { signal });
    },
    getFile: (projectId, filePath, { signal } = {}) => {
      return delegateRead(
        "get_file",
        { projectId, path: filePath },
        { signal },
      );
    },
  });
};

export const claudeCodeDesignSource = createClaudeCodeDesignSource();
