// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { normalizeDesignPath } from "./design-validation.mjs";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_COMMENT_BYTES = 0xffff;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DIRECTORY_MODE = 0o040000;
const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const ok = (data) => ({ ok: true, data });
const failure = (error, detail, data) => ({
  ok: false,
  error,
  detail,
  ...(data ? { data } : {}),
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalPath = (value) =>
  value.normalize("NFC").toLocaleLowerCase("en-US");

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

const findEndOfCentralDirectory = (archive) => {
  const minimumOffset = Math.max(0, archive.length - 22 - MAX_COMMENT_BYTES);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  return -1;
};

const contentMetadata = (filePath, bytes) => {
  const extensionIndex = filePath.lastIndexOf(".");
  const extension =
    extensionIndex >= 0 ? filePath.slice(extensionIndex).toLowerCase() : "";
  const contentType = CONTENT_TYPES.get(extension);
  const textualType =
    contentType?.startsWith("text/") === true ||
    contentType?.includes("json") === true ||
    contentType?.includes("svg+xml") === true;
  const binary = textualType ? false : !isUtf8(bytes);
  return {
    binary,
    contentType:
      contentType || (binary ? "application/octet-stream" : "text/plain; charset=utf-8"),
  };
};

const validatePathSet = (paths) => {
  const files = new Set();
  const parents = new Set();
  for (const filePath of paths) {
    const key = canonicalPath(filePath);
    if (files.has(key) || parents.has(key)) {
      return failure(
        "EXPORT_PATH_CONFLICT",
        `Browser export contains a conflicting path: ${filePath}`,
      );
    }
    files.add(key);
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = canonicalPath(segments.slice(0, index).join("/"));
      if (files.has(parent)) {
        return failure(
          "EXPORT_PATH_CONFLICT",
          `Browser export contains a file/directory collision: ${filePath}`,
        );
      }
      parents.add(parent);
    }
  }
  return ok(paths);
};

const decodeEntryName = (bytes, flags) => {
  const ascii = bytes.every((value) => value < 0x80);
  if ((!ascii && (flags & UTF8_FLAG) === 0) || !isUtf8(bytes)) {
    return failure(
      "EXPORT_ENCODING_UNSUPPORTED",
      "Browser export contains a filename that is not UTF-8",
    );
  }
  return ok(bytes.toString("utf8"));
};

const readCentralDirectory = (archive, options) => {
  if (archive.length < 22) {
    return failure("EXPORT_INVALID", "Browser export is not a valid ZIP archive");
  }
  const endOffset = findEndOfCentralDirectory(archive);
  if (endOffset < 0) {
    return failure(
      "EXPORT_INVALID",
      "Browser export ZIP central directory was not found",
    );
  }
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralBytes = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentBytes = archive.readUInt16LE(endOffset + 20);
  if (endOffset + 22 + commentBytes !== archive.length) {
    return failure("EXPORT_INVALID", "Browser export ZIP has trailing data");
  }
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralBytes === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL
  ) {
    return failure(
      "EXPORT_ZIP_UNSUPPORTED",
      "Browser export must be a single-disk non-ZIP64 archive",
    );
  }
  if (totalEntries < 1 || totalEntries > options.maxEntries) {
    return failure(
      "EXPORT_ENTRY_LIMIT",
      `Browser export contains ${totalEntries} entries; limit is ${options.maxEntries}`,
    );
  }
  if (centralOffset + centralBytes !== endOffset) {
    return failure("EXPORT_INVALID", "Browser export ZIP directory is malformed");
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      return failure("EXPORT_INVALID", "Browser export ZIP entry is malformed");
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc32 = archive.readUInt32LE(offset + 16);
    const compressedBytes = archive.readUInt32LE(offset + 20);
    const uncompressedBytes = archive.readUInt32LE(offset + 24);
    const nameBytes = archive.readUInt16LE(offset + 28);
    const extraBytes = archive.readUInt16LE(offset + 30);
    const entryCommentBytes = archive.readUInt16LE(offset + 32);
    const startDisk = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (entryEnd > endOffset) {
      return failure("EXPORT_INVALID", "Browser export ZIP entry exceeds its directory");
    }
    if (
      compressedBytes === ZIP64_SENTINEL ||
      uncompressedBytes === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL ||
      startDisk !== 0
    ) {
      return failure("EXPORT_ZIP_UNSUPPORTED", "Browser export contains a ZIP64 entry");
    }
    if ((flags & ENCRYPTED_FLAG) !== 0 || ![0, 8].includes(method)) {
      return failure(
        "EXPORT_ZIP_UNSUPPORTED",
        "Browser export contains encryption or unsupported compression",
      );
    }
    const decodedName = decodeEntryName(
      archive.subarray(offset + 46, offset + 46 + nameBytes),
      flags,
    );
    if (!decodedName.ok) {
      return decodedName;
    }
    const directory = decodedName.data.endsWith("/");
    const normalized = normalizeDesignPath(
      directory ? decodedName.data.slice(0, -1) : decodedName.data,
    );
    if (!normalized) {
      return failure(
        "EXPORT_BAD_PATH",
        `Browser export contains an unsafe path: ${decodedName.data}`,
      );
    }
    const creatorSystem = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & FILE_TYPE_MASK;
    if (creatorSystem === 3 && fileType === SYMLINK_MODE) {
      return failure(
        "EXPORT_SYMLINK",
        `Browser export contains a symbolic link: ${normalized}`,
      );
    }
    if (directory || (creatorSystem === 3 && fileType === DIRECTORY_MODE)) {
      offset = entryEnd;
      continue;
    }
    entries.push({
      compressedBytes,
      expectedCrc32,
      flags,
      dataLimit: centralOffset,
      localOffset,
      method,
      nameBytes: archive.subarray(offset + 46, offset + 46 + nameBytes),
      path: normalized,
      uncompressedBytes,
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) {
    return failure("EXPORT_INVALID", "Browser export ZIP directory size is inconsistent");
  }
  const validatedPaths = validatePathSet(entries.map((entry) => entry.path));
  return validatedPaths.ok ? ok(entries) : validatedPaths;
};

const extractEntry = (archive, entry, options) => {
  if (entry.uncompressedBytes > options.maxEntryBytes) {
    return failure(
      "EXPORT_FILE_TOO_LARGE",
      `${entry.path} is ${entry.uncompressedBytes} bytes; limit is ${options.maxEntryBytes}`,
    );
  }
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    return failure("EXPORT_INVALID", `Browser export local entry is invalid: ${entry.path}`);
  }
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  const nameBytes = archive.readUInt16LE(offset + 26);
  const extraBytes = archive.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameBytes + extraBytes;
  const dataEnd = dataStart + entry.compressedBytes;
  if (
    flags !== entry.flags ||
    method !== entry.method ||
    dataEnd > entry.dataLimit ||
    !archive.subarray(nameStart, nameStart + nameBytes).equals(entry.nameBytes)
  ) {
    return failure("EXPORT_INVALID", `Browser export entry identity changed: ${entry.path}`);
  }
  let bytes;
  try {
    const compressed = archive.subarray(dataStart, dataEnd);
    bytes =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: options.maxEntryBytes });
  } catch (error) {
    return failure(
      "EXPORT_DECOMPRESSION_FAILED",
      `Could not decompress ${entry.path}: ${String(error?.message || error)}`,
    );
  }
  if (bytes.length !== entry.uncompressedBytes || crc32(bytes) !== entry.expectedCrc32) {
    return failure(
      "EXPORT_INTEGRITY_FAILED",
      `Browser export integrity check failed for ${entry.path}`,
    );
  }
  return ok({
    ...contentMetadata(entry.path, bytes),
    bytes,
    path: entry.path,
    sha256: sha256(bytes),
  });
};

/**
 * Validate and extract selected files from an official Claude Design browser ZIP export.
 *
 * @param {Buffer} archive Complete bounded ZIP bytes read from an authorized workspace.
 * @param {object} options Import limits and exact normalized paths to select.
 * @param {number} options.maxEntries Maximum central-directory entries.
 * @param {number} options.maxEntryBytes Maximum uncompressed bytes per selected file.
 * @param {number} options.maxTotalBytes Maximum combined uncompressed selected bytes.
 * @param {Array<string>} options.requestedPaths Exact project-relative files to extract.
 * @returns {object} Structured extracted files or a fail-closed archive error.
 */
export const parseBrowserExport = (archive, options) => {
  if (!Buffer.isBuffer(archive)) {
    return failure("EXPORT_INVALID", "Browser export must be ZIP bytes");
  }
  const central = readCentralDirectory(archive, options);
  if (!central.ok) {
    return central;
  }
  const byPath = new Map(
    central.data.map((entry) => [canonicalPath(entry.path), entry]),
  );
  const missing = options.requestedPaths.filter(
    (filePath) => !byPath.has(canonicalPath(filePath)),
  );
  if (missing.length) {
    return failure(
      "EXPORT_PATH_NOT_FOUND",
      `Browser export does not contain: ${missing.join(", ")}`,
      {
        availableCount: central.data.length,
        availablePaths: central.data.slice(0, 50).map((entry) => entry.path),
      },
    );
  }
  const files = [];
  let totalBytes = 0;
  for (const requestedPath of options.requestedPaths) {
    const extracted = extractEntry(
      archive,
      byPath.get(canonicalPath(requestedPath)),
      options,
    );
    if (!extracted.ok) {
      return extracted;
    }
    totalBytes += extracted.data.bytes.length;
    if (totalBytes > options.maxTotalBytes) {
      return failure(
        "EXPORT_TOO_LARGE",
        `Selected browser-export files exceed ${options.maxTotalBytes} bytes`,
      );
    }
    files.push(extracted.data);
  }
  return ok({
    archiveSha256: sha256(archive),
    availableCount: central.data.length,
    files,
  });
};
