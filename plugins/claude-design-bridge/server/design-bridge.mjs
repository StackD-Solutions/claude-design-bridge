#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBrowserExport } from "./browser-export.mjs";
import { claudeCodeDesignSource } from "./design-source.mjs";
import { isValidProjectId, normalizeDesignPath } from "./design-validation.mjs";

export { normalizeDesignPath } from "./design-validation.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const PLUGIN_MANIFEST = JSON.parse(
  readFileSync(
    new URL("../.codex-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
);
const SERVER_INFO = {
  name: PLUGIN_MANIFEST.name,
  version: PLUGIN_MANIFEST.version,
};
const CODEX_SANDBOX_META = "codex/sandbox-state-meta";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const MANIFEST_NAME = ".claude-design.json";
const SNAPSHOT_LOCK_NAME = ".claude-design.lock";
const MAX_CACHE_METADATA_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PULL_FILES = 12;
const MAX_EXPORT_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_ENTRIES = 4096;
const MAX_STATUS_PATH_BYTES = 256 * 1024;
const MAX_ACTIVE_INBOUND_REQUESTS = 64;
const DESIGN_SOURCE = claudeCodeDesignSource;
const DESIGN_SOURCE_PROVENANCE = Object.freeze({
  id: DESIGN_SOURCE.id,
  transport: DESIGN_SOURCE.transport,
  readOnly: DESIGN_SOURCE.capabilities.write === false,
});

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const nonNegativeNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const MAX_STATUS_ENTRIES = Math.min(
  4096,
  Math.max(
    1,
    Math.floor(
      positiveNumber(process.env.DESIGN_BRIDGE_MAX_STATUS_ENTRIES, 1024),
    ),
  ),
);

const DATA_DIR =
  process.env.DESIGN_BRIDGE_DATA_DIR ||
  process.env.PLUGIN_DATA ||
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(os.homedir(), ".codex", "plugin-data", "claude-design-bridge");
const CACHE_DIR =
  process.env.DESIGN_BRIDGE_CACHE_DIR || path.join(DATA_DIR, "cache");
const CACHE_TTL_MS = nonNegativeNumber(
  process.env.DESIGN_BRIDGE_CACHE_TTL_MS,
  10 * 60 * 1000,
);
const CACHE_RETENTION_MS = positiveNumber(
  process.env.DESIGN_BRIDGE_CACHE_RETENTION_MS,
  7 * 24 * 60 * 60 * 1000,
);
const CACHE_MAX_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_CACHE_MAX_BYTES,
  512 * 1024 * 1024,
);
const CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.floor(positiveNumber(process.env.DESIGN_BRIDGE_CACHE_MAX_ENTRIES, 1024)),
);
const INLINE_MAX_BYTES = nonNegativeNumber(
  process.env.DESIGN_BRIDGE_INLINE_MAX_BYTES,
  64 * 1024,
);
const MAX_FILE_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_FILE_BYTES,
  2 * 1024 * 1024,
);
const MAX_PULL_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_PULL_BYTES,
  32 * 1024 * 1024,
);
const PULL_CONCURRENCY = Math.min(
  8,
  Math.max(
    1,
    Math.floor(positiveNumber(process.env.DESIGN_BRIDGE_PULL_CONCURRENCY, 3)),
  ),
);
const CLIENT_REQUEST_TIMEOUT_MS = positiveNumber(
  process.env.DESIGN_BRIDGE_CLIENT_REQUEST_TIMEOUT_MS,
  5000,
);
const MAX_INCOMING_MESSAGE_BYTES = positiveNumber(
  process.env.DESIGN_BRIDGE_MAX_INCOMING_MESSAGE_BYTES,
  1024 * 1024,
);
const CACHE_PRUNE_INTERVAL_MS = Math.max(
  1000,
  Math.min(CACHE_RETENTION_MS, 60 * 1000),
);
const CACHE_WRITE_PRUNE_DELAY_MS = Math.min(5000, CACHE_PRUNE_INTERVAL_MS);

const ok = (data) => ({ ok: true, data });
const failure = (error, detail, data) => ({
  ok: false,
  error,
  detail,
  ...(data ? { data } : {}),
});

const errorDetail = (error) => String(error?.message || error);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isCanonicalTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const validateProjectId = (projectId) => {
  if (!isValidProjectId(projectId)) {
    return failure(
      "BAD_PROJECT_ID",
      "projectId must contain 1-128 letters, numbers, underscores, or hyphens",
    );
  }
  return ok(projectId);
};

const cancellationFailure = (signal) =>
  signal?.aborted
    ? failure("CANCELLED", "The MCP client cancelled this design operation")
    : null;

/**
 * Resolve an exact Claude Design URL without making a network request.
 *
 * @param {unknown} value Candidate URL.
 * @returns {object} A structured success or failure result.
 */
export const resolveDesignLink = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch (error) {
    return failure(
      "BAD_LINK",
      `Invalid Claude Design URL: ${errorDetail(error)}`,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "claude.ai"
  ) {
    return failure(
      "BAD_LINK",
      "Claude Design links must use https://claude.ai",
    );
  }
  const match = parsed.pathname.match(
    /^\/design\/p\/([A-Za-z0-9_-]{1,128})\/?$/,
  );
  if (!match) {
    return failure(
      "BAD_LINK",
      "Expected a Claude Design project URL shaped like /design/p/<projectId>",
    );
  }
  const fileValue = parsed.searchParams.get("file");
  const filePath = fileValue === null ? null : normalizeDesignPath(fileValue);
  if (fileValue !== null && !filePath) {
    return failure(
      "BAD_LINK",
      "The link file query must be a normalized project-relative path",
    );
  }
  const canonicalUrl = new URL(`https://claude.ai/design/p/${match[1]}`);
  if (filePath) {
    canonicalUrl.searchParams.set("file", filePath);
  }
  return ok({
    projectId: match[1],
    ...(filePath ? { path: filePath } : {}),
    canonicalUrl: canonicalUrl.toString(),
  });
};

const isMissingFileError = (error) => error?.code === "ENOENT";

const samePath = (left, right) =>
  path.relative(left, right) === "" && path.relative(right, left) === "";

const assertWriteParent = (destination, expectedParent, containmentRoot) => {
  const resolvedParent = realpathSync(path.dirname(destination));
  if (
    !samePath(resolvedParent, expectedParent) ||
    !isWithin(resolvedParent, containmentRoot)
  ) {
    throw new Error(
      `Destination parent changed while writing ${path.basename(destination)}`,
    );
  }
};

const destinationChangedError = (destination) => {
  const error = new Error(
    `${path.basename(destination)} changed while replacement was pending`,
  );
  error.code = "DESTINATION_CHANGED";
  return error;
};

const assertDestinationState = (destination, expected) => {
  let metadata;
  try {
    metadata = lstatSync(destination);
  } catch (error) {
    if (isMissingFileError(error) && !expected.exists) {
      return;
    }
    throw destinationChangedError(destination);
  }
  if (
    !expected.exists ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > expected.maxBytes
  ) {
    throw destinationChangedError(destination);
  }
  try {
    if (
      sha256(readRegularFile(destination, expected.maxBytes)) !== expected.sha256
    ) {
      throw destinationChangedError(destination);
    }
  } catch (error) {
    if (error?.code === "DESTINATION_CHANGED") {
      throw error;
    }
    throw destinationChangedError(destination);
  }
};

const atomicWrite = (
  destination,
  bytes,
  { expectedParent, containmentRoot, expectedDestination },
) => {
  const temporary = path.join(
    expectedParent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    assertWriteParent(destination, expectedParent, containmentRoot);
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    assertWriteParent(destination, expectedParent, containmentRoot);
    if (expectedDestination) {
      assertDestinationState(destination, expectedDestination);
    }
    renameSync(temporary, destination);
  } catch (error) {
    try {
      assertWriteParent(destination, expectedParent, containmentRoot);
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      process.stderr.write(
        `[claude-design-bridge] temporary file cleanup failed: ${errorDetail(cleanupError)}\n`,
      );
    }
    throw error;
  }
};

const safeCacheObjectDirectory = () => {
  const requestedDirectory = path.resolve(CACHE_DIR, "objects");
  const volumeRoot = path.parse(requestedDirectory).root;
  try {
    const realRoot = realpathSync(volumeRoot);
    const prepared = prepareDirectoryWithinRoot(
      realRoot,
      path.relative(realRoot, requestedDirectory),
    );
    if (!prepared.ok) {
      process.stderr.write(
        `[claude-design-bridge] cache root validation failed: ${prepared.detail}\n`,
      );
      return failure(
        "UNSAFE_CACHE_DIR",
        "Could not validate the configured cache directory",
      );
    }
    return prepared;
  } catch (error) {
    process.stderr.write(
      `[claude-design-bridge] cache root validation failed: ${errorDetail(error)}\n`,
    );
    return failure(
      "UNSAFE_CACHE_DIR",
      "Could not validate the configured cache directory",
    );
  }
};

const cacheLocations = (projectId, filePath, objectDirectory) => {
  const key = sha256(`${projectId}\0${filePath}`);
  return {
    dataPath: path.join(objectDirectory, `${key}.data`),
    metadataPath: path.join(objectDirectory, `${key}.json`),
  };
};

const removeCacheEntry = (locations) => {
  const warnings = [];
  for (const cachePath of [locations.dataPath, locations.metadataPath]) {
    try {
      rmSync(cachePath, { force: true });
    } catch (error) {
      warnings.push(
        `Could not remove ${path.basename(cachePath)}: ${errorDetail(error)}`,
      );
    }
  }
  return warnings.length ? warnings.join("; ") : null;
};

const readRegularFile = (filePath, maxBytes, encoding) => {
  const expected = lstatSync(filePath, { bigint: true });
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    expected.size > BigInt(maxBytes)
  ) {
    throw new Error(`${path.basename(filePath)} is not a bounded regular file`);
  }
  const descriptor = openSync(filePath, "r");
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size > BigInt(maxBytes)
    ) {
      throw new Error(`${path.basename(filePath)} changed while opening it`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new Error(`${path.basename(filePath)} changed while reading it`);
      }
      offset += bytesRead;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== opened.size ||
      completed.mtimeNs !== opened.mtimeNs ||
      completed.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error(`${path.basename(filePath)} changed while reading it`);
    }
    return encoding ? bytes.toString(encoding) : bytes;
  } finally {
    closeSync(descriptor);
  }
};

const pruneCache = () => {
  const prepared = safeCacheObjectDirectory();
  if (!prepared.ok) {
    process.stderr.write(
      `[claude-design-bridge] cache pruning disabled: ${prepared.detail}\n`,
    );
    return;
  }
  const objectDirectory = prepared.data;
  try {
    const entries = new Map();
    for (const name of readdirSync(objectDirectory)) {
      const finalMatch = name.match(/^([a-f0-9]{64})\.(?:data|json)$/);
      const temporaryMatch = name.match(
        /^\.[a-f0-9]{64}\.(?:data|json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/,
      );
      if (!finalMatch && !temporaryMatch) {
        continue;
      }
      const candidate = path.join(objectDirectory, name);
      let metadata;
      try {
        metadata = lstatSync(candidate);
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw error;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        continue;
      }
      const entryKey = finalMatch ? `cache:${finalMatch[1]}` : `temp:${name}`;
      const entry = entries.get(entryKey) ?? {
        key: entryKey,
        bytes: 0,
        mtimeMs: 0,
        files: [],
      };
      entry.bytes += metadata.size;
      entry.mtimeMs = Math.max(entry.mtimeMs, metadata.mtimeMs);
      entry.files.push({ path: candidate, bytes: metadata.size });
      entries.set(entryKey, entry);
    }

    const removeEntry = (entry) => {
      let removedBytes = 0;
      const remainingFiles = [];
      for (const file of entry.files) {
        try {
          rmSync(file.path);
          removedBytes += file.bytes;
        } catch (error) {
          if (isMissingFileError(error)) {
            removedBytes += file.bytes;
          } else {
            remainingFiles.push(file);
            process.stderr.write(
              `[claude-design-bridge] cache pruning warning for ${path.basename(file.path)}: ${errorDetail(error)}\n`,
            );
          }
        }
      }
      return { removedBytes, remainingFiles };
    };

    const now = Date.now();
    const retained = [];
    for (const entry of entries.values()) {
      if (now - entry.mtimeMs > CACHE_RETENTION_MS) {
        const removal = removeEntry(entry);
        if (removal.remainingFiles.length) {
          entry.files = removal.remainingFiles;
          entry.bytes -= removal.removedBytes;
          retained.push(entry);
        }
      } else {
        retained.push(entry);
      }
    }
    retained.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let retainedBytes = retained.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    let retainedEntries = retained.length;
    while (
      retainedEntries > CACHE_MAX_ENTRIES ||
      retainedBytes > CACHE_MAX_BYTES
    ) {
      const entry = retained.shift();
      if (!entry) {
        break;
      }
      const removal = removeEntry(entry);
      retainedBytes -= removal.removedBytes;
      if (!removal.remainingFiles.length) {
        retainedEntries -= 1;
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      process.stderr.write(
        `[claude-design-bridge] cache pruning failed: ${errorDetail(error)}\n`,
      );
    }
  }
};

let scheduledCachePruneTimer = null;
const scheduleCachePrune = () => {
  if (scheduledCachePruneTimer !== null) {
    return;
  }
  scheduledCachePruneTimer = setTimeout(() => {
    scheduledCachePruneTimer = null;
    pruneCache();
  }, CACHE_WRITE_PRUNE_DELAY_MS);
  scheduledCachePruneTimer.unref();
};

const readCache = (projectId, filePath) => {
  const prepared = safeCacheObjectDirectory();
  if (!prepared.ok) {
    return { hit: null, warning: prepared.detail };
  }
  const locations = cacheLocations(projectId, filePath, prepared.data);
  try {
    const metadata = JSON.parse(
      readRegularFile(
        locations.metadataPath,
        MAX_CACHE_METADATA_BYTES,
        "utf8",
      ),
    );
    const age = Date.now() - Number(metadata.fetchedAtMs);
    if (
      CACHE_TTL_MS === 0 ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > CACHE_TTL_MS
    ) {
      const cleanupWarning = removeCacheEntry(locations);
      return {
        hit: null,
        ...(cleanupWarning ? { warning: cleanupWarning } : {}),
      };
    }
    if (
      metadata.schemaVersion !== 1 ||
      metadata.projectId !== projectId ||
      metadata.path !== filePath ||
      !Number.isInteger(metadata.bytes) ||
      metadata.bytes < 0 ||
      metadata.bytes > MAX_FILE_BYTES ||
      typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      typeof metadata.contentType !== "string" ||
      typeof metadata.binary !== "boolean" ||
      !isCanonicalTimestamp(metadata.fetchedAt) ||
      !Number.isFinite(metadata.fetchedAtMs) ||
      metadata.fetchedAtMs !== Date.parse(metadata.fetchedAt)
    ) {
      const cleanupWarning = removeCacheEntry(locations);
      return {
        hit: null,
        warning: `Cache metadata did not match the requested design file${cleanupWarning ? `; ${cleanupWarning}` : ""}`,
      };
    }
    const bytes = readRegularFile(locations.dataPath, MAX_FILE_BYTES);
    const digest = sha256(bytes);
    if (bytes.length !== metadata.bytes || digest !== metadata.sha256) {
      const cleanupWarning = removeCacheEntry(locations);
      return {
        hit: null,
        warning: `Cache integrity validation failed${cleanupWarning ? `; ${cleanupWarning}` : ""}`,
      };
    }
    return {
      hit: {
        bytes,
        contentType: metadata.contentType,
        binary: Boolean(metadata.binary),
        sha256: digest,
        fetchedAt: metadata.fetchedAt,
        fromCache: true,
      },
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { hit: null };
    }
    process.stderr.write(
      `[claude-design-bridge] cache read failed: ${errorDetail(error)}\n`,
    );
    const cleanupWarning = removeCacheEntry(locations);
    return {
      hit: null,
      warning: `Cache read failed${cleanupWarning ? `; ${cleanupWarning}` : ""}`,
    };
  }
};

const writeCache = (projectId, filePath, file, fetchedAt) => {
  const prepared = safeCacheObjectDirectory();
  if (!prepared.ok) {
    return { warning: prepared.detail };
  }
  const locations = cacheLocations(projectId, filePath, prepared.data);
  const metadata = {
    schemaVersion: 1,
    projectId,
    path: filePath,
    contentType: file.contentType,
    binary: file.binary,
    bytes: file.bytes.length,
    sha256: file.sha256,
    fetchedAt,
    fetchedAtMs: Date.parse(fetchedAt),
  };
  try {
    atomicWrite(locations.dataPath, file.bytes, {
      expectedParent: prepared.data,
      containmentRoot: prepared.data,
    });
    atomicWrite(
      locations.metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      {
        expectedParent: prepared.data,
        containmentRoot: prepared.data,
      },
    );
    scheduleCachePrune();
    return {};
  } catch (error) {
    process.stderr.write(
      `[claude-design-bridge] cache write failed: ${errorDetail(error)}\n`,
    );
    return {
      warning: "Cache write failed",
    };
  }
};

const decodeBase64 = (content) => {
  const compact = content.replace(/\s/g, "");
  if (
    !compact ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    return failure(
      "BAD_RESULT",
      "DesignSync returned invalid base64 file content",
    );
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact) {
    return failure(
      "BAD_RESULT",
      "DesignSync returned non-canonical base64 file content",
    );
  }
  return ok(bytes);
};

/**
 * Convert a raw DesignSync get_file payload into integrity-tagged bytes.
 *
 * @param {unknown} raw Raw DesignSync tool result.
 * @param {string} requestedPath Expected project path.
 * @returns {object} A structured success or failure result.
 */
export const rawFileToBytes = (raw, requestedPath) => {
  if (!raw || typeof raw !== "object" || typeof raw.content !== "string") {
    return failure(
      "BAD_RESULT",
      "DesignSync get_file did not return string content",
    );
  }
  if (raw.truncated === true) {
    return failure(
      "FILE_TRUNCATED",
      `DesignSync truncated ${requestedPath}; legacy Claude Code cannot transfer this file in full`,
    );
  }
  if (raw.truncated !== false) {
    return failure(
      "BAD_RESULT",
      "DesignSync get_file did not return an explicit truncation status",
    );
  }
  if (typeof raw.isBase64 !== "boolean") {
    return failure(
      "BAD_RESULT",
      "DesignSync get_file did not return an explicit base64 status",
    );
  }
  if (
    typeof raw.contentType !== "string" ||
    !raw.contentType ||
    raw.contentType.length > 256 ||
    CONTROL_CHARACTER_PATTERN.test(raw.contentType)
  ) {
    return failure(
      "BAD_RESULT",
      "DesignSync get_file did not return a valid content type",
    );
  }
  const binary = raw.isBase64 === true;
  const decoded = binary
    ? decodeBase64(raw.content)
    : ok(Buffer.from(raw.content, "utf8"));
  if (!decoded.ok) {
    return decoded;
  }
  if (decoded.data.length > MAX_FILE_BYTES) {
    return failure(
      "FILE_TOO_LARGE",
      `${requestedPath} is ${decoded.data.length} bytes; limit is ${MAX_FILE_BYTES}`,
    );
  }
  return ok({
    bytes: decoded.data,
    binary,
    contentType: raw.contentType,
    sha256: sha256(decoded.data),
  });
};

const getFileContent = async (projectId, filePath, refresh, signal) => {
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const projectValidation = validateProjectId(projectId);
  const normalizedPath = normalizeDesignPath(filePath);
  if (!projectValidation.ok || !normalizedPath) {
    return !projectValidation.ok
      ? projectValidation
      : failure("BAD_PATH", "path must be a normalized project-relative path");
  }

  let cacheWarning;
  if (!refresh) {
    const cached = readCache(projectId, normalizedPath);
    if (cached.hit) {
      return ok({ ...cached.hit, path: normalizedPath });
    }
    cacheWarning = cached.warning;
  }

  const delegated = await DESIGN_SOURCE.getFile(projectId, normalizedPath, {
    signal,
  });
  if (!delegated.ok) {
    return delegated;
  }
  const decoded = rawFileToBytes(delegated.data, normalizedPath);
  if (!decoded.ok) {
    return decoded;
  }
  const fetchedAt = new Date().toISOString();
  const cached = writeCache(
    projectId,
    normalizedPath,
    decoded.data,
    fetchedAt,
  );
  return ok({
    ...decoded.data,
    path: normalizedPath,
    fromCache: false,
    fetchedAt,
    warnings: [cacheWarning, cached.warning].filter(Boolean),
  });
};

const extractArray = (data, keys) => {
  if (Array.isArray(data)) {
    return data;
  }
  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }
  return null;
};

const listProjects = async (signal) => {
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const delegated = await DESIGN_SOURCE.listProjects({ signal });
  if (!delegated.ok) {
    return delegated;
  }
  const projects = extractArray(delegated.data, ["projects"]);
  if (!projects) {
    return failure(
      "BAD_RESULT",
      "DesignSync list_projects did not return a projects array",
    );
  }
  return ok({ projects });
};

const getProject = async (args, signal) => {
  const validation = validateProjectId(args?.projectId);
  if (!validation.ok) {
    return validation;
  }
  const delegated = await DESIGN_SOURCE.getProject(args.projectId, { signal });
  if (!delegated.ok) {
    return delegated;
  }
  if (
    !delegated.data ||
    typeof delegated.data !== "object" ||
    Array.isArray(delegated.data)
  ) {
    return failure(
      "BAD_RESULT",
      "DesignSync get_project did not return project metadata",
    );
  }
  const project = Object.hasOwn(delegated.data, "project")
    ? delegated.data.project
    : delegated.data;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return failure(
      "BAD_RESULT",
      "DesignSync get_project did not return valid project metadata",
    );
  }
  return ok(project);
};

const extractPaths = (data) => {
  const entries = extractArray(data, ["paths", "files"]);
  if (!entries) {
    return null;
  }
  const paths = [];
  for (const entry of entries) {
    const candidate =
      typeof entry === "string" ? entry : entry?.path || entry?.name;
    const normalized = normalizeDesignPath(candidate);
    if (!normalized) {
      return null;
    }
    paths.push(normalized);
  }
  return [...new Set(paths)];
};

const listFiles = async (args, signal) => {
  const validation = validateProjectId(args?.projectId);
  if (!validation.ok) {
    return validation;
  }
  const delegated = await DESIGN_SOURCE.listFiles(args.projectId, { signal });
  if (!delegated.ok) {
    return delegated;
  }
  const paths = extractPaths(delegated.data);
  if (!paths) {
    return failure(
      "BAD_RESULT",
      "DesignSync list_files returned an invalid file list",
    );
  }
  return ok({ projectId: args.projectId, paths });
};

/**
 * Shape a fetched file for MCP without placing large or binary content in model context.
 *
 * @param {string} projectId Claude Design project identifier.
 * @param {object} file Decoded file and integrity metadata.
 * @param {number} inlineMaxBytes Maximum inline text byte count.
 * @returns {object} Stable MCP-facing file metadata.
 */
export const fileResultForTool = (
  projectId,
  file,
  inlineMaxBytes = INLINE_MAX_BYTES,
) => {
  const inline =
    inlineMaxBytes > 0 &&
    !file.binary &&
    file.bytes.length <= inlineMaxBytes;
  return {
    projectId,
    path: file.path,
    bytes: file.bytes.length,
    sha256: file.sha256,
    contentType: file.contentType,
    binary: file.binary,
    fromCache: file.fromCache,
    fetchedAt: file.fetchedAt,
    ...(file.warnings?.length ? { warnings: file.warnings } : {}),
    ...(inline
      ? { content: file.bytes.toString("utf8"), contentOmitted: false }
      : {
          contentOmitted: true,
          guidance:
            "Use design_pull to materialize this file inside the current workspace.",
        }),
  };
};

const getFile = async (args, signal) => {
  if (args?.refresh !== undefined && typeof args.refresh !== "boolean") {
    return failure("BAD_REFRESH", "refresh must be a boolean when provided");
  }
  const file = await getFileContent(
    args?.projectId,
    args?.path,
    args?.refresh !== false,
    signal,
  );
  if (!file.ok) {
    return file;
  }
  return ok(fileResultForTool(args.projectId, file.data));
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let clientCapabilities = {};
let mcpRootsPromise = null;
let nextClientRequestId = 0;
let serverInitialized = false;
let clientReady = false;
const pendingClientRequests = new Map();
const activeInboundRequests = new Map();

const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const isValidMessageId = (value) =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isSafeInteger(value));

const requestClient = (method, params = {}) =>
  new Promise((resolve) => {
    const id = `claude-design-${++nextClientRequestId}`;
    const timer = setTimeout(() => {
      pendingClientRequests.delete(id);
      send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: `${method} timed out` },
      });
      resolve(
        failure("CLIENT_REQUEST_TIMEOUT", `${method} did not respond in time`),
      );
    }, CLIENT_REQUEST_TIMEOUT_MS);
    pendingClientRequests.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(
          message.error
            ? failure("CLIENT_REQUEST_FAILED", errorDetail(message.error))
            : ok(message.result),
        );
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });

const rootsFromValue = (value) =>
  String(value ?? "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter((root) => path.isAbsolute(root));

const explicitRoots = () =>
  rootsFromValue(process.env.DESIGN_BRIDGE_ALLOWED_ROOTS);

const normalizeRoot = (root) => {
  try {
    const resolved = realpathSync(root);
    return lstatSync(resolved).isDirectory() ? resolved : null;
  } catch (error) {
    process.stderr.write(
      `[claude-design-bridge] ignoring unavailable root ${root}: ${errorDetail(error)}\n`,
    );
    return null;
  }
};

const getMcpRoots = async () => {
  if (mcpRootsPromise) {
    return mcpRootsPromise;
  }
  mcpRootsPromise = (async () => {
    const roots = [];
    if (clientCapabilities?.roots) {
      const response = await requestClient("roots/list");
      if (response.ok && Array.isArray(response.data?.roots)) {
        for (const root of response.data.roots) {
          try {
            const parsed = new URL(root.uri);
            if (parsed.protocol === "file:") {
              roots.push(fileURLToPath(parsed));
            }
          } catch (error) {
            process.stderr.write(
              `[claude-design-bridge] ignoring invalid MCP root: ${errorDetail(error)}\n`,
            );
          }
        }
      }
    }
    return [...new Set(roots.map(normalizeRoot).filter(Boolean))];
  })();
  return mcpRootsPromise;
};

const sandboxRootFromMeta = (meta) => {
  const sandboxCwd = meta?.[CODEX_SANDBOX_META]?.sandboxCwd;
  if (typeof sandboxCwd !== "string") {
    return null;
  }
  try {
    const parsed = new URL(sandboxCwd);
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : null;
  } catch {
    return null;
  }
};

const getAuthorizedRoots = async (sandboxRoot) => {
  const configured = [
    ...new Set(explicitRoots().map(normalizeRoot).filter(Boolean)),
  ];
  if (process.env.DESIGN_BRIDGE_ALLOWED_ROOTS !== undefined) {
    return configured;
  }
  const mcpRoots = await getMcpRoots();
  if (mcpRoots.length) {
    return mcpRoots;
  }
  const normalizedSandboxRoot = sandboxRoot ? normalizeRoot(sandboxRoot) : null;
  if (normalizedSandboxRoot) {
    return [normalizedSandboxRoot];
  }
  return [];
};

const isWithin = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const resolveWorkspaceFile = async (filePath, sandboxRoot) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    return failure(
      "BAD_EXPORT_PATH",
      "archivePath must be an absolute file path inside the current workspace",
    );
  }
  const roots = await getAuthorizedRoots(sandboxRoot);
  if (!roots.length) {
    return failure(
      "WORKSPACE_ROOT_UNAVAILABLE",
      "Codex did not provide sandbox metadata or an MCP root; configure DESIGN_BRIDGE_ALLOWED_ROOTS explicitly",
    );
  }
  const lexicalPath = path.resolve(filePath);
  const root = roots.find((candidate) => isWithin(lexicalPath, candidate));
  if (!root) {
    return failure(
      "EXPORT_OUTSIDE_WORKSPACE",
      "archivePath must stay inside a current MCP workspace root",
    );
  }
  const segments = path.relative(root, lexicalPath).split(path.sep).filter(Boolean);
  if (!segments.length) {
    return failure(
      "BAD_EXPORT_PATH",
      "archivePath must identify a regular ZIP file inside the workspace root",
    );
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const candidate = path.join(current, segment);
    try {
      const metadata = lstatSync(candidate);
      const isFinal = index === segments.length - 1;
      if (metadata.isSymbolicLink()) {
        return failure(
          "EXPORT_SYMLINK",
          "archivePath must not traverse a symbolic link or junction",
        );
      }
      if ((isFinal && !metadata.isFile()) || (!isFinal && !metadata.isDirectory())) {
        return failure(
          "BAD_EXPORT_PATH",
          "archivePath must identify a regular ZIP file",
        );
      }
      current = realpathSync(candidate);
      if (!isWithin(current, root)) {
        return failure(
          "EXPORT_OUTSIDE_WORKSPACE",
          "archivePath resolved outside the current workspace root",
        );
      }
    } catch (error) {
      return failure(
        "BAD_EXPORT_PATH",
        `Could not inspect archivePath: ${errorDetail(error)}`,
      );
    }
  }
  return ok({ archivePath: current, root });
};

const prepareDirectoryWithinRoot = (root, relativePath) => {
  const segments = relativePath.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        return failure(
          "SYMLINK_ESCAPE",
          `${candidate} is not a safe directory`,
        );
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        return failure(
          "BAD_DIR",
          `Could not inspect ${candidate}: ${errorDetail(error)}`,
        );
      }
      try {
        assertWriteParent(candidate, current, root);
        mkdirSync(candidate, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") {
          return failure(
            "BAD_DIR",
            `Could not create ${candidate}: ${errorDetail(createError)}`,
          );
        }
        try {
          const metadata = lstatSync(candidate);
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            return failure(
              "SYMLINK_ESCAPE",
              `${candidate} is not a safe directory`,
            );
          }
        } catch (inspectError) {
          return failure(
            "BAD_DIR",
            `Could not inspect concurrently-created directory ${candidate}: ${errorDetail(inspectError)}`,
          );
        }
      }
    }
    try {
      const realCandidate = realpathSync(candidate);
      if (!isWithin(realCandidate, root)) {
        return failure(
          "SYMLINK_ESCAPE",
          `${candidate} resolves outside the workspace root`,
        );
      }
      current = realCandidate;
    } catch (error) {
      return failure(
        "BAD_DIR",
        `Could not resolve ${candidate}: ${errorDetail(error)}`,
      );
    }
  }
  return ok(current);
};

const canonicalDestinationKey = (value) =>
  value.normalize("NFC").toLocaleLowerCase("en-US");
const compareDesignPaths = (left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

const selectDestination = async (directory, projectId, sandboxRoot) => {
  const roots = await getAuthorizedRoots(sandboxRoot);
  if (!roots.length) {
    return failure(
      "WORKSPACE_ROOT_UNAVAILABLE",
      "Codex did not provide sandbox metadata or an MCP root; configure DESIGN_BRIDGE_ALLOWED_ROOTS explicitly",
    );
  }
  if (directory === undefined && roots.length !== 1) {
    return failure(
      "DIR_REQUIRED",
      "dir is required when more than one workspace root is authorized",
    );
  }
  const expectedRelative = path.join(".design", "claude", projectId);
  const selectedDirectory =
    directory === undefined ? path.join(roots[0], expectedRelative) : directory;
  if (
    typeof selectedDirectory !== "string" ||
    !path.isAbsolute(selectedDirectory)
  ) {
    return failure(
      "BAD_DIR",
      "dir must be the absolute .design/claude/<projectId> snapshot path",
    );
  }
  const lexicalTarget = path.resolve(selectedDirectory);
  const lexicalRoot = roots.find((root) => isWithin(lexicalTarget, root));
  if (!lexicalRoot) {
    return failure(
      "DIR_OUTSIDE_WORKSPACE",
      "dir must stay inside a current MCP workspace root",
    );
  }
  const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
  if (
    canonicalDestinationKey(relativeTarget) !==
    canonicalDestinationKey(expectedRelative)
  ) {
    return failure(
      "DEDICATED_SNAPSHOT_REQUIRED",
      `dir must be ${path.join(lexicalRoot, expectedRelative)}`,
    );
  }
  return ok({
    lexicalRoot,
    relativeTarget,
  });
};

const approveDestination = async (
  directory,
  projectId,
  sandboxRoot,
  signal,
) => {
  const selected = await selectDestination(directory, projectId, sandboxRoot);
  if (!selected.ok) {
    return selected;
  }
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const prepared = prepareDirectoryWithinRoot(
    selected.data.lexicalRoot,
    selected.data.relativeTarget,
  );
  return prepared.ok
    ? ok({ directory: prepared.data, root: selected.data.lexicalRoot })
    : prepared;
};

const inspectExistingDirectoryWithinRoot = (root, relativePath) => {
  const segments = relativePath.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let metadata;
    try {
      metadata = lstatSync(candidate);
    } catch (error) {
      return isMissingFileError(error)
        ? failure("SNAPSHOT_NOT_FOUND", "The managed snapshot does not exist")
        : failure(
            "BAD_DIR",
            `Could not inspect the snapshot directory: ${errorDetail(error)}`,
          );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return failure(
        "SYMLINK_ESCAPE",
        "The managed snapshot path is not a safe directory",
      );
    }
    try {
      const realCandidate = realpathSync(candidate);
      if (!isWithin(realCandidate, root)) {
        return failure(
          "SYMLINK_ESCAPE",
          "The managed snapshot resolves outside the workspace root",
        );
      }
      current = realCandidate;
    } catch (error) {
      return failure(
        "BAD_DIR",
        `Could not resolve the snapshot directory: ${errorDetail(error)}`,
      );
    }
  }
  return ok(current);
};

const resolveExistingSnapshotWithinRoot = async (
  directory,
  projectId,
  sandboxRoot,
  signal,
) => {
  const selected = await selectDestination(directory, projectId, sandboxRoot);
  if (!selected.ok) {
    return selected;
  }
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const inspected = inspectExistingDirectoryWithinRoot(
    selected.data.lexicalRoot,
    selected.data.relativeTarget,
  );
  return inspected.ok
    ? ok({ directory: inspected.data, root: selected.data.lexicalRoot })
    : inspected;
};

const destinationFor = (root, designPath) => {
  const destination = path.resolve(root, ...designPath.split("/"));
  return isWithin(destination, root) ? destination : null;
};

const inspectExistingDestination = (destination, digest) => {
  try {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink()) {
      return failure(
        "SYMLINK_DESTINATION",
        "Refusing to write through a symbolic link or junction",
      );
    }
    if (!metadata.isFile()) {
      return failure(
        "DESTINATION_NOT_FILE",
        "Refusing to replace a non-file destination",
      );
    }
    if (metadata.size > MAX_FILE_BYTES) {
      return ok({ exists: true, unchanged: false, sha256: null });
    }
    const existingDigest = sha256(
      readRegularFile(destination, MAX_FILE_BYTES),
    );
    return ok({
      exists: true,
      unchanged: existingDigest === digest,
      sha256: existingDigest,
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return ok({ exists: false, unchanged: false, sha256: null });
    }
    return failure("DESTINATION_READ_FAILED", errorDetail(error));
  }
};

const ensureParentContained = (root, destination) => {
  const parent = path.dirname(destination);
  if (!isWithin(parent, root)) {
    return failure(
      "PATH_ESCAPE",
      "Destination parent escaped the snapshot directory",
    );
  }
  return prepareDirectoryWithinRoot(root, path.relative(root, parent));
};

const writeSnapshotFile = (
  root,
  designPath,
  file,
  { overwrite, previousSha256 },
) => {
  const destination = destinationFor(root, designPath);
  if (!destination) {
    return failure("PATH_ESCAPE", "Design path escaped the snapshot directory");
  }
  const parent = ensureParentContained(root, destination);
  if (!parent.ok) {
    return parent;
  }
  const validatedDestination = path.join(
    parent.data,
    path.basename(destination),
  );
  const existing = inspectExistingDestination(
    validatedDestination,
    file.sha256,
  );
  if (!existing.ok) {
    return existing;
  }
  if (existing.data.unchanged) {
    return ok({
      localPath: validatedDestination,
      unchanged: true,
      updated: false,
      forced: false,
    });
  }
  const managedSnapshotIsUnmodified =
    previousSha256 !== undefined && existing.data.sha256 === previousSha256;
  if (
    existing.data.exists &&
    overwrite !== true &&
    !managedSnapshotIsUnmodified
  ) {
    const reason =
      previousSha256 === undefined
        ? "the existing file is not tracked by the snapshot manifest"
        : "the local file changed since the previous snapshot";
    return failure(
      "FILE_EXISTS",
      `${designPath} differs from Claude Design and ${reason}; pass overwrite:true to replace it`,
    );
  }
  try {
    atomicWrite(validatedDestination, file.bytes, {
      expectedParent: parent.data,
      containmentRoot: root,
      ...(overwrite === true
        ? {}
        : {
            expectedDestination: {
              exists: existing.data.exists,
              sha256: existing.data.sha256,
              maxBytes: MAX_FILE_BYTES,
            },
          }),
    });
    const written = readRegularFile(validatedDestination, MAX_FILE_BYTES);
    if (
      written.length !== file.bytes.length ||
      sha256(written) !== file.sha256
    ) {
      return failure(
        "WRITE_INTEGRITY_FAILED",
        `Written bytes did not match ${designPath}`,
      );
    }
    return ok({
      localPath: validatedDestination,
      unchanged: false,
      updated: existing.data.exists,
      forced: existing.data.exists && overwrite === true,
    });
  } catch (error) {
    if (error?.code === "DESTINATION_CHANGED") {
      return failure(
        "FILE_CHANGED",
        `${designPath} changed locally while the design pull was replacing it; retry after local edits are complete`,
      );
    }
    return failure(
      "WRITE_FAILED",
      `Could not write ${designPath}: ${errorDetail(error)}`,
    );
  }
};

const mapWithConcurrency = async (items, concurrency, operation) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
};

const removeDirectoryEntries = (paths) => {
  const candidates = new Set(paths);
  const directoryEntries = new Set();
  for (const candidate of paths) {
    let separatorIndex = candidate.indexOf("/");
    while (separatorIndex >= 0) {
      const parent = candidate.slice(0, separatorIndex);
      if (candidates.has(parent)) {
        directoryEntries.add(parent);
      }
      separatorIndex = candidate.indexOf("/", separatorIndex + 1);
    }
  }
  return paths.filter((candidate) => !directoryEntries.has(candidate));
};

const validManifestEntry = (entry, requirePulledAt) =>
  entry &&
  typeof entry === "object" &&
  !Array.isArray(entry) &&
  normalizeDesignPath(entry.path) === entry.path &&
  Number.isInteger(entry.bytes) &&
  entry.bytes >= 0 &&
  entry.bytes <= MAX_FILE_BYTES &&
  typeof entry.sha256 === "string" &&
  /^[a-f0-9]{64}$/.test(entry.sha256) &&
  typeof entry.contentType === "string" &&
  entry.contentType.length > 0 &&
  entry.contentType.length <= 256 &&
  !CONTROL_CHARACTER_PATTERN.test(entry.contentType) &&
  typeof entry.binary === "boolean" &&
  (!requirePulledAt || isCanonicalTimestamp(entry.pulledAt));

const validManifestSource = (source) => {
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    typeof source.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) ||
    typeof source.transport !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.transport) ||
    source.readOnly !== true
  ) {
    return false;
  }
  if (source.id === "claude-design-browser-export") {
    return (
      source.transport === "browser-zip" &&
      typeof source.archiveSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(source.archiveSha256)
    );
  }
  return source.archiveSha256 === undefined;
};

const manifestSourcesMatch = (left, right) =>
  left?.id === right.id &&
  left?.transport === right.transport &&
  left?.readOnly === right.readOnly &&
  left?.archiveSha256 === right.archiveSha256;

const validateSourceTransition = (
  previousEntries,
  previousSource,
  entries,
  source,
) => {
  if (!previousEntries.length) {
    return ok(source);
  }
  const effectivePreviousSource = previousSource || DESIGN_SOURCE_PROVENANCE;
  if (manifestSourcesMatch(effectivePreviousSource, source)) {
    return ok(source);
  }
  const replacementKeys = new Set(
    entries.map((entry) => canonicalDestinationKey(entry.path)),
  );
  const missingReplacement = previousEntries.find(
    (entry) => !replacementKeys.has(canonicalDestinationKey(entry.path)),
  );
  return missingReplacement
    ? failure(
        "SOURCE_PROVENANCE_CONFLICT",
        `Changing snapshot source requires replacing every tracked file; ${missingReplacement.path} was not selected`,
      )
    : ok(source);
};

const indexPaths = (paths) => {
  const indexed = new Map();
  const manifestKey = canonicalDestinationKey(MANIFEST_NAME);
  const lockKey = canonicalDestinationKey(SNAPSHOT_LOCK_NAME);
  for (const filePath of paths) {
    const key = canonicalDestinationKey(filePath);
    if (
      key === manifestKey ||
      key.startsWith(`${manifestKey}/`) ||
      key === lockKey ||
      key.startsWith(`${lockKey}/`)
    ) {
      return failure(
        "RESERVED_PATH",
        `${MANIFEST_NAME} and ${SNAPSHOT_LOCK_NAME} are reserved snapshot control paths`,
      );
    }
    const previous = indexed.get(key);
    if (previous !== undefined && previous !== filePath) {
      return failure(
        "PATH_COLLISION",
        `${previous} and ${filePath} resolve to the same portable destination`,
      );
    }
    indexed.set(key, filePath);
  }
  const pathTree = { children: new Map(), filePath: null, firstPath: null };
  for (const [key, filePath] of indexed) {
    let node = pathTree;
    const lineage = [node];
    for (const segment of key.split("/")) {
      if (node.filePath !== null) {
        return failure(
          "PATH_COLLISION",
          `${node.filePath} and ${filePath} cannot both be a file and parent directory`,
        );
      }
      if (!node.children.has(segment)) {
        node.children.set(segment, {
          children: new Map(),
          filePath: null,
          firstPath: null,
        });
      }
      node = node.children.get(segment);
      lineage.push(node);
    }
    if (node.firstPath !== null) {
      return failure(
        "PATH_COLLISION",
        `${filePath} and ${node.firstPath} cannot both be a file and parent directory`,
      );
    }
    node.filePath = filePath;
    for (const ancestor of lineage) {
      ancestor.firstPath ??= filePath;
    }
  }
  return ok([...indexed.values()]);
};

const pullLocks = new Map();

const withPullLock = async (key, operation) => {
  const previous = pullLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pullLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (pullLocks.get(key) === current) {
      pullLocks.delete(key);
    }
  }
};

const existingSnapshotLockFailure = (lockPath) => {
  const busy = () =>
    failure(
      "SNAPSHOT_BUSY",
      `Another process is pulling this snapshot; if no pull is active, inspect and remove ${lockPath}`,
    );
  try {
    const lock = JSON.parse(readRegularFile(lockPath, 1024, "utf8"));
    if (
      !lock ||
      typeof lock !== "object" ||
      Array.isArray(lock) ||
      lock.hostname !== os.hostname() ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid <= 0 ||
      typeof lock.createdAt !== "string" ||
      !Number.isFinite(Date.parse(lock.createdAt))
    ) {
      return busy();
    }
    try {
      process.kill(lock.pid, 0);
      return busy();
    } catch (error) {
      return error?.code === "ESRCH"
        ? failure(
            "SNAPSHOT_STALE",
            `The recorded same-host snapshot lock owner is no longer running; inspect and remove ${lockPath}`,
          )
        : busy();
    }
  } catch {
    // Unreadable or legacy locks remain owned; recovery must never guess ownership.
    return busy();
  }
};

const acquireSnapshotLock = (directory) => {
  const lockPath = path.join(directory, SNAPSHOT_LOCK_NAME);
  const token = JSON.stringify({
    id: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  });
  try {
    assertWriteParent(lockPath, directory, directory);
    writeFileSync(lockPath, token, { flag: "wx", mode: 0o600 });
    assertWriteParent(lockPath, directory, directory);
    const metadata = lstatSync(lockPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 1024 ||
      readRegularFile(lockPath, 1024, "utf8") !== token
    ) {
      return failure(
        "SNAPSHOT_LOCK_INVALID",
        `${SNAPSHOT_LOCK_NAME} changed while it was being acquired`,
      );
    }
    return ok({ lockPath, token });
  } catch (error) {
    return error?.code === "EEXIST"
      ? existingSnapshotLockFailure(lockPath)
      : failure(
          "SNAPSHOT_LOCK_FAILED",
          `Could not lock the snapshot: ${errorDetail(error)}`,
        );
  }
};

const releaseSnapshotLock = ({ lockPath, token }) => {
  try {
    const directory = path.dirname(lockPath);
    assertWriteParent(lockPath, directory, directory);
    const metadata = lstatSync(lockPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 1024 ||
      readRegularFile(lockPath, 1024, "utf8") !== token
    ) {
      return failure(
        "SNAPSHOT_LOCK_CHANGED",
        `Refusing to remove a changed ${SNAPSHOT_LOCK_NAME}`,
      );
    }
    rmSync(lockPath);
    return ok(true);
  } catch (error) {
    return failure(
      "SNAPSHOT_UNLOCK_FAILED",
      `Could not release ${SNAPSHOT_LOCK_NAME}: ${errorDetail(error)}`,
    );
  }
};

const readManifest = (
  directory,
  projectId,
  { allowMissing = true } = {},
) => {
  const manifestPath = path.join(directory, MANIFEST_NAME);
  try {
    const metadata = lstatSync(manifestPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return failure(
        "MANIFEST_INVALID",
        `Existing ${MANIFEST_NAME} is not a regular file`,
      );
    }
    if (metadata.size > MAX_MANIFEST_BYTES) {
      return failure(
        "MANIFEST_INVALID",
        `Existing ${MANIFEST_NAME} exceeds the size limit`,
      );
    }
    const manifestBytes = readRegularFile(manifestPath, MAX_MANIFEST_BYTES);
    const previous = JSON.parse(manifestBytes.toString("utf8"));
    if (previous.projectId !== projectId) {
      return failure(
        "MANIFEST_CONFLICT",
        `Existing ${MANIFEST_NAME} belongs to another project`,
      );
    }
    if (previous.schemaVersion !== 1 && previous.schemaVersion !== 2) {
      return failure(
        "MANIFEST_VERSION_UNSUPPORTED",
        `Existing ${MANIFEST_NAME} uses unsupported schema version ${String(previous.schemaVersion)}`,
      );
    }
    if (!Array.isArray(previous.files)) {
      return failure(
        "MANIFEST_INVALID",
        `Existing ${MANIFEST_NAME} does not contain a file list`,
      );
    }
    const isVersionOne = previous.schemaVersion === 1;
    if (
      (isVersionOne && !isCanonicalTimestamp(previous.pulledAt)) ||
      (!isVersionOne &&
        (!isCanonicalTimestamp(previous.updatedAt) ||
          previous.projectUrl !==
            `https://claude.ai/design/p/${projectId}` ||
          !validManifestSource(previous.source)))
    ) {
      return failure(
        "MANIFEST_INVALID",
        `Existing ${MANIFEST_NAME} has invalid provenance metadata`,
      );
    }
    if (
      !previous.files.every((entry) =>
        validManifestEntry(entry, !isVersionOne),
      )
    ) {
      return failure(
        "MANIFEST_INVALID",
        `Existing ${MANIFEST_NAME} has invalid file metadata`,
      );
    }
    const indexedPaths = indexPaths(
      previous.files.map((entry) => entry.path),
    );
    if (!indexedPaths.ok || indexedPaths.data.length !== previous.files.length) {
      return failure(
        "MANIFEST_INVALID",
        `Existing ${MANIFEST_NAME} contains conflicting file paths`,
      );
    }
    return ok({
      entries: previous.files.map((entry) => ({
        ...entry,
        pulledAt: isVersionOne ? previous.pulledAt : entry.pulledAt,
      })),
      fingerprint: sha256(manifestBytes),
      manifestPath,
      migratedFromVersion: isVersionOne ? 1 : null,
      source: isVersionOne ? null : previous.source,
      updatedAt: isVersionOne ? previous.pulledAt : previous.updatedAt,
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return allowMissing
        ? ok({
            entries: [],
            fingerprint: null,
            manifestPath,
            migratedFromVersion: null,
            source: null,
            updatedAt: null,
          })
        : failure(
            "MANIFEST_NOT_FOUND",
            `The managed snapshot does not contain ${MANIFEST_NAME}`,
          );
    }
    return failure(
      "MANIFEST_INVALID",
      `Existing ${MANIFEST_NAME} is invalid: ${errorDetail(error)}`,
    );
  }
};

const writeManifest = (
  directory,
  projectId,
  previousEntries,
  previousFingerprint,
  entries,
  previousSource,
  source,
) => {
  const manifestPath = path.join(directory, MANIFEST_NAME);
  let currentFingerprint = null;
  try {
    currentFingerprint = sha256(
      readRegularFile(manifestPath, MAX_MANIFEST_BYTES),
    );
  } catch (error) {
    if (!isMissingFileError(error)) {
      return failure(
        "MANIFEST_CHANGED",
        `Could not revalidate ${MANIFEST_NAME}: ${errorDetail(error)}`,
      );
    }
  }
  if (currentFingerprint !== previousFingerprint) {
    return failure(
      "MANIFEST_CHANGED",
      `${MANIFEST_NAME} changed while the design pull was running`,
    );
  }
  const sourceTransition = validateSourceTransition(
    previousEntries,
    previousSource,
    entries,
    source,
  );
  if (!sourceTransition.ok) {
    return sourceTransition;
  }
  const allPaths = indexPaths(
    [...previousEntries, ...entries].map((entry) => entry.path),
  );
  if (!allPaths.ok) {
    return allPaths;
  }
  const merged = new Map(
    previousEntries.map((entry) => [
      canonicalDestinationKey(entry.path),
      entry,
    ]),
  );
  for (const entry of entries) {
    merged.set(canonicalDestinationKey(entry.path), entry);
  }
  const manifest = {
    schemaVersion: 2,
    projectId,
    projectUrl: `https://claude.ai/design/p/${projectId}`,
    updatedAt: new Date().toISOString(),
    source,
    files: [...merged.values()].sort(compareDesignPaths),
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestBytes, "utf8") > MAX_MANIFEST_BYTES) {
    return failure(
      "MANIFEST_TOO_LARGE",
      `${MANIFEST_NAME} would exceed the ${MAX_MANIFEST_BYTES}-byte limit`,
    );
  }
  try {
    atomicWrite(manifestPath, manifestBytes, {
      expectedParent: directory,
      containmentRoot: directory,
      expectedDestination: {
        exists: currentFingerprint !== null,
        sha256: currentFingerprint,
        maxBytes: MAX_MANIFEST_BYTES,
      },
    });
    return ok(manifestPath);
  } catch (error) {
    if (error?.code === "DESTINATION_CHANGED") {
      return failure(
        "MANIFEST_CHANGED",
        `${MANIFEST_NAME} changed while the design pull was writing it`,
      );
    }
    return failure("MANIFEST_WRITE_FAILED", errorDetail(error));
  }
};

const validateSnapshotStatusArguments = (args) => {
  const maxEntries =
    args?.maxEntries === undefined ? MAX_STATUS_ENTRIES : args.maxEntries;
  if (
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_STATUS_ENTRIES
  ) {
    return failure(
      "BAD_MAX_ENTRIES",
      `maxEntries must be an integer from 1 through ${MAX_STATUS_ENTRIES}`,
    );
  }
  return ok({ maxEntries });
};

const yieldToEventLoop = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const inspectSnapshotEntries = async (directory, maxEntries, signal) => {
  const files = [];
  const pending = [{ absolutePath: directory, relativePath: "" }];
  let inspectedEntries = 0;
  let pathBytes = 0;

  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      return failure(
        "SNAPSHOT_READ_FAILED",
        `Could not enumerate the managed snapshot: ${errorDetail(error)}`,
      );
    }

    for (const entry of entries) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      if (
        current.relativePath === "" &&
        (relativePath === MANIFEST_NAME ||
          relativePath === SNAPSHOT_LOCK_NAME)
      ) {
        continue;
      }

      inspectedEntries += 1;
      if (inspectedEntries % 32 === 0) {
        await yieldToEventLoop();
        const cancelled = cancellationFailure(signal);
        if (cancelled) {
          return cancelled;
        }
      }
      pathBytes += Buffer.byteLength(relativePath, "utf8");
      if (
        inspectedEntries > maxEntries ||
        pathBytes > MAX_STATUS_PATH_BYTES
      ) {
        return failure(
          "STATUS_LIMIT_EXCEEDED",
          `Snapshot status exceeded maxEntries=${maxEntries} or the path-byte limit`,
        );
      }

      const normalizedPath = normalizeDesignPath(relativePath);
      if (normalizedPath !== relativePath) {
        return failure(
          "SNAPSHOT_ENTRY_INVALID",
          "The managed snapshot contains a path that cannot be represented safely",
        );
      }

      const absolutePath = path.join(current.absolutePath, entry.name);
      let metadata;
      try {
        metadata = lstatSync(absolutePath);
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        return failure(
          "SNAPSHOT_READ_FAILED",
          `Could not inspect the managed snapshot: ${errorDetail(error)}`,
        );
      }

      if (metadata.isSymbolicLink()) {
        return failure(
          "SYMLINK_ESCAPE",
          "The managed snapshot contains a symbolic link or junction",
        );
      }
      if (metadata.isDirectory()) {
        try {
          const realDirectory = realpathSync(absolutePath);
          if (!isWithin(realDirectory, directory)) {
            return failure(
              "SYMLINK_ESCAPE",
              "The managed snapshot contains a directory outside its root",
            );
          }
          pending.push({
            absolutePath: realDirectory,
            relativePath,
          });
        } catch (error) {
          return failure(
            "SNAPSHOT_READ_FAILED",
            `Could not resolve the managed snapshot: ${errorDetail(error)}`,
          );
        }
        continue;
      }
      if (!metadata.isFile()) {
        return failure(
          "SNAPSHOT_ENTRY_INVALID",
          "The managed snapshot contains a non-file entry",
        );
      }
      files.push({ absolutePath, path: relativePath, bytes: metadata.size });
    }
  }

  files.sort(compareDesignPaths);
  const indexed = indexPaths(files.map((file) => file.path));
  return indexed.ok ? ok(files) : indexed;
};

const snapshotLockStatus = (directory) => {
  const lockPath = path.join(directory, SNAPSHOT_LOCK_NAME);
  try {
    lstatSync(lockPath);
    return existingSnapshotLockFailure(lockPath);
  } catch (error) {
    return isMissingFileError(error)
      ? null
      : failure(
          "SNAPSHOT_READ_FAILED",
          `Could not inspect ${SNAPSHOT_LOCK_NAME}: ${errorDetail(error)}`,
        );
  }
};

const snapshotStatus = async (args, signal, sandboxRoot) => {
  const initialCancellation = cancellationFailure(signal);
  if (initialCancellation) {
    return initialCancellation;
  }
  const projectValidation = validateProjectId(args?.projectId);
  if (!projectValidation.ok) {
    return projectValidation;
  }
  const statusArguments = validateSnapshotStatusArguments(args);
  if (!statusArguments.ok) {
    return statusArguments;
  }
  const destination = await resolveExistingSnapshotWithinRoot(
    args?.dir,
    args.projectId,
    sandboxRoot,
    signal,
  );
  if (!destination.ok) {
    return destination;
  }

  const activeLock = snapshotLockStatus(destination.data.directory);
  if (activeLock) {
    return activeLock;
  }
  const manifest = readManifest(destination.data.directory, args.projectId, {
    allowMissing: false,
  });
  if (!manifest.ok) {
    return manifest;
  }
  if (manifest.data.entries.length > statusArguments.data.maxEntries) {
    return failure(
      "STATUS_LIMIT_EXCEEDED",
      `Manifest entries exceed maxEntries=${statusArguments.data.maxEntries}`,
    );
  }

  const inspected = await inspectSnapshotEntries(
    destination.data.directory,
    statusArguments.data.maxEntries,
    signal,
  );
  if (!inspected.ok) {
    return inspected;
  }
  const combinedPaths = indexPaths([
    ...manifest.data.entries.map((entry) => entry.path),
    ...inspected.data.map((entry) => entry.path),
  ]);
  if (!combinedPaths.ok) {
    return combinedPaths;
  }

  const localByKey = new Map(
    inspected.data.map((entry) => [
      canonicalDestinationKey(entry.path),
      entry,
    ]),
  );
  const manifestKeys = new Set(
    manifest.data.entries.map((entry) =>
      canonicalDestinationKey(entry.path),
    ),
  );
  const summary = { clean: 0, modified: 0, missing: 0, untracked: 0 };
  const files = [];

  for (const [index, expected] of manifest.data.entries.entries()) {
    if (index > 0 && index % 32 === 0) {
      await yieldToEventLoop();
      const cancelled = cancellationFailure(signal);
      if (cancelled) {
        return cancelled;
      }
    }
    const local = localByKey.get(canonicalDestinationKey(expected.path));
    if (!local) {
      summary.missing += 1;
      files.push({
        path: expected.path,
        status: "missing",
        expectedSha256: expected.sha256,
        pulledAt: expected.pulledAt,
      });
      continue;
    }
    if (local.bytes > MAX_FILE_BYTES) {
      summary.modified += 1;
      files.push({
        path: expected.path,
        status: "modified",
        expectedSha256: expected.sha256,
        actualSha256: null,
        actualBytes: local.bytes,
        pulledAt: expected.pulledAt,
        detail: `Local file exceeds the ${MAX_FILE_BYTES}-byte status hash limit`,
      });
      continue;
    }

    let bytes;
    try {
      bytes = readRegularFile(local.absolutePath, MAX_FILE_BYTES);
    } catch (error) {
      if (isMissingFileError(error)) {
        summary.missing += 1;
        files.push({
          path: expected.path,
          status: "missing",
          expectedSha256: expected.sha256,
          pulledAt: expected.pulledAt,
        });
        continue;
      }
      return failure(
        "SNAPSHOT_CHANGED",
        `A snapshot file changed during status inspection: ${errorDetail(error)}`,
      );
    }
    const actualSha256 = sha256(bytes);
    const status = actualSha256 === expected.sha256 ? "clean" : "modified";
    summary[status] += 1;
    files.push({
      path: expected.path,
      status,
      expectedSha256: expected.sha256,
      actualSha256,
      actualBytes: bytes.length,
      pulledAt: expected.pulledAt,
    });
  }

  const untracked = inspected.data
    .filter(
      (entry) => !manifestKeys.has(canonicalDestinationKey(entry.path)),
    )
    .map((entry) => entry.path);
  summary.untracked = untracked.length;

  const revalidatedManifest = readManifest(
    destination.data.directory,
    args.projectId,
    { allowMissing: false },
  );
  if (
    !revalidatedManifest.ok ||
    revalidatedManifest.data.fingerprint !== manifest.data.fingerprint
  ) {
    return failure(
      "MANIFEST_CHANGED",
      `${MANIFEST_NAME} changed during status inspection`,
    );
  }
  const endingLock = snapshotLockStatus(destination.data.directory);
  if (endingLock) {
    return endingLock;
  }

  const dirty =
    summary.modified > 0 || summary.missing > 0 || summary.untracked > 0;
  return ok({
    projectId: args.projectId,
    dir: destination.data.directory,
    state: dirty ? "dirty" : "clean",
    manifestSchemaVersion: manifest.data.migratedFromVersion ?? 2,
    updatedAt: manifest.data.updatedAt,
    source: manifest.data.source,
    summary,
    files,
    untracked,
  });
};

const validatePullArguments = (args) => {
  const maxFiles =
    args?.maxFiles === undefined ? MAX_PULL_FILES : args.maxFiles;
  if (
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > MAX_PULL_FILES
  ) {
    return failure(
      "BAD_MAX_FILES",
      `maxFiles must be an integer from 1 through ${MAX_PULL_FILES}`,
    );
  }
  if (args?.refresh !== undefined && typeof args.refresh !== "boolean") {
    return failure("BAD_REFRESH", "refresh must be a boolean when provided");
  }
  if (args?.overwrite !== undefined && typeof args.overwrite !== "boolean") {
    return failure(
      "BAD_OVERWRITE",
      "overwrite must be a boolean when provided",
    );
  }
  const pullOptions = {
    maxFiles,
    refresh: args?.refresh !== false,
    overwrite: args?.overwrite,
  };
  if (args?.paths === undefined) {
    return ok({ ...pullOptions, requestedPaths: null });
  }
  if (!Array.isArray(args.paths) || !args.paths.length) {
    return failure(
      "BAD_PATHS",
      "paths must be a non-empty array when provided",
    );
  }
  if (args.paths.length > maxFiles) {
    return failure(
      "TOO_MANY_FILES",
      `${args.paths.length} paths exceed maxFiles=${maxFiles}; pass only the linked or required paths`,
    );
  }
  if (new Set(args.paths).size !== args.paths.length) {
    return failure("BAD_PATHS", "paths must not contain duplicate entries");
  }
  const requestedPaths = args.paths.map(normalizeDesignPath);
  if (requestedPaths.some((filePath) => !filePath)) {
    return failure(
      "BAD_PATH",
      "Every requested path must be normalized and project-relative",
    );
  }
  const indexedPaths = indexPaths(requestedPaths);
  return indexedPaths.ok
    ? ok({ ...pullOptions, requestedPaths: indexedPaths.data })
    : indexedPaths;
};

const performPull = async (args, signal, destination, selection) => {
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const previousManifest = readManifest(
    destination.data.directory,
    args.projectId,
  );
  if (!previousManifest.ok) {
    return previousManifest;
  }
  const previousEntriesByPath = new Map(
    previousManifest.data.entries.map((entry) => [
      canonicalDestinationKey(entry.path),
      entry,
    ]),
  );
  const { maxFiles, overwrite, refresh } = selection;
  let requestedPaths = selection.requestedPaths;
  if (requestedPaths === null) {
    const listed = await listFiles({ projectId: args.projectId }, signal);
    if (!listed.ok) {
      return listed;
    }
    requestedPaths = removeDirectoryEntries(listed.data.paths);
    const indexedPaths = indexPaths(requestedPaths);
    if (!indexedPaths.ok) {
      return indexedPaths;
    }
    requestedPaths = indexedPaths.data;
  }

  if (!requestedPaths.length) {
    return failure("NO_FILES", "No files were selected for the snapshot");
  }
  if (requestedPaths.length > maxFiles) {
    return failure(
      "TOO_MANY_FILES",
      `${requestedPaths.length} files exceed maxFiles=${maxFiles}; pass the linked or required paths`,
    );
  }

  let selectedBytes = 0;
  let pullLimitExceeded = false;
  const results = await mapWithConcurrency(
    requestedPaths,
    PULL_CONCURRENCY,
    async (filePath) => {
      const operationCancelled = cancellationFailure(signal);
      if (operationCancelled) {
        return { path: filePath, result: operationCancelled };
      }
      if (pullLimitExceeded) {
        return {
          path: filePath,
          result: failure(
            "PULL_TOO_LARGE",
            `Selected files exceed the ${MAX_PULL_BYTES}-byte pull limit`,
          ),
        };
      }
      const file = await getFileContent(
        args.projectId,
        filePath,
        refresh,
        signal,
      );
      if (!file.ok) {
        return { path: filePath, result: file };
      }
      const postFetchCancellation = cancellationFailure(signal);
      if (postFetchCancellation) {
        return { path: filePath, result: postFetchCancellation };
      }
      selectedBytes += file.data.bytes.length;
      if (selectedBytes > MAX_PULL_BYTES) {
        pullLimitExceeded = true;
        return {
          path: filePath,
          result: failure(
            "PULL_TOO_LARGE",
            `Selected files exceed the ${MAX_PULL_BYTES}-byte pull limit`,
          ),
        };
      }
      const written = writeSnapshotFile(
        destination.data.directory,
        filePath,
        file.data,
        {
          overwrite,
          previousSha256: previousEntriesByPath.get(
            canonicalDestinationKey(filePath),
          )?.sha256,
        },
      );
      if (!written.ok) {
        return { path: filePath, result: written };
      }
      return {
        path: filePath,
        result: ok({
          path: filePath,
          localPath: written.data.localPath,
          bytes: file.data.bytes.length,
          sha256: file.data.sha256,
          contentType: file.data.contentType,
          binary: file.data.binary,
          fromCache: file.data.fromCache,
          unchanged: written.data.unchanged,
          updated: written.data.updated,
          forced: written.data.forced,
          pulledAt: file.data.fetchedAt,
          ...(file.data.warnings?.length
            ? { warnings: file.data.warnings }
            : {}),
        }),
      };
    },
  );

  const written = results
    .filter((entry) => entry.result.ok)
    .map((entry) => entry.result.data);
  const errors = results
    .filter((entry) => !entry.result.ok)
    .map((entry) => ({
      path: entry.path,
      error: entry.result.error,
      detail: entry.result.detail,
    }));
  const manifestEntries = written.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    contentType: entry.contentType,
    binary: entry.binary,
    pulledAt: entry.pulledAt,
  }));
  const manifest = manifestEntries.length
    ? writeManifest(
        destination.data.directory,
        args.projectId,
        previousManifest.data.entries,
        previousManifest.data.fingerprint,
        manifestEntries,
        previousManifest.data.source,
        DESIGN_SOURCE_PROVENANCE,
      )
    : failure("MANIFEST_SKIPPED", "No files were written");
  if (!manifest.ok) {
    errors.push({
      path: MANIFEST_NAME,
      error: manifest.error,
      detail: manifest.detail,
    });
  }

  const data = {
    projectId: args.projectId,
    dir: destination.data.directory,
    count: written.length,
    written,
    errors,
    ...(manifest.ok ? { manifestPath: manifest.data } : {}),
  };
  if (errors.length) {
    return failure(
      written.length ? "PARTIAL_PULL" : "PULL_FAILED",
      "One or more files failed to pull",
      data,
    );
  }
  return ok(data);
};

const pull = async (args, signal, sandboxRoot) => {
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const projectValidation = validateProjectId(args?.projectId);
  if (!projectValidation.ok) {
    return projectValidation;
  }
  const selection = validatePullArguments(args);
  if (!selection.ok) {
    return selection;
  }
  const destination = await approveDestination(
    args?.dir,
    args.projectId,
    sandboxRoot,
    signal,
  );
  if (!destination.ok) {
    return destination;
  }
  const lockKey = canonicalDestinationKey(destination.data.directory);
  return withPullLock(lockKey, async () => {
    const queuedCancellation = cancellationFailure(signal);
    if (queuedCancellation) {
      return queuedCancellation;
    }
    const lock = acquireSnapshotLock(destination.data.directory);
    if (!lock.ok) {
      return lock;
    }
    let result;
    let operationError;
    try {
      result = await performPull(args, signal, destination, selection.data);
    } catch (error) {
      operationError = error;
    }
    const released = releaseSnapshotLock(lock.data);
    if (operationError) {
      if (!released.ok) {
        throw new AggregateError(
          [operationError, new Error(released.detail)],
          "Snapshot pull and lock release both failed",
        );
      }
      throw operationError;
    }
    if (!released.ok) {
      return failure(released.error, released.detail, { pullResult: result });
    }
    return result;
  });
};

const validateBrowserImportArguments = (args) => {
  if (typeof args?.archivePath !== "string" || !path.isAbsolute(args.archivePath)) {
    return failure(
      "BAD_EXPORT_PATH",
      "archivePath must be an absolute file path inside the current workspace",
    );
  }
  const selection = validatePullArguments({
    maxFiles: args?.maxFiles,
    overwrite: args?.overwrite,
    paths: args?.paths,
  });
  if (!selection.ok) {
    return selection;
  }
  return selection.data.requestedPaths === null
    ? failure("BAD_PATHS", "paths is required for a browser export import")
    : selection;
};

const performBrowserImport = async (
  args,
  signal,
  destination,
  selection,
  archive,
) => {
  const previousManifest = readManifest(
    destination.data.directory,
    args.projectId,
  );
  if (!previousManifest.ok) {
    return previousManifest;
  }
  const parsed = parseBrowserExport(archive, {
    maxEntries: MAX_EXPORT_ENTRIES,
    maxEntryBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_PULL_BYTES,
    requestedPaths: selection.requestedPaths,
  });
  if (!parsed.ok) {
    return parsed;
  }
  const source = {
    id: "claude-design-browser-export",
    transport: "browser-zip",
    readOnly: true,
    archiveSha256: parsed.data.archiveSha256,
  };
  const transition = validateSourceTransition(
    previousManifest.data.entries,
    previousManifest.data.source,
    parsed.data.files,
    source,
  );
  if (!transition.ok) {
    return transition;
  }
  const importedAt = new Date().toISOString();
  const previousEntriesByPath = new Map(
    previousManifest.data.entries.map((entry) => [
      canonicalDestinationKey(entry.path),
      entry,
    ]),
  );
  const results = [];
  for (const file of parsed.data.files) {
    const cancelled = cancellationFailure(signal);
    if (cancelled) {
      results.push({ path: file.path, result: cancelled });
      continue;
    }
    const written = writeSnapshotFile(
      destination.data.directory,
      file.path,
      file,
      {
        overwrite: selection.overwrite,
        previousSha256: previousEntriesByPath.get(
          canonicalDestinationKey(file.path),
        )?.sha256,
      },
    );
    results.push({
      path: file.path,
      result: written.ok
        ? ok({
            path: file.path,
            localPath: written.data.localPath,
            bytes: file.bytes.length,
            sha256: file.sha256,
            contentType: file.contentType,
            binary: file.binary,
            unchanged: written.data.unchanged,
            updated: written.data.updated,
            forced: written.data.forced,
            pulledAt: importedAt,
          })
        : written,
    });
  }
  const written = results
    .filter((entry) => entry.result.ok)
    .map((entry) => entry.result.data);
  const errors = results
    .filter((entry) => !entry.result.ok)
    .map((entry) => ({
      path: entry.path,
      error: entry.result.error,
      detail: entry.result.detail,
    }));
  const manifestEntries = written.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    contentType: entry.contentType,
    binary: entry.binary,
    pulledAt: entry.pulledAt,
  }));
  const manifest = manifestEntries.length
    ? writeManifest(
        destination.data.directory,
        args.projectId,
        previousManifest.data.entries,
        previousManifest.data.fingerprint,
        manifestEntries,
        previousManifest.data.source,
        source,
      )
    : failure("MANIFEST_SKIPPED", "No browser-export files were written");
  if (!manifest.ok) {
    errors.push({
      path: MANIFEST_NAME,
      error: manifest.error,
      detail: manifest.detail,
    });
  }
  const data = {
    projectId: args.projectId,
    dir: destination.data.directory,
    archiveSha256: parsed.data.archiveSha256,
    availableCount: parsed.data.availableCount,
    count: written.length,
    source,
    written,
    errors,
    ...(manifest.ok ? { manifestPath: manifest.data } : {}),
  };
  return errors.length
    ? failure(
        written.length ? "PARTIAL_IMPORT" : "IMPORT_FAILED",
        "One or more browser-export files failed to import",
        data,
      )
    : ok(data);
};

const importBrowserExport = async (args, signal, sandboxRoot) => {
  const cancelled = cancellationFailure(signal);
  if (cancelled) {
    return cancelled;
  }
  const projectValidation = validateProjectId(args?.projectId);
  if (!projectValidation.ok) {
    return projectValidation;
  }
  const selection = validateBrowserImportArguments(args);
  if (!selection.ok) {
    return selection;
  }
  const archiveFile = await resolveWorkspaceFile(args.archivePath, sandboxRoot);
  if (!archiveFile.ok) {
    return archiveFile;
  }
  let archive;
  try {
    archive = readRegularFile(
      archiveFile.data.archivePath,
      MAX_EXPORT_ARCHIVE_BYTES,
    );
  } catch (error) {
    return failure(
      "EXPORT_READ_FAILED",
      `Could not read browser export: ${errorDetail(error)}`,
    );
  }
  const destination = await approveDestination(
    args?.dir,
    args.projectId,
    sandboxRoot,
    signal,
  );
  if (!destination.ok) {
    return destination;
  }
  if (isWithin(archiveFile.data.archivePath, destination.data.directory)) {
    return failure(
      "EXPORT_IN_SNAPSHOT",
      "Store the browser-export ZIP outside the managed snapshot directory",
    );
  }
  const lockKey = canonicalDestinationKey(destination.data.directory);
  return withPullLock(lockKey, async () => {
    const queuedCancellation = cancellationFailure(signal);
    if (queuedCancellation) {
      return queuedCancellation;
    }
    const lock = acquireSnapshotLock(destination.data.directory);
    if (!lock.ok) {
      return lock;
    }
    let result;
    let operationError;
    try {
      result = await performBrowserImport(
        args,
        signal,
        destination,
        selection.data,
        archive,
      );
    } catch (error) {
      operationError = error;
    }
    const released = releaseSnapshotLock(lock.data);
    if (operationError) {
      if (!released.ok) {
        throw new AggregateError(
          [operationError, new Error(released.detail)],
          "Browser export import and lock release both failed",
        );
      }
      throw operationError;
    }
    return released.ok
      ? result
      : failure(released.error, released.detail, { importResult: result });
  });
};

const doctor = async (signal, sandboxRoot) => {
  const checks = [];
  const source = {
    id: DESIGN_SOURCE.id,
    transport: DESIGN_SOURCE.transport,
    readOnly: DESIGN_SOURCE.capabilities.write === false,
    revisions: DESIGN_SOURCE.capabilities.revisions,
    remoteChecksums: DESIGN_SOURCE.capabilities.remoteChecksums,
  };
  const projects = await listProjects(signal);
  if (!projects.ok) {
    checks.push({
      name: "Claude Code and DesignSync",
      status: "FAIL",
      detail: `${projects.error}: ${projects.detail}`,
    });
    const guidance =
      projects.error === "DELEGATE_SPAWN_FAILED"
        ? "Install Claude Code or set CLAUDE_BIN to its native executable."
        : projects.error === "CLAUDE_SESSION_LIMIT"
          ? "Wait until the reported Claude session limit reset and retry, import an official browser-downloaded ZIP with design_import_browser_export, or abort. Do not continue from stale design source."
        : projects.error === "NEEDS_DESIGN_CONSENT"
          ? "Run /design consent in Claude Code."
          : projects.error === "NEEDS_DESIGN_LOGIN"
            ? "Run /design login in Claude Code (legacy builds: /design-login)."
            : "Check Claude Code login, design access, network policy, and the diagnostic detail.";
    return failure(projects.error, projects.detail, {
      checks,
      guidance,
      source,
    });
  }
  const projectCount = projects.data.projects.length;
  checks.push({
    name: "Claude Code and DesignSync",
    status: "OK",
    detail: "A validated raw DesignSync result was received",
  });
  checks.push({
    name: "Design projects",
    status: projectCount ? "OK" : "EMPTY",
    detail: `${projectCount} writable project(s) visible`,
  });
  const roots = await getAuthorizedRoots(sandboxRoot);
  checks.push({
    name: "Workspace roots",
    status: roots.length ? "OK" : "UNAVAILABLE",
    detail: roots.length
      ? `${roots.length} approved local root(s) available for design_pull`
      : "Restart after installing a bridge that advertises Codex sandbox metadata, or set DESIGN_BRIDGE_ALLOWED_ROOTS explicitly",
  });
  const guidance = projectCount
    ? "Ready. Paste a Claude Design link and ask Codex to fetch or implement it."
    : "Bridge access is working. Paste an exact Claude Design link; an empty list only means no writable projects were enumerated.";
  return ok({ checks, projectCount, guidance, source });
};

const TOOLS = [
  {
    name: "design_list_projects",
    title: "List Claude Design projects",
    description: "List the user's writable claude.ai Design projects.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "design_resolve_link",
    title: "Resolve a Claude Design link",
    description:
      "Resolve an exact https://claude.ai/design/p/<id>?file=<path> link locally.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A Claude Design project URL" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "design_get_project",
    title: "Get a Claude Design project",
    description: "Get metadata for one Claude Design project.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "design_list_files",
    title: "List Claude Design files",
    description: "List normalized paths in one Claude Design project.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "design_get_file",
    title: "Read a Claude Design file",
    description:
      "Fetch and hash the latest version of one design file. Small text is returned inline; use design_pull for large or binary files.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        path: {
          type: "string",
          description: "Normalized project-relative path",
        },
        refresh: {
          type: "boolean",
          default: true,
          description:
            "Freshness policy. Omit or pass true to read from Claude Design; false explicitly allows validated disk-cache reuse within DESIGN_BRIDGE_CACHE_TTL_MS.",
        },
      },
      required: ["projectId", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "design_pull",
    title: "Pull a Claude Design snapshot",
    description:
      "Fetch the latest selected design files, safely update the managed snapshot at <workspace>/.design/claude/<projectId>, and write a SHA-256 provenance manifest.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        dir: {
          type: "string",
          description:
            "Optional exact <workspace>/.design/claude/<projectId> directory; derived from trusted Codex metadata when omitted",
        },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PULL_FILES,
          uniqueItems: true,
          items: { type: "string" },
          description:
            "Specific project-relative files; prefer the path from a linked URL",
        },
        refresh: {
          type: "boolean",
          default: true,
          description:
            "Freshness policy. Omit or pass true to read from Claude Design; false explicitly allows validated disk-cache reuse within DESIGN_BRIDGE_CACHE_TTL_MS.",
        },
        overwrite: {
          type: "boolean",
          description:
            "Local-change policy. Omit or pass false to update only unmodified manifest-tracked files; true forces replacement of local changes.",
        },
        maxFiles: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PULL_FILES,
          default: MAX_PULL_FILES,
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "design_snapshot_status",
    title: "Check Claude Design snapshot status",
    description:
      "Compare an existing managed snapshot with its SHA-256 manifest without contacting Claude Design or creating directories.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        dir: {
          type: "string",
          description:
            "Optional exact <workspace>/.design/claude/<projectId> directory; derived from trusted Codex metadata when omitted",
        },
        maxEntries: {
          type: "integer",
          minimum: 1,
          maximum: MAX_STATUS_ENTRIES,
          default: MAX_STATUS_ENTRIES,
          description:
            "Maximum snapshot entries to inspect before failing closed",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "design_import_browser_export",
    title: "Import a Claude Design browser export",
    description:
      "Experimentally validate selected files from an official Claude Design ZIP downloaded into the workspace and safely materialize them with distinct browser-export provenance.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        archivePath: {
          type: "string",
          description:
            "Absolute path to an official Claude Design ZIP stored inside the current workspace but outside the managed snapshot",
        },
        dir: {
          type: "string",
          description:
            "Optional exact <workspace>/.design/claude/<projectId> directory; derived from trusted Codex metadata when omitted",
        },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PULL_FILES,
          uniqueItems: true,
          items: { type: "string" },
          description:
            "Exact project-relative files to import from the browser ZIP",
        },
        overwrite: {
          type: "boolean",
          description:
            "Local-change policy. Omit or pass false to preserve local changes; true forces replacement.",
        },
        maxFiles: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PULL_FILES,
          default: MAX_PULL_FILES,
        },
      },
      required: ["projectId", "archivePath", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "design_doctor",
    title: "Diagnose Claude Design access",
    description:
      "Verify Claude Code, raw DesignSync access, project visibility, workspace roots, and login/consent guidance.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const unexpectedArgument = (name, args) => {
  const properties = TOOL_BY_NAME.get(name)?.inputSchema?.properties ?? {};
  return Object.keys(args).find((key) => !Object.hasOwn(properties, key));
};

const callTool = (name, args, signal, sandboxRoot) => {
  switch (name) {
    case "design_list_projects":
      return listProjects(signal);
    case "design_resolve_link":
      return resolveDesignLink(args?.url);
    case "design_get_project":
      return getProject(args, signal);
    case "design_list_files":
      return listFiles(args, signal);
    case "design_get_file":
      return getFile(args, signal);
    case "design_pull":
      return pull(args, signal, sandboxRoot);
    case "design_snapshot_status":
      return snapshotStatus(args, signal, sandboxRoot);
    case "design_import_browser_export":
      return importBrowserExport(args, signal, sandboxRoot);
    case "design_doctor":
      return doctor(signal, sandboxRoot);
    default:
      return failure("UNKNOWN_TOOL", String(name));
  }
};

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

const toolResult = (result) => {
  const payload = result.ok
    ? result.data
    : {
        error: result.error,
        detail: result.detail,
        ...(result.data ? { data: result.data } : {}),
      };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: !result.ok,
  };
};

const handle = async (message) => {
  if (!isRecord(message) || message.jsonrpc !== "2.0") {
    const responseId =
      isRecord(message) && isValidMessageId(message.id) ? message.id : null;
    replyError(
      responseId,
      -32600,
      "Invalid JSON-RPC request",
    );
    return;
  }

  if (Object.hasOwn(message, "id") && !isValidMessageId(message.id)) {
    replyError(null, -32600, "JSON-RPC id must be a string or safe integer");
    return;
  }

  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingClientRequests.get(String(message.id));
    if (pending) {
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (hasResult === hasError || (hasError && !isRecord(message.error))) {
        process.stderr.write(
          "[claude-design-bridge] ignored an invalid JSON-RPC client response\n",
        );
        return;
      }
      pendingClientRequests.delete(String(message.id));
      pending.resolve(message);
    }
    return;
  }

  const { id, method, params } = message ?? {};
  if (typeof method !== "string") {
    replyError(id ?? null, -32600, "JSON-RPC method must be a string");
    return;
  }
  if (id !== undefined && activeInboundRequests.has(id)) {
    replyError(id, -32600, `JSON-RPC id ${String(id)} is already active`);
    return;
  }
  if (method === "initialize") {
    if (id === undefined) {
      return;
    }
    if (serverInitialized) {
      replyError(id ?? null, -32600, "MCP server is already initialized");
      return;
    }
    if (
      !isRecord(params) ||
      typeof params.protocolVersion !== "string" ||
      !isRecord(params.capabilities) ||
      !isRecord(params.clientInfo) ||
      typeof params.clientInfo.name !== "string" ||
      typeof params.clientInfo.version !== "string"
    ) {
      replyError(
        id,
        -32602,
        "initialize requires protocolVersion, capabilities, and clientInfo",
      );
      return;
    }
    clientCapabilities = params.capabilities;
    mcpRootsPromise = null;
    serverInitialized = true;
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        experimental: { [CODEX_SANDBOX_META]: {} },
      },
      serverInfo: SERVER_INFO,
      instructions:
        "Remote-read-only Claude Design bridge. Pull linked files into the dedicated local snapshot before implementing them.",
    });
    return;
  }
  if (method === "notifications/initialized") {
    if (id === undefined && serverInitialized) {
      clientReady = true;
    } else if (id !== undefined) {
      replyError(
        id,
        -32600,
        "notifications/initialized must be a notification",
      );
    }
    return;
  }
  if (method === "ping" && id !== undefined) {
    reply(id, {});
    return;
  }
  if (!serverInitialized || !clientReady) {
    if (id !== undefined && id !== null) {
      replyError(
        id,
        -32002,
        "MCP initialization must complete before this request",
      );
    }
    return;
  }
  if (method === "notifications/roots/list_changed") {
    if (id !== undefined) {
      replyError(id, -32600, `${method} must be a notification`);
      return;
    }
    mcpRootsPromise = null;
    return;
  }
  if (method === "notifications/cancelled") {
    if (id !== undefined) {
      replyError(id, -32600, `${method} must be a notification`);
      return;
    }
    const requestId = params?.requestId;
    if (isValidMessageId(requestId)) {
      activeInboundRequests.get(requestId)?.abort();
    }
    return;
  }
  if (id === undefined) {
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    if (!isRecord(params) || typeof params.name !== "string") {
      replyError(
        id ?? null,
        -32602,
        "tools/call requires a tool name and object params",
      );
      return;
    }
    const name = params.name;
    const args = params.arguments ?? {};
    if (!isRecord(args)) {
      replyError(id ?? null, -32602, "tools/call arguments must be an object");
      return;
    }
    if (!TOOL_NAMES.has(name)) {
      replyError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const unexpected = unexpectedArgument(name, args);
    if (unexpected !== undefined) {
      replyError(id, -32602, `Unexpected argument for ${name}: ${unexpected}`);
      return;
    }
    if (activeInboundRequests.size >= MAX_ACTIVE_INBOUND_REQUESTS) {
      replyError(id, -32000, "Too many bridge requests are active");
      return;
    }
    const controller = new AbortController();
    activeInboundRequests.set(id, controller);
    try {
      const sandboxRoot = sandboxRootFromMeta(params._meta);
      const result = await callTool(name, args, controller.signal, sandboxRoot);
      if (!controller.signal.aborted) {
        reply(id, toolResult(result));
      }
    } catch (error) {
      process.stderr.write(
        `[claude-design-bridge] tool handler failed: ${errorDetail(error)}\n`,
      );
      if (!controller.signal.aborted) {
        replyError(id, -32603, "Internal error");
      }
    } finally {
      activeInboundRequests.delete(id);
    }
    return;
  }
  if (id !== undefined && id !== null) {
    replyError(id, -32601, `Method not found: ${String(method)}`);
  }
};

/**
 * Start the newline-delimited JSON-RPC MCP server on the current process streams.
 *
 * @returns {void}
 */
export const startServer = () => {
  pruneCache();
  const cachePruneTimer = setInterval(pruneCache, CACHE_PRUNE_INTERVAL_MS);
  cachePruneTimer.unref();
  let incomingBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    incomingBuffer += chunk;
    let newlineIndex = incomingBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = incomingBuffer.slice(0, newlineIndex).trim();
      incomingBuffer = incomingBuffer.slice(newlineIndex + 1);
      newlineIndex = incomingBuffer.indexOf("\n");
      if (!line) {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_INCOMING_MESSAGE_BYTES) {
        replyError(
          null,
          -32700,
          "Incoming JSON-RPC message exceeded the configured size limit",
        );
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        replyError(null, -32700, `Invalid JSON: ${errorDetail(error)}`);
        continue;
      }
      Promise.resolve(handle(message)).catch((error) => {
        process.stderr.write(
          `[claude-design-bridge] handler error: ${errorDetail(error)}\n`,
        );
      });
    }
    if (
      Buffer.byteLength(incomingBuffer, "utf8") > MAX_INCOMING_MESSAGE_BYTES
    ) {
      replyError(
        null,
        -32700,
        "Incoming JSON-RPC message exceeded the configured size limit",
      );
      incomingBuffer = "";
    }
  });

  process.stdin.on("end", () => {
    for (const controller of activeInboundRequests.values()) {
      controller.abort();
    }
    activeInboundRequests.clear();
    for (const pending of pendingClientRequests.values()) {
      pending.resolve({ error: { message: "MCP client disconnected" } });
    }
    pendingClientRequests.clear();
  });

  process.stderr.write(
    `[claude-design-bridge] ready v${SERVER_INFO.version}\n`,
  );
};

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  startServer();
}
