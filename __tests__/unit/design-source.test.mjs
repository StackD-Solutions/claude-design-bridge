import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createClaudeCodeDesignSource } from "../../plugins/claude-design-bridge/server/design-source.mjs";

const success = Object.freeze({ ok: true, data: Object.freeze({ value: 1 }) });

describe("createClaudeCodeDesignSource", () => {
  test("should reject a non-function delegate", () => {
    assert.throws(
      () => createClaudeCodeDesignSource({ delegateRead: null }),
      /delegateRead must be a function/,
    );
  });

  test("should expose immutable read-only capabilities", () => {
    const source = createClaudeCodeDesignSource({
      delegateRead: async () => success,
    });

    assert.deepEqual(source.capabilities, {
      read: true,
      write: false,
      revisions: false,
      remoteChecksums: false,
    });
  });

  test("should freeze the source and capabilities", () => {
    const source = createClaudeCodeDesignSource({
      delegateRead: async () => success,
    });

    assert.deepEqual(
      { source: Object.isFrozen(source), capabilities: Object.isFrozen(source.capabilities) },
      { source: true, capabilities: true },
    );
  });

  test("should delegate list projects with the cancellation signal", async () => {
    const controller = new AbortController();
    let observed;
    const source = createClaudeCodeDesignSource({
      delegateRead: async (...args) => {
        observed = args;
        return success;
      },
    });

    await source.listProjects({ signal: controller.signal });

    assert.deepEqual(observed, ["list_projects", {}, { signal: controller.signal }]);
  });

  test("should delegate get project with the exact project identifier", async () => {
    let observed;
    const source = createClaudeCodeDesignSource({
      delegateRead: async (...args) => {
        observed = args;
        return success;
      },
    });

    await source.getProject("project-1");

    assert.deepEqual(observed, ["get_project", { projectId: "project-1" }, { signal: undefined }]);
  });

  test("should delegate list files with the exact project identifier", async () => {
    let observed;
    const source = createClaudeCodeDesignSource({
      delegateRead: async (...args) => {
        observed = args;
        return success;
      },
    });

    await source.listFiles("project-1");

    assert.deepEqual(observed, ["list_files", { projectId: "project-1" }, { signal: undefined }]);
  });

  test("should delegate get file with exact identity fields", async () => {
    let observed;
    const source = createClaudeCodeDesignSource({
      delegateRead: async (...args) => {
        observed = args;
        return success;
      },
    });

    await source.getFile("project-1", "screen.html");

    assert.deepEqual(observed, [
      "get_file",
      { projectId: "project-1", path: "screen.html" },
      { signal: undefined },
    ]);
  });

  test("should preserve structured backend failures", async () => {
    const backendFailure = Object.freeze({
      ok: false,
      error: "BACKEND_FAILED",
      detail: "failure",
    });
    const source = createClaudeCodeDesignSource({
      delegateRead: async () => backendFailure,
    });

    const result = await source.listProjects();

    assert.equal(result, backendFailure);
  });

  test("should leave unexpected backend data for shared validation", async () => {
    const unexpected = Object.freeze({ ok: true, data: "unexpected" });
    const source = createClaudeCodeDesignSource({
      delegateRead: async () => unexpected,
    });

    const result = await source.getProject("project-1");

    assert.equal(result, unexpected);
  });

  test("should propagate delegate exceptions without converting them to success", async () => {
    const cause = new Error("delegate crashed");
    const source = createClaudeCodeDesignSource({
      delegateRead: async () => {
        throw cause;
      },
    });

    await assert.rejects(source.listProjects(), (error) => error === cause);
  });
});
