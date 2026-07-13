import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  createToolResultMatcher,
  delegate,
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
