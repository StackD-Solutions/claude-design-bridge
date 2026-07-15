import assert from "node:assert/strict";
import test from "node:test";

import { createZip } from "../fixtures/zip.mjs";
import { parseBrowserExport } from "../../plugins/claude-design-bridge/server/browser-export.mjs";

const options = {
  maxEntries: 20,
  maxEntryBytes: 1024,
  maxTotalBytes: 2048,
  requestedPaths: ["Screen.dc.html", "assets/icon.png"],
};

test("should extract selected browser-export files with hashes", () => {
  const archive = createZip([
    { path: "Screen.dc.html", bytes: "<main />" },
    { path: "assets/icon.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { path: "unused.txt", bytes: "unused" },
  ]);

  const result = parseBrowserExport(archive, options);

  assert.deepEqual(
    result.ok
      ? result.data.files.map((file) => ({
          path: file.path,
          contentType: file.contentType,
          binary: file.binary,
          text: file.binary ? null : file.bytes.toString("utf8"),
        }))
      : result,
    [
      {
        path: "Screen.dc.html",
        contentType: "text/html; charset=utf-8",
        binary: false,
        text: "<main />",
      },
      {
        path: "assets/icon.png",
        contentType: "image/png",
        binary: true,
        text: null,
      },
    ],
  );
});

test("should reject browser-export path traversal", () => {
  const result = parseBrowserExport(
    createZip([{ path: "../outside.html", bytes: "x" }]),
    { ...options, requestedPaths: ["outside.html"] },
  );

  assert.equal(result.error, "EXPORT_BAD_PATH");
});

test("should reject browser-export symbolic links", () => {
  const result = parseBrowserExport(
    createZip([
      {
        path: "link.html",
        bytes: "target.html",
        creatorSystem: 3,
        externalAttributes: 0o120777 << 16,
      },
    ]),
    { ...options, requestedPaths: ["link.html"] },
  );

  assert.equal(result.error, "EXPORT_SYMLINK");
});

test("should reject case-colliding browser-export paths", () => {
  const result = parseBrowserExport(
    createZip([
      { path: "Screen.html", bytes: "one" },
      { path: "screen.html", bytes: "two" },
    ]),
    { ...options, requestedPaths: ["Screen.html"] },
  );

  assert.equal(result.error, "EXPORT_PATH_CONFLICT");
});

test("should reject a browser-export CRC mismatch", () => {
  const result = parseBrowserExport(
    createZip([{ path: "Screen.html", bytes: "content", crc32: 7 }]),
    { ...options, requestedPaths: ["Screen.html"] },
  );

  assert.equal(result.error, "EXPORT_INTEGRITY_FAILED");
});

test("should report bounded available paths for a missing selection", () => {
  const result = parseBrowserExport(
    createZip([{ path: "Actual.html", bytes: "content" }]),
    { ...options, requestedPaths: ["Missing.html"] },
  );

  assert.deepEqual(
    { error: result.error, data: result.data },
    {
      error: "EXPORT_PATH_NOT_FOUND",
      data: { availableCount: 1, availablePaths: ["Actual.html"] },
    },
  );
});
