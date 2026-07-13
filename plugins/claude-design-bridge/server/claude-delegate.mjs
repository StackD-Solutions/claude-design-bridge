// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isValidProjectId, normalizeDesignPath } from "./design-validation.mjs";

const DESIGN_TOOL = "DesignSync";
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

const classifyToolError = (value) => {
  const message = sanitizeDiagnostic(value);
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
        if (toolUseId && toolUseId !== toolUse.id) {
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

    if (event?.type === "result" && event?.subtype !== "success") {
      const classified = classifyToolError(
        event.result || event.subtype || "Claude Code reported an error",
      );
      return classified.error === "DESIGNSYNC_ERROR"
        ? failure("CLAUDE_ERROR", classified.detail)
        : classified;
    }
    return null;
  };

  return {
    accept,
    state: () => ({ completed, initialized, toolAdvertised, toolUseId }),
  };
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

/**
 * Run one isolated Claude Code turn and return its correlated raw DesignSync result.
 *
 * @param {string} method Read-only DesignSync method.
 * @param {Record<string, unknown>} args Method arguments.
 * @returns {Promise<object>} A success or structured failure result.
 */
export const delegate = async (method, args = {}, options = {}) => {
  const canonical = canonicalArgs(method, args);
  if (!canonical.ok) {
    return canonical;
  }

  const fixture = fixtureResult(method, canonical.data);
  if (fixture) {
    return fixture;
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
    buildPrompt(method, canonical.data),
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
      const matcher = createToolResultMatcher(method, canonical.data);
      let child;
      let stdoutBuffer = "";
      let streamBytes = 0;
      let stderr = "";
      let settled = false;
      let timer;

      const cleanup = () => {
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

      const finish = (result, terminate = true) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (
          terminate &&
          child &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          child.kill();
        }
        resolve(result);
      };

      const abort = () => {
        finish(
          failure("CANCELLED", "The MCP client cancelled this DesignSync read"),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        cleanup();
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
        child = spawn(executable, cliArgs, {
          shell: false,
          cwd: workingDirectory,
          env: childEnvironment(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        cleanup();
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
        if (settled) {
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
        while (newlineIndex >= 0 && !settled) {
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
        cleanup();
        finish(
          failure(
            "DELEGATE_SPAWN_FAILED",
            `${sanitizeDiagnostic(error?.message || error)} (binary: ${executable})`,
          ),
          false,
        );
      });

      child.on("close", (code, signal) => {
        if (!settled && stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
        }
        if (!settled) {
          const state = matcher.state();
          const diagnostic = sanitizeDiagnostic(stderr);
          const classified = classifyToolError(diagnostic);
          if (diagnostic && classified.error !== "DESIGNSYNC_ERROR") {
            finish(classified, false);
            cleanup();
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
                toolUseObserved: Boolean(state.toolUseId),
              },
            ),
            false,
          );
        }
        cleanup();
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
