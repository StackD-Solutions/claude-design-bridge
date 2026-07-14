import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import test, { describe } from "node:test";

import {
  createBatchToolResultMatcher,
  createToolResultMatcher,
  delegate,
  delegateBatch,
  sanitizeDiagnostic,
} from "../../plugins/claude-design-bridge/server/claude-delegate.mjs";

const method = "get_file";
const args = { projectId: "project-1", path: "Screen.dc.html" };
const toolUseId = "toolu_test";

const initEvent = {
  type: "system",
  subtype: "init",
  tools: ["DesignSync"],
};

const sessionLimitMessage =
  "You've hit your session limit · resets 4:30pm (Europe/Amsterdam)";
const sessionLimitDetail = `Claude Code: ${sessionLimitMessage}`;

const sessionLimitEvent = {
  type: "assistant",
  message: {
    error: "rate_limit",
    content: [{ type: "text", text: sessionLimitMessage }],
  },
};

const toolUseEvent = (input = { method, ...args }) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: toolUseId, name: "DesignSync", input }],
  },
});

const toolResultEvent = (raw, overrides = {}) => ({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "model-facing",
        ...overrides,
      },
    ],
  },
  tool_use_result: raw,
});

const batchPaths = ["one.html", "two.html"];
const batchToolUse = (filePath, id) => ({
  type: "tool_use",
  id,
  name: "DesignSync",
  input: { method: "get_file", projectId: args.projectId, path: filePath },
});
const batchToolUseEvent = (toolUses) => ({
  type: "assistant",
  message: { content: toolUses },
});
const batchToolResultEvent = (filePath, id, overrides = {}) => ({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: "model-facing",
        ...overrides,
      },
    ],
  },
  tool_use_result: {
    method: "get_file",
    projectId: args.projectId,
    path: filePath,
    content: filePath,
  },
});

const createFakeChild = ({ closeDelayMs = 0 } = {}) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCount = 0;
  child.kill = (signal = "SIGTERM") => {
    child.killCount += 1;
    child.signalCode = signal;
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("close", 0, signal);
    }, closeDelayMs);
    return true;
  };
  return child;
};

const withNativeClaudePath = async (operation) => {
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = process.execPath;
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_BIN;
    } else {
      process.env.CLAUDE_BIN = previous;
    }
  }
};

describe("sanitizeDiagnostic", () => {
  test("should redact an Anthropic API key assignment", () => {
    assert.equal(
      sanitizeDiagnostic("ANTHROPIC_API_KEY=sk-ant-api03-secret"),
      "ANTHROPIC_API_KEY=[REDACTED]",
    );
  });

  test("should redact credentials embedded in a proxy URL", () => {
    assert.equal(
      sanitizeDiagnostic(
        "HTTPS_PROXY=https://proxy-user:proxy-password@proxy.example",
      ),
      "HTTPS_PROXY=https://[REDACTED]@proxy.example",
    );
  });

  test("should redact an Authorization Bearer credential", () => {
    assert.equal(
      sanitizeDiagnostic("Authorization: Bearer sk-secret-123"),
      "Authorization=[REDACTED]",
    );
  });

  test("should redact Basic and Digest authorization values", () => {
    assert.deepEqual(
      [
        "Authorization: Basic dXNlcjpwYXNz",
        "Proxy-Authorization: Basic dXNlcjpwYXNz",
        "Authorization: Digest username=user response=secret",
      ].map(sanitizeDiagnostic),
      [
        "Authorization=[REDACTED]",
        "Proxy-Authorization=[REDACTED]",
        "Authorization=[REDACTED]",
      ],
    );
  });

  test("should redact an x-api-key credential", () => {
    assert.equal(
      sanitizeDiagnostic("x-api-key: sk-ant-api03-secret"),
      "x-api-key=[REDACTED]",
    );
  });

  test("should redact exact and quoted secret names", () => {
    assert.deepEqual(
      [
        "PASSWORD=p4ssw0rd",
        "TOKEN=token-value",
        "SECRET=secret-value",
        "CREDENTIAL=credential-value",
        '"token": "json-secret"',
      ].map(sanitizeDiagnostic),
      [
        "PASSWORD=[REDACTED]",
        "TOKEN=[REDACTED]",
        "SECRET=[REDACTED]",
        "CREDENTIAL=[REDACTED]",
        '"token"=[REDACTED]',
      ],
    );
  });

  test("should redact proxy credentials with an empty username", () => {
    assert.equal(
      sanitizeDiagnostic(
        "HTTPS_PROXY=https://:proxy-password@proxy.example",
      ),
      "HTTPS_PROXY=https://[REDACTED]@proxy.example",
    );
  });
});

describe("createBatchToolResultMatcher", () => {
  test("should stop a batch on the reported Claude session limit", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);

    assert.deepEqual(matcher.accept(sessionLimitEvent), {
      ok: false,
      error: "CLAUDE_SESSION_LIMIT",
      detail: sessionLimitDetail,
    });
  });

  test("should return exact batch results in request order", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(
      batchToolUseEvent([batchToolUse("one.html", "tool-one")]),
    );
    matcher.accept(batchToolResultEvent("one.html", "tool-one"));
    matcher.accept(
      batchToolUseEvent([batchToolUse("two.html", "tool-two")]),
    );

    assert.deepEqual(
      matcher.accept(batchToolResultEvent("two.html", "tool-two")),
      {
        ok: true,
        data: {
          projectId: args.projectId,
          results: [
            {
              method: "get_file",
              projectId: args.projectId,
              path: "one.html",
              content: "one.html",
            },
            {
              method: "get_file",
              projectId: args.projectId,
              path: "two.html",
              content: "two.html",
            },
          ],
        },
      },
    );
  });

  test("should reject an unexpected batch path", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);

    assert.equal(
      matcher.accept(
        batchToolUseEvent([batchToolUse("other.html", "tool-other")]),
      ).error,
      "UNEXPECTED_TOOL_CALL",
    );
  });

  test("should reject a duplicate batch path call", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(batchToolUseEvent([batchToolUse("one.html", "tool-one")]));
    matcher.accept(batchToolResultEvent("one.html", "tool-one"));

    assert.equal(
      matcher.accept(
        batchToolUseEvent([batchToolUse("one.html", "tool-one-again")]),
      ).error,
      "UNEXPECTED_TOOL_CALL",
    );
  });

  test("should reject a duplicate batch tool ID", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(
      batchToolUseEvent([batchToolUse("one.html", "tool-reused")]),
    );
    matcher.accept(batchToolResultEvent("one.html", "tool-reused"));

    assert.equal(
      matcher.accept(
        batchToolUseEvent([batchToolUse("two.html", "tool-reused")]),
      ).error,
      "DUPLICATE_TOOL_ID",
    );
  });

  test("should reject an uncorrelated batch result", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);

    assert.equal(
      matcher.accept(batchToolResultEvent("one.html", "unknown-tool")).error,
      "UNEXPECTED_TOOL_RESULT",
    );
  });

  test("should reject multiple batch results in one stream event", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(
      batchToolUseEvent([batchToolUse("one.html", "tool-one")]),
    );
    const event = batchToolResultEvent("one.html", "tool-one");
    event.message.content.push({
      type: "tool_result",
      tool_use_id: "extra-tool",
      content: "extra",
    });

    assert.equal(matcher.accept(event).error, "UNEXPECTED_TOOL_RESULT");
  });

  test("should reject a duplicate batch result", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(batchToolUseEvent([batchToolUse("one.html", "tool-one")]));
    matcher.accept(batchToolResultEvent("one.html", "tool-one"));

    assert.equal(
      matcher.accept(batchToolResultEvent("one.html", "tool-one")).error,
      "DUPLICATE_TOOL_RESULT",
    );
  });

  test("should reject a missing raw batch result", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(
      batchToolUseEvent([batchToolUse("one.html", "tool-one")]),
    );
    const event = batchToolResultEvent("one.html", "tool-one");
    delete event.tool_use_result;

    assert.equal(matcher.accept(event).error, "BAD_RESULT");
  });

  test("should reject a conflicting raw batch project", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(
      batchToolUseEvent([batchToolUse("one.html", "tool-one")]),
    );
    const event = batchToolResultEvent("one.html", "tool-one");
    event.tool_use_result.projectId = "other-project";

    assert.equal(matcher.accept(event).error, "BAD_RESULT");
  });

  test("should classify a batch tool consent failure", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);
    matcher.accept(
      batchToolUseEvent([batchToolUse("one.html", "tool-one")]),
    );

    assert.equal(
      matcher.accept(
        batchToolResultEvent("one.html", "tool-one", {
          is_error: true,
          content: "Design consent required",
        }),
      ).error,
      "NEEDS_DESIGN_CONSENT",
    );
  });

  test("should reject batch calls before DesignSync initialization", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);

    assert.equal(
      matcher.accept(
        batchToolUseEvent([batchToolUse("one.html", "tool-one")]),
      ).error,
      "MISSING_INIT",
    );
  });

  test("should reject parallel batch tool calls", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);

    assert.equal(
      matcher.accept(
        batchToolUseEvent([
          batchToolUse("one.html", "tool-one"),
          batchToolUse("two.html", "tool-two"),
        ]),
      ).error,
      "UNEXPECTED_TOOL_CALL",
    );
  });

  test("should reject an out-of-order batch tool call", () => {
    const matcher = createBatchToolResultMatcher(args.projectId, batchPaths);
    matcher.accept(initEvent);

    assert.equal(
      matcher.accept(
        batchToolUseEvent([batchToolUse("two.html", "tool-two")]),
      ).error,
      "UNEXPECTED_TOOL_CALL",
    );
  });
});

test("should accept a correlated raw DesignSync result", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());
  const raw = {
    method,
    path: args.path,
    content: "<main />",
    truncated: false,
  };

  assert.deepEqual(matcher.accept(toolResultEvent(raw)), {
    ok: true,
    data: raw,
  });
});

test("should preserve the reported Claude session limit message", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);

  assert.deepEqual(matcher.accept(sessionLimitEvent), {
    ok: false,
    error: "CLAUDE_SESSION_LIMIT",
    detail: sessionLimitDetail,
  });
});

test("should reject an error result even when its subtype is success", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);

  assert.deepEqual(
    matcher.accept({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: sessionLimitMessage,
    }),
    {
      ok: false,
      error: "CLAUDE_SESSION_LIMIT",
      detail: sessionLimitDetail,
    },
  );
});

test("should reject an unavailable DesignSync tool", () => {
  const matcher = createToolResultMatcher(method, args);

  assert.equal(
    matcher.accept({ ...initEvent, tools: [] }).error,
    "DESIGNSYNC_UNAVAILABLE",
  );
});

test("should reject an unexpected DesignSync method before accepting output", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);

  assert.equal(
    matcher.accept(toolUseEvent({ method: "write_files", ...args })).error,
    "UNEXPECTED_TOOL_CALL",
  );
});

test("should reject deeply nested unexpected input without throwing", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  let nestedInput = {};
  for (let depth = 0; depth < 20000; depth += 1) {
    nestedInput = { nested: nestedInput };
  }

  const result = matcher.accept(
    toolUseEvent({ method, projectId: args.projectId, path: nestedInput }),
  );

  assert.equal(result.error, "UNEXPECTED_TOOL_CALL");
});

test("should reject an unexpected DesignSync path", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());

  assert.equal(
    matcher.accept(
      toolResultEvent({ method, path: "Other.dc.html", content: "x" }),
    ).error,
    "BAD_RESULT",
  );
});

test("should classify design consent separately from login", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());

  assert.equal(
    matcher.accept(
      toolResultEvent(null, {
        is_error: true,
        content: "Design consent required",
      }),
    ).error,
    "NEEDS_DESIGN_CONSENT",
  );
});

test("should classify a missing design login", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());

  assert.equal(
    matcher.accept(
      toolResultEvent(null, {
        is_error: true,
        content: "OAuth login required",
      }),
    ).error,
    "NEEDS_DESIGN_LOGIN",
  );
});

test("should reject multiple DesignSync calls", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());

  assert.equal(
    matcher.accept({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_other",
            name: "DesignSync",
            input: { method, ...args },
          },
        ],
      },
    }).error,
    "MULTIPLE_TOOL_CALLS",
  );
});

test("should reject a non-read DesignSync method before spawning Claude", async () => {
  const result = await delegate("write_files", { projectId: "project-1" });

  assert.equal(result.error, "METHOD_NOT_ALLOWED");
});

test("should reject a tool call before the DesignSync init advertisement", () => {
  const matcher = createToolResultMatcher(method, args);

  assert.equal(matcher.accept(toolUseEvent()).error, "MISSING_INIT");
});

test("should reject extra tool results in one stream event", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());
  const result = toolResultEvent({ method, path: args.path, content: "x" });
  result.message.content.push({
    type: "tool_result",
    tool_use_id: "toolu_unexpected",
    content: "unexpected",
  });

  assert.equal(matcher.accept(result).error, "UNEXPECTED_TOOL_RESULT");
});

test("should reject a conflicting raw project identifier", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());

  assert.equal(
    matcher.accept(
      toolResultEvent({
        method,
        projectId: "other-project",
        path: args.path,
        content: "x",
      }),
    ).error,
    "BAD_RESULT",
  );
});

test("should reject stream events after accepting a result", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());
  matcher.accept(toolResultEvent({ method, path: args.path, content: "x" }));

  assert.equal(
    matcher.accept({ type: "assistant" }).error,
    "RESULT_ALREADY_RECEIVED",
  );
});

test("should honor cancellation before spawning Claude", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await delegate(method, args, { signal: controller.signal });

  assert.equal(result.error, "CANCELLED");
});

test("should reject a repeated DesignSync call that reuses its tool ID", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  matcher.accept(toolUseEvent());

  assert.equal(matcher.accept(toolUseEvent()).error, "MULTIPLE_TOOL_CALLS");
});

test("should reject a DesignSync call without a string tool ID", () => {
  const matcher = createToolResultMatcher(method, args);
  matcher.accept(initEvent);
  const event = toolUseEvent();
  event.message.content[0].id = 7;

  assert.equal(matcher.accept(event).error, "BAD_TOOL_ID");
});

test("should reject invalid batch arguments before spawning Claude", async () => {
  const results = await Promise.all([
    delegateBatch("project-1", []),
    delegateBatch("project-1", ["one.html", "./one.html"]),
    delegateBatch("bad/project", ["one.html"]),
  ]);

  assert.deepEqual(
    results.map((result) => result.error),
    ["BAD_PATHS", "BAD_PATHS", "BAD_PROJECT_ID"],
  );
});

test("should honor batch cancellation before spawning Claude", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await delegateBatch("project-1", ["one.html"], {
    signal: controller.signal,
  });

  assert.equal(result.error, "CANCELLED");
});

test("should reject model values that could be parsed as CLI options", () => {
  const moduleUrl = new URL(
    "../../plugins/claude-design-bridge/server/claude-delegate.mjs",
    import.meta.url,
  ).href;
  const script = `import { delegate } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await delegate("list_projects")));`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DESIGN_BRIDGE_MODEL: "--dangerously-skip-permissions",
      },
    },
  );

  assert.deepEqual(
    {
      status: child.status,
      stderr: child.stderr,
      error: JSON.parse(child.stdout).error,
    },
    { status: 0, stderr: "", error: "BAD_DELEGATE_CONFIG" },
  );
});

test("should run the isolated CLI with every safety flag", async () => {
  const child = createFakeChild();
  let observed;
  const metrics = {};
  const spawnProcess = (executable, cliArgs, spawnOptions) => {
    observed = { executable, cliArgs, spawnOptions };
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify(initEvent)}\n`);
      child.stdout.write(`${JSON.stringify(toolUseEvent())}\n`);
      child.stdout.write(
        `${JSON.stringify(
          toolResultEvent({
            method,
            projectId: args.projectId,
            path: args.path,
            content: "complete",
          }),
        )}\n`,
      );
    });
    return child;
  };

  const result = await withNativeClaudePath(() =>
    delegate(method, args, { metrics, spawnProcess }),
  );

  assert.deepEqual(
    {
      result,
      shell: observed.spawnOptions.shell,
      windowsHide: observed.spawnOptions.windowsHide,
      flags: [
        "--tools",
        "DesignSync",
        "--permission-mode",
        "dontAsk",
        "--safe-mode",
        "--no-session-persistence",
      ].every((value) => observed.cliArgs.includes(value)),
      killCount: child.killCount,
      streamMeasured: metrics.streamBytes > 0,
      durationMeasured: Number.isFinite(metrics.durationMs),
    },
    {
      result: {
        ok: true,
        data: {
          method,
          projectId: args.projectId,
          path: args.path,
          content: "complete",
        },
      },
      shell: false,
      windowsHide: true,
      flags: true,
      killCount: 1,
      streamMeasured: true,
      durationMeasured: true,
    },
  );
});

test("should hold the delegate slot and temp directory until child close", async () => {
  const child = createFakeChild({ closeDelayMs: 50 });
  const controller = new AbortController();
  let workingDirectory;
  let resolved = false;
  const spawnProcess = (_executable, _cliArgs, spawnOptions) => {
    workingDirectory = spawnOptions.cwd;
    return child;
  };

  const operation = withNativeClaudePath(() =>
    delegate(method, args, {
      signal: controller.signal,
      spawnProcess,
    }),
  ).then((result) => {
    resolved = true;
    return result;
  });
  setImmediate(() => controller.abort());
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resolvedBeforeClose = resolved;
  const directoryBeforeClose = existsSync(workingDirectory);
  const result = await operation;

  assert.deepEqual(
    {
      error: result.error,
      resolvedBeforeClose,
      directoryBeforeClose,
      directoryAfterClose: existsSync(workingDirectory),
      killCount: child.killCount,
    },
    {
      error: "CANCELLED",
      resolvedBeforeClose: false,
      directoryBeforeClose: true,
      directoryAfterClose: false,
      killCount: 1,
    },
  );
});

test("should remove a cancelled delegate from the bounded wait queue", async () => {
  const activeControllers = Array.from(
    { length: 4 },
    () => new AbortController(),
  );
  const queuedController = new AbortController();
  const children = activeControllers.map(() => createFakeChild());
  let spawnCount = 0;
  const spawnProcess = () => {
    const child = children[spawnCount];
    spawnCount += 1;
    return child;
  };

  const result = await withNativeClaudePath(async () => {
    const activeOperations = activeControllers.map((controller) =>
      delegate(method, args, {
        signal: controller.signal,
        spawnProcess,
      }),
    );
    for (
      let attempt = 0;
      spawnCount < activeControllers.length && attempt < 100;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (spawnCount !== activeControllers.length) {
      throw new Error("Active delegates did not start before the queue test");
    }
    const queuedOperation = delegate(method, args, {
      signal: queuedController.signal,
      spawnProcess,
    });
    queuedController.abort();
    const queuedResult = await queuedOperation;
    for (const controller of activeControllers) {
      controller.abort();
    }
    const activeResults = await Promise.all(activeOperations);
    return { activeResults, queuedResult };
  });

  assert.deepEqual(
    {
      activeErrors: result.activeResults.map((value) => value.error),
      queuedError: result.queuedResult.error,
      spawnCount,
      killCounts: children.map((child) => child.killCount),
    },
    {
      activeErrors: ["CANCELLED", "CANCELLED", "CANCELLED", "CANCELLED"],
      queuedError: "CANCELLED",
      spawnCount: 4,
      killCounts: [1, 1, 1, 1],
    },
  );
});
