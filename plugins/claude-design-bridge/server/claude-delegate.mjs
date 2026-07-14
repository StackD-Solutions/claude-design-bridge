// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isValidProjectId, normalizeDesignPath } from "./design-validation.mjs";

const DESIGN_TOOL = "DesignSync";
const MAX_BATCH_FILES = 12;
const READ_METHODS = new Set([
  "list_projects",
  "get_project",
  "list_files",
  "get_file",
]);

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const TIMEOUT_MS = positiveNumber(process.env.DESIGN_BRIDGE_TIMEOUT_MS, 120000);
const MAX_EVENT_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_EVENT_BYTES,
  4 * 1024 * 1024,
);
const MAX_STREAM_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_STREAM_BYTES,
  16 * 1024 * 1024,
);
const MAX_STDERR_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_STDERR_BYTES,
  64 * 1024,
);
const MAX_BUDGET_USD = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_BUDGET_USD,
  0.25,
);
const DEFAULT_MODEL = process.env.DESIGN_BRIDGE_MODEL || "haiku";
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONCURRENT_DELEGATES = Math.min(
  8,
  Math.max(
    1,
    Math.floor(
      positiveNumber(process.env.DESIGN_BRIDGE_MAX_CONCURRENT_DELEGATES, 4),
    ),
  ),
);
const MAX_QUEUED_DELEGATES = 32;

let activeDelegates = 0;
const delegateWaiters = [];

const acquireDelegateSlot = (signal) => {
  if (signal?.aborted) {
    return Promise.resolve("cancelled");
  }
  if (activeDelegates < MAX_CONCURRENT_DELEGATES) {
    activeDelegates += 1;
    return Promise.resolve("acquired");
  }
  if (delegateWaiters.length >= MAX_QUEUED_DELEGATES) {
    return Promise.resolve("busy");
  }
  return new Promise((resolve) => {
    const waiter = { resolve, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = delegateWaiters.indexOf(waiter);
      if (index >= 0) {
        delegateWaiters.splice(index, 1);
      }
      resolve("cancelled");
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    delegateWaiters.push(waiter);
  });
};

const releaseDelegateSlot = () => {
  const next = delegateWaiters.shift();
  if (next) {
    next.signal?.removeEventListener("abort", next.onAbort);
    next.resolve("acquired");
    return;
  }
  activeDelegates = Math.max(0, activeDelegates - 1);
};

const failure = (error, detail, data) => ({
  ok: false,
  error,
  detail,
  ...(data ? { data } : {}),
});

/**
 * Remove credentials and terminal formatting from child-process diagnostics.
 *
 * @param {unknown} value Diagnostic text from Claude Code or the operating system.
 * @returns {string} A bounded, single-line diagnostic safe to return through MCP.
 */
export const sanitizeDiagnostic = (value) =>
  String(value ?? "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /\b((?:proxy-)?authorization)\b\s*[:=]\s*[^\r\n]*/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b(x[-_ ]?api[-_ ]?key|oauth|refresh[_ -]?token|access[_ -]?token)\b\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /(?<![A-Za-z0-9_-])(["']?)((?:(?:[A-Za-z0-9]+)[_-])*(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:[_-][A-Za-z0-9]+)*)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1$2$1=[REDACTED]",
    )
    .replace(
      /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s:]*:[^/@\s]*@/g,
      "$1[REDACTED]@",
    )
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 600);

const claudeSessionLimitFailure = (value) => {
  const message = sanitizeDiagnostic(value);
  const detail = /^Claude(?: Code)?:/i.test(message)
    ? message
    : `Claude Code: ${message || "Usage is temporarily limited"}`;
  return failure("CLAUDE_SESSION_LIMIT", detail);
};

const classifyToolError = (value) => {
  const message = sanitizeDiagnostic(value);
  if (/session limit|usage limit|rate limit/i.test(message)) {
    return claudeSessionLimitFailure(message);
  }
  if (/consent|agent_design_projects/i.test(message)) {
    return failure("NEEDS_DESIGN_CONSENT", message);
  }
  if (
    /log ?in|login|oauth|authenticat|authori[sz]ation|credential|token expired/i.test(
      message,
    )
  ) {
    return failure("NEEDS_DESIGN_LOGIN", message);
  }
  if (/permission|denied|not allowed/i.test(message)) {
    return failure("DESIGNSYNC_PERMISSION_DENIED", message);
  }
  return failure("DESIGNSYNC_ERROR", message || "DesignSync returned an error");
};

const assistantError = (event) => {
  if (event?.type !== "assistant" || event.message?.error !== "rate_limit") {
    return null;
  }
  const content = Array.isArray(event.message.content)
    ? event.message.content
    : [];
  const message = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
  return claudeSessionLimitFailure(message);
};

const resultEventError = (event) => {
  if (
    event?.type !== "result" ||
    (event.subtype === "success" && event.is_error !== true)
  ) {
    return null;
  }
  const classified = classifyToolError(
    event.result || event.subtype || "Claude Code reported an error",
  );
  return classified.error === "DESIGNSYNC_ERROR"
    ? failure("CLAUDE_ERROR", classified.detail)
    : classified;
};

const canonicalArgs = (method, args) => {
  if (!READ_METHODS.has(method)) {
    return failure(
      "METHOD_NOT_ALLOWED",
      `DesignSync method is not read-only: ${String(method)}`,
    );
  }
  if (method === "list_projects") {
    return { ok: true, data: {} };
  }
  const projectId = args?.projectId;
  if (!isValidProjectId(projectId)) {
    return failure(
      "BAD_PROJECT_ID",
      "projectId must contain 1-128 letters, numbers, underscores, or hyphens",
    );
  }
  if (method === "get_file") {
    const filePath = normalizeDesignPath(args?.path);
    if (!filePath) {
      return failure(
        "BAD_PATH",
        "path must be a normalized project-relative path",
      );
    }
    return { ok: true, data: { projectId, path: filePath } };
  }
  return { ok: true, data: { projectId } };
};

const inputsMatch = (actual, expected) => {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) => Object.hasOwn(actual, key) && actual[key] === expected[key],
    )
  );
};

const buildPrompt = (method, args) => {
  const input = JSON.stringify({ method, ...args });
  return [
    `Call the DesignSync tool exactly once with this exact JSON input: ${input}.`,
    "Do not call any other tool or DesignSync method.",
    "Do not transform, summarize, or reproduce the tool result.",
    "After the tool call, reply only DONE.",
  ].join(" ");
};

const nativeClaudeCandidates = () => {
  const candidates = [];
  const configured = process.env.CLAUDE_BIN;
  if (configured) {
    candidates.push(configured);
  }
  for (const directory of String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    candidates.push(path.join(directory, "claude.exe"));
    candidates.push(
      path.join(
        directory,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
    );
  }
  if (process.env.APPDATA) {
    candidates.push(
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
    );
  }
  return [...new Set(candidates)];
};

const resolveClaudeExecutable = () => {
  if (process.platform !== "win32") {
    return process.env.CLAUDE_BIN || "claude";
  }
  return (
    nativeClaudeCandidates().find(
      (candidate) => path.isAbsolute(candidate) && existsSync(candidate),
    ) ?? null
  );
};

const childEnvironment = () => {
  const names = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ];
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      (name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_")) &&
      value !== undefined
    ) {
      env[name] = value;
    }
  }
  return env;
};

/**
 * Create a stateful matcher for one expected read-only DesignSync call.
 *
 * @param {string} method Expected allowlisted DesignSync method.
 * @param {Record<string, unknown>} args Canonical method arguments.
 * @returns {{accept: (event: unknown) => object | null, state: () => object}} Stream matcher.
 */
export const createToolResultMatcher = (method, args) => {
  const expectedInput = { method, ...args };
  let toolUseId = null;
  let initialized = false;
  let toolAdvertised = false;
  let completed = false;

  const accept = (event) => {
    if (completed) {
      return failure(
        "RESULT_ALREADY_RECEIVED",
        "A DesignSync result was already accepted",
      );
    }
    if (event?.type === "system" && event?.subtype === "init") {
      initialized = true;
      toolAdvertised =
        Array.isArray(event.tools) && event.tools.includes(DESIGN_TOOL);
      if (!toolAdvertised) {
        return failure(
          "DESIGNSYNC_UNAVAILABLE",
          "Claude Code did not advertise the DesignSync tool",
        );
      }
      return null;
    }

    if (event?.type === "assistant") {
      const error = assistantError(event);
      if (error) {
        return error;
      }
      const toolUses = Array.isArray(event.message?.content)
        ? event.message.content.filter((block) => block?.type === "tool_use")
        : [];
      if (toolUses.length && (!initialized || !toolAdvertised)) {
        return failure(
          "MISSING_INIT",
          "Claude attempted a tool call before advertising DesignSync",
        );
      }
      for (const toolUse of toolUses) {
        if (
          toolUse.name !== DESIGN_TOOL ||
          !inputsMatch(toolUse.input, expectedInput)
        ) {
          return failure(
            "UNEXPECTED_TOOL_CALL",
            `Claude attempted ${String(toolUse.name)} with unexpected input`,
          );
        }
        if (typeof toolUse.id !== "string" || !toolUse.id) {
          return failure(
            "BAD_TOOL_ID",
            "Claude emitted a DesignSync tool call without a usable ID",
          );
        }
        if (toolUseId !== null) {
          return failure(
            "MULTIPLE_TOOL_CALLS",
            "Claude attempted more than one DesignSync call",
          );
        }
        toolUseId = toolUse.id;
      }
      return null;
    }

    if (event?.type === "user" && toolUseId) {
      const allResultBlocks = Array.isArray(event.message?.content)
        ? event.message.content.filter((block) => block?.type === "tool_result")
        : [];
      const resultBlocks = allResultBlocks.filter(
        (block) => block.tool_use_id === toolUseId,
      );
      if (!allResultBlocks.length) {
        return null;
      }
      if (allResultBlocks.length !== 1 || resultBlocks.length !== 1) {
        return failure(
          "UNEXPECTED_TOOL_RESULT",
          "Claude emitted an uncorrelated or extra tool result",
        );
      }
      const resultBlock = resultBlocks[0];
      if (resultBlock.is_error) {
        return classifyToolError(resultBlock.content);
      }
      const rawResult = event.tool_use_result;
      if (
        !rawResult ||
        typeof rawResult !== "object" ||
        Array.isArray(rawResult)
      ) {
        return failure(
          "BAD_RESULT",
          "DesignSync did not emit a structured raw tool result",
        );
      }
      if (rawResult.method !== method) {
        return failure(
          "BAD_RESULT",
          `DesignSync returned method ${String(rawResult.method)} instead of ${method}`,
        );
      }
      if (method === "get_file" && rawResult.path !== args.path) {
        return failure(
          "BAD_RESULT",
          `DesignSync returned path ${String(rawResult.path)} instead of ${args.path}`,
        );
      }
      if (
        rawResult.projectId !== undefined &&
        rawResult.projectId !== args.projectId
      ) {
        return failure(
          "BAD_RESULT",
          `DesignSync returned projectId ${String(rawResult.projectId)} instead of ${args.projectId}`,
        );
      }
      if ("error" in rawResult) {
        return classifyToolError(rawResult.error);
      }
      completed = true;
      return { ok: true, data: rawResult };
    }

    return resultEventError(event);
  };

  return {
    accept,
    state: () => ({ completed, initialized, toolAdvertised, toolUseId }),
  };
};

const buildBatchPrompt = (projectId, paths) => {
  const inputs = paths.map((filePath) => ({
    method: "get_file",
    projectId,
    path: filePath,
  }));
  return [
    `Call the DesignSync tool exactly ${inputs.length} times, sequentially and in this order, using these exact JSON inputs: ${JSON.stringify(inputs)}.`,
    "Wait for each tool result before making the next call.",
    "Do not call any other tool, method, project, or path.",
    "Do not transform, summarize, or reproduce any tool result.",
    "After the final tool result, reply only DONE.",
  ].join(" ");
};

/**
 * Create a stateful matcher for an exact batch of read-only get_file calls.
 *
 * Each requested path must be announced once with a unique tool ID and must produce one
 * separately correlated raw result. Calls and results must alternate in request order.
 *
 * @param {string} projectId Expected Claude Design project identifier.
 * @param {Array<string>} requestedPaths Exact normalized project paths.
 * @returns {{accept: (event: unknown) => object | null, state: () => object}} Stream matcher.
 */
export const createBatchToolResultMatcher = (projectId, requestedPaths) => {
  const expectedPaths = new Set(requestedPaths);
  const toolUseById = new Map();
  const announcedPaths = new Set();
  const resultsByPath = new Map();
  let initialized = false;
  let toolAdvertised = false;
  let completed = false;

  const accept = (event) => {
    if (completed) {
      return failure(
        "RESULT_ALREADY_RECEIVED",
        "All DesignSync batch results were already accepted",
      );
    }
    if (event?.type === "system" && event?.subtype === "init") {
      initialized = true;
      toolAdvertised =
        Array.isArray(event.tools) && event.tools.includes(DESIGN_TOOL);
      return toolAdvertised
        ? null
        : failure(
            "DESIGNSYNC_UNAVAILABLE",
            "Claude Code did not advertise the DesignSync tool",
          );
    }

    if (event?.type === "assistant") {
      const error = assistantError(event);
      if (error) {
        return error;
      }
      const toolUses = Array.isArray(event.message?.content)
        ? event.message.content.filter((block) => block?.type === "tool_use")
        : [];
      if (toolUses.length && (!initialized || !toolAdvertised)) {
        return failure(
          "MISSING_INIT",
          "Claude attempted a batch tool call before advertising DesignSync",
        );
      }
      if (toolUses.length > 1) {
        return failure(
          "UNEXPECTED_TOOL_CALL",
          "Claude attempted multiple batch tool calls without waiting for each result",
        );
      }
      for (const toolUse of toolUses) {
        const input = toolUse?.input;
        const filePath = input?.path;
        const expectedInput = {
          method: "get_file",
          projectId,
          path: filePath,
        };
        if (
          toolUse?.name !== DESIGN_TOOL ||
          !expectedPaths.has(filePath) ||
          !inputsMatch(input, expectedInput)
        ) {
          return failure(
            "UNEXPECTED_TOOL_CALL",
            `Claude attempted ${String(toolUse?.name)} with unexpected batch input`,
          );
        }
        if (toolUseById.size !== resultsByPath.size) {
          return failure(
            "UNEXPECTED_TOOL_CALL",
            "Claude attempted the next batch tool call before the prior result",
          );
        }
        if (filePath !== requestedPaths[announcedPaths.size]) {
          return failure(
            "UNEXPECTED_TOOL_CALL",
            `Claude requested ${String(filePath)} out of batch order`,
          );
        }
        if (typeof toolUse.id !== "string" || !toolUse.id) {
          return failure(
            "BAD_TOOL_ID",
            "Claude emitted a batch tool call without a usable ID",
          );
        }
        if (toolUseById.has(toolUse.id)) {
          return failure(
            "DUPLICATE_TOOL_ID",
            `Claude reused DesignSync tool ID ${toolUse.id}`,
          );
        }
        if (announcedPaths.has(filePath)) {
          return failure(
            "DUPLICATE_TOOL_CALL",
            `Claude requested ${filePath} more than once`,
          );
        }
        toolUseById.set(toolUse.id, filePath);
        announcedPaths.add(filePath);
      }
      return null;
    }

    if (event?.type === "user") {
      const resultBlocks = Array.isArray(event.message?.content)
        ? event.message.content.filter((block) => block?.type === "tool_result")
        : [];
      if (!resultBlocks.length) {
        return null;
      }
      if (resultBlocks.length !== 1) {
        return failure(
          "UNEXPECTED_TOOL_RESULT",
          "A batch stream event contained more than one tool result",
        );
      }
      const resultBlock = resultBlocks[0];
      const filePath = toolUseById.get(resultBlock.tool_use_id);
      if (!filePath) {
        return failure(
          "UNEXPECTED_TOOL_RESULT",
          "Claude emitted an uncorrelated batch tool result",
        );
      }
      if (resultsByPath.has(filePath)) {
        return failure(
          "DUPLICATE_TOOL_RESULT",
          `Claude returned ${filePath} more than once`,
        );
      }
      if (resultBlock.is_error) {
        return classifyToolError(resultBlock.content);
      }
      const rawResult = event.tool_use_result;
      if (
        !rawResult ||
        typeof rawResult !== "object" ||
        Array.isArray(rawResult)
      ) {
        return failure(
          "BAD_RESULT",
          "DesignSync did not emit a structured raw batch result",
        );
      }
      if (
        rawResult.method !== "get_file" ||
        rawResult.path !== filePath ||
        (rawResult.projectId !== undefined &&
          rawResult.projectId !== projectId)
      ) {
        return failure(
          "BAD_RESULT",
          `DesignSync returned an unexpected identity for ${filePath}`,
        );
      }
      if ("error" in rawResult) {
        return classifyToolError(rawResult.error);
      }
      resultsByPath.set(filePath, rawResult);
      if (resultsByPath.size === requestedPaths.length) {
        completed = true;
        return {
          ok: true,
          data: {
            projectId,
            results: requestedPaths.map((pathValue) =>
              resultsByPath.get(pathValue),
            ),
          },
        };
      }
      return null;
    }

    return resultEventError(event);
  };

  return {
    accept,
    state: () => ({
      completed,
      initialized,
      toolAdvertised,
      toolUseCount: toolUseById.size,
      resultCount: resultsByPath.size,
    }),
  };
};

const canonicalBatchArgs = (projectId, paths) => {
  if (!isValidProjectId(projectId)) {
    return failure(
      "BAD_PROJECT_ID",
      "projectId must contain 1-128 letters, numbers, underscores, or hyphens",
    );
  }
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_BATCH_FILES) {
    return failure(
      "BAD_PATHS",
      `paths must contain 1-${MAX_BATCH_FILES} project-relative files`,
    );
  }
  const normalizedPaths = paths.map(normalizeDesignPath);
  if (normalizedPaths.some((filePath) => !filePath)) {
    return failure(
      "BAD_PATH",
      "Every batch path must be normalized and project-relative",
    );
  }
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    return failure("BAD_PATHS", "Batch paths must not contain duplicates");
  }
  return { ok: true, data: { projectId, paths: normalizedPaths } };
};

const fixtureResult = (method, args) => {
  const file = process.env.DESIGN_BRIDGE_TEST_FIXTURE;
  if (!file) {
    return null;
  }
  if (process.env.NODE_ENV !== "test") {
    return failure(
      "FIXTURE_DISABLED",
      "DESIGN_BRIDGE_TEST_FIXTURE is available only with NODE_ENV=test",
    );
  }
  try {
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    const entry = fixture[method];
    if (entry === undefined) {
      return failure("FIXTURE_MISS", `No fixture exists for ${method}`);
    }
    if (entry && typeof entry === "object" && "error" in entry) {
      return classifyToolError(entry.error);
    }
    const data = structuredClone(entry);
    if (method === "get_file" && data?.path === "REQUESTED") {
      data.path = args.path;
    }
    if (
      data?.method !== method ||
      (method === "get_file" && data.path !== args.path)
    ) {
      return failure(
        "FIXTURE_ERROR",
        `Fixture identity did not match ${method}`,
      );
    }
    return { ok: true, data };
  } catch (error) {
    return failure(
      "FIXTURE_ERROR",
      sanitizeDiagnostic(error?.message || error),
    );
  }
};

const runClaudeTurn = async (prompt, matcher, options = {}) => {
  if (
    options.spawnProcess !== undefined &&
    typeof options.spawnProcess !== "function"
  ) {
    return failure(
      "BAD_DELEGATE_OPTION",
      "spawnProcess must be a function when provided",
    );
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  if (!MODEL_NAME_PATTERN.test(DEFAULT_MODEL)) {
    return failure(
      "BAD_DELEGATE_CONFIG",
      "DESIGN_BRIDGE_MODEL must be a model name, not a command-line option",
    );
  }
  const executable = resolveClaudeExecutable();
  if (!executable) {
    return failure(
      "DELEGATE_SPAWN_FAILED",
      "Could not locate the native Claude Code executable; set CLAUDE_BIN to claude.exe",
    );
  }

  const cliArgs = [
    "-p",
    prompt,
    "--tools",
    DESIGN_TOOL,
    "--permission-mode",
    "dontAsk",
    "--safe-mode",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    DEFAULT_MODEL,
    "--max-budget-usd",
    String(MAX_BUDGET_USD),
  ];

  const slot = await acquireDelegateSlot(options.signal);
  if (slot === "cancelled") {
    return failure(
      "CANCELLED",
      "The MCP client cancelled this DesignSync read",
    );
  }
  if (slot === "busy") {
    return failure(
      "DELEGATE_BUSY",
      "Too many Claude Design reads are already queued",
    );
  }

  try {
    return await new Promise((resolve) => {
      let workingDirectory;
      try {
        workingDirectory = mkdtempSync(
          path.join(os.tmpdir(), "claude-design-bridge-"),
        );
      } catch (error) {
        resolve(
          failure(
            "TEMP_DIR_FAILED",
            sanitizeDiagnostic(error?.message || error),
          ),
        );
        return;
      }
      let child;
      let stdoutBuffer = "";
      let streamBytes = 0;
      let stderr = "";
      let outcome = null;
      let finalized = false;
      let cleanupCompleted = false;
      let timer;
      let terminationTimer;
      let terminationDeadlineTimer;
      const startedAtMs = Date.now();

      const cleanup = () => {
        if (cleanupCompleted) {
          return;
        }
        cleanupCompleted = true;
        try {
          rmSync(workingDirectory, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        } catch (error) {
          process.stderr.write(
            `[claude-design-bridge] temporary directory cleanup failed: ${sanitizeDiagnostic(error?.message || error)}\n`,
          );
        }
      };

      const finalize = (result) => {
        if (finalized) {
          return;
        }
        finalized = true;
        clearTimeout(timer);
        clearTimeout(terminationTimer);
        clearTimeout(terminationDeadlineTimer);
        options.signal?.removeEventListener("abort", abort);
        cleanup();
        if (options.metrics && typeof options.metrics === "object") {
          options.metrics.durationMs = Date.now() - startedAtMs;
          options.metrics.streamBytes = streamBytes;
        }
        resolve(result);
      };

      const finish = (result, terminate = true) => {
        if (outcome !== null || finalized) {
          return;
        }
        outcome = result;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        const childIsRunning =
          child && child.exitCode === null && child.signalCode === null;
        if (!terminate || !childIsRunning) {
          finalize(result);
          return;
        }
        try {
          child.kill();
        } catch (error) {
          process.stderr.write(
            `[claude-design-bridge] delegate termination failed: ${sanitizeDiagnostic(error?.message || error)}\n`,
          );
        }
        terminationTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGKILL");
            } catch (error) {
              process.stderr.write(
                `[claude-design-bridge] forced delegate termination failed: ${sanitizeDiagnostic(error?.message || error)}\n`,
              );
            }
          }
        }, 1000);
        terminationDeadlineTimer = setTimeout(() => {
          finalize(
            failure(
              "DELEGATE_TERMINATION_FAILED",
              "Claude did not exit after the bridge accepted or cancelled the operation",
            ),
          );
        }, 5000);
      };

      const abort = () => {
        finish(
          failure("CANCELLED", "The MCP client cancelled this DesignSync read"),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }

      const processLine = (line) => {
        if (!line.trim()) {
          return;
        }
        if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
          finish(
            failure(
              "STREAM_LIMIT",
              `Claude stream event exceeded ${MAX_EVENT_BYTES} bytes`,
            ),
          );
          return;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          finish(
            failure(
              "BAD_STREAM",
              `Claude emitted invalid stream JSON: ${sanitizeDiagnostic(error?.message || error)}`,
            ),
          );
          return;
        }
        let matched;
        try {
          matched = matcher.accept(event);
        } catch (error) {
          finish(
            failure(
              "BAD_STREAM",
              `Claude emitted an invalid stream event: ${sanitizeDiagnostic(error?.message || error)}`,
            ),
          );
          return;
        }
        if (matched) {
          finish(matched);
        }
      };

      try {
        child = spawnProcess(executable, cliArgs, {
          shell: false,
          cwd: workingDirectory,
          env: childEnvironment(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish(
          failure(
            "DELEGATE_SPAWN_FAILED",
            sanitizeDiagnostic(error?.message || error),
          ),
          false,
        );
        return;
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk) => {
        if (outcome !== null) {
          return;
        }
        streamBytes += Buffer.byteLength(chunk, "utf8");
        if (streamBytes > MAX_STREAM_BYTES) {
          finish(
            failure(
              "STREAM_LIMIT",
              `Claude stream exceeded ${MAX_STREAM_BYTES} bytes`,
            ),
          );
          return;
        }
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0 && outcome === null) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
      });

      child.on("error", (error) => {
        finish(
          failure(
            "DELEGATE_SPAWN_FAILED",
            sanitizeDiagnostic(error?.message || error),
          ),
        );
      });

      child.on("close", (code, signal) => {
        if (finalized) {
          return;
        }
        if (outcome === null && stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
        }
        if (outcome === null) {
          const state = matcher.state();
          const diagnostic = sanitizeDiagnostic(stderr);
          const classified = classifyToolError(diagnostic);
          if (diagnostic && classified.error !== "DESIGNSYNC_ERROR") {
            finish(classified, false);
            return;
          }
          finish(
            failure(
              code === 0 ? "NO_TOOL_RESULT" : "DELEGATE_FAILED",
              `Claude exited with code ${String(code)} signal ${String(signal)} without a validated DesignSync result${
                diagnostic ? `: ${diagnostic}` : ""
              }`,
              {
                toolAdvertised: state.toolAdvertised,
                toolUseObserved:
                  Boolean(state.toolUseId) || state.toolUseCount > 0,
                ...(Number.isInteger(state.resultCount)
                  ? { resultCount: state.resultCount }
                  : {}),
              },
            ),
            false,
          );
        }
        if (!finalized && outcome !== null) {
          finalize(outcome);
        }
      });

      timer = setTimeout(() => {
        finish(
          failure(
            "DELEGATE_TIMEOUT",
            `Claude did not return a validated result within ${TIMEOUT_MS}ms`,
          ),
        );
      }, TIMEOUT_MS);
    });
  } finally {
    releaseDelegateSlot();
  }
};

/**
 * Run one isolated Claude Code turn and return its correlated raw DesignSync result.
 *
 * @param {string} method Read-only DesignSync method.
 * @param {Record<string, unknown>} args Method arguments.
 * @param {object} [options] Cancellation and diagnostic options.
 * @returns {Promise<object>} A success or structured failure result.
 */
export const delegate = async (method, args = {}, options = {}) => {
  const canonical = canonicalArgs(method, args);
  if (!canonical.ok) {
    return canonical;
  }
  if (options.signal?.aborted) {
    return failure(
      "CANCELLED",
      "The MCP client cancelled this DesignSync read",
    );
  }
  const fixture = fixtureResult(method, canonical.data);
  if (fixture) {
    return fixture;
  }
  return runClaudeTurn(
    buildPrompt(method, canonical.data),
    createToolResultMatcher(method, canonical.data),
    options,
  );
};

/**
 * Run one experimental isolated Claude Code turn for an exact batch of get_file reads.
 *
 * This function is intentionally not connected to production pulls. Callers must use it
 * only for the live parity/performance gate and must treat every matcher failure as final.
 *
 * @param {string} projectId Claude Design project identifier.
 * @param {Array<string>} paths Exact project-relative paths.
 * @param {object} [options] Cancellation and diagnostic options.
 * @returns {Promise<object>} Ordered raw results or a structured failure.
 */
export const delegateBatch = async (projectId, paths, options = {}) => {
  const canonical = canonicalBatchArgs(projectId, paths);
  if (!canonical.ok) {
    return canonical;
  }
  if (options.signal?.aborted) {
    return failure(
      "CANCELLED",
      "The MCP client cancelled this DesignSync batch read",
    );
  }

  if (process.env.DESIGN_BRIDGE_TEST_FIXTURE) {
    const results = [];
    for (const filePath of canonical.data.paths) {
      const fixture = fixtureResult("get_file", {
        projectId: canonical.data.projectId,
        path: filePath,
      });
      if (!fixture?.ok) {
        return fixture;
      }
      results.push(fixture.data);
    }
    return {
      ok: true,
      data: { projectId: canonical.data.projectId, results },
    };
  }

  return runClaudeTurn(
    buildBatchPrompt(canonical.data.projectId, canonical.data.paths),
    createBatchToolResultMatcher(
      canonical.data.projectId,
      canonical.data.paths,
    ),
    options,
  );
};
