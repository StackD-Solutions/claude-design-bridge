import assert from "node:assert/strict";
import test from "node:test";

import {
  fileResultForTool,
  normalizeDesignPath,
  rawFileToBytes,
  resolveDesignLink,
} from "../../plugins/claude-design-bridge/server/design-bridge.mjs";

test("should normalize a project-relative design path", () => {
  assert.equal(
    normalizeDesignPath("./screens/Collapsible App.dc.html"),
    "screens/Collapsible App.dc.html",
  );
});

test("should normalize design paths to NFC", () => {
  assert.equal(
    normalizeDesignPath("screens/Cafe\u0301.html"),
    "screens/Caf\u00E9.html",
  );
});

test("should reject design path traversal", () => {
  assert.equal(normalizeDesignPath("../outside.html"), null);
});

test("should reject an absolute Windows design path", () => {
  assert.equal(normalizeDesignPath("C:\\outside.html"), null);
});

test("should reject Windows alternate data stream syntax", () => {
  assert.equal(normalizeDesignPath("screen.html:secret"), null);
});

test("should reject bidirectional, zero-width, and BOM characters", () => {
  assert.deepEqual(
    [
      "screens/reversed\u202Ehtml",
      "screens/zero\u200Bwidth.html",
      "screens/bom\uFEFF.html",
      "screens/arabic-mark\u061C.html",
    ].map(normalizeDesignPath),
    [null, null, null, null],
  );
});

test("should reject extended Windows reserved names", () => {
  assert.deepEqual(
    [
      "CLOCK$.txt",
      "CONIN$.html",
      "CONOUT$.html",
      "COM0.css",
      "LPT0.json",
      "COM¹.txt",
      "LPT².txt",
    ].map(normalizeDesignPath),
    [null, null, null, null, null, null, null],
  );
});

test("should reject Windows 8.3 short-name-shaped segments", () => {
  assert.deepEqual(
    ["COMPON~1.HTML", "screens/SETTIN~9.CSS", "PROGRA~12"].map(
      normalizeDesignPath,
    ),
    [null, null, null],
  );
});

test("should reject Unicode trailing whitespace", () => {
  assert.deepEqual(
    ["screen.html\u00A0", "screens/name\u2003"].map(normalizeDesignPath),
    [null, null],
  );
});

test("should resolve the exact linked design file", () => {
  assert.deepEqual(
    resolveDesignLink(
      "https://claude.ai/design/p/project-1?file=Collapsible+App.dc.html",
    ).data,
    {
      projectId: "project-1",
      path: "Collapsible App.dc.html",
      canonicalUrl:
        "https://claude.ai/design/p/project-1?file=Collapsible+App.dc.html",
    },
  );
});

test("should reject a lookalike design host", () => {
  assert.equal(
    resolveDesignLink("https://attacker.example/design/p/project-1").error,
    "BAD_LINK",
  );
});

test("should preserve UTF-8 file bytes", () => {
  const result = rawFileToBytes(
    {
      content: "<p>Hé</p>",
      contentType: "text/html",
      isBase64: false,
      truncated: false,
    },
    "screen.html",
  );

  assert.equal(result.data.bytes.toString("utf8"), "<p>Hé</p>");
});

test("should decode base64 binary file bytes", () => {
  const result = rawFileToBytes(
    {
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      contentType: "application/octet-stream",
      isBase64: true,
      truncated: false,
    },
    "asset.bin",
  );

  assert.deepEqual([...result.data.bytes], [0, 1, 2, 255]);
});

test("should reject a truncated DesignSync file", () => {
  assert.equal(
    rawFileToBytes({ content: "partial", truncated: true }, "screen.html")
      .error,
    "FILE_TRUNCATED",
  );
});

test("should reject invalid base64 file content", () => {
  assert.equal(
    rawFileToBytes(
      {
        content: "not base64!",
        contentType: "application/octet-stream",
        isBase64: true,
        truncated: false,
      },
      "asset.bin",
    ).error,
    "BAD_RESULT",
  );
});

test("should reject a missing truncation status", () => {
  assert.equal(
    rawFileToBytes(
      { content: "complete?", contentType: "text/plain", isBase64: false },
      "screen.txt",
    ).error,
    "BAD_RESULT",
  );
});

test("should reject a missing base64 status", () => {
  assert.equal(
    rawFileToBytes(
      { content: "complete?", contentType: "text/plain", truncated: false },
      "screen.txt",
    ).error,
    "BAD_RESULT",
  );
});

test("should reject a missing content type", () => {
  assert.equal(
    rawFileToBytes(
      { content: "complete?", isBase64: false, truncated: false },
      "screen.txt",
    ).error,
    "BAD_RESULT",
  );
});

test("should omit large text from MCP context", () => {
  const bytes = Buffer.alloc(65, "x");
  const result = fileResultForTool(
    "project-1",
    {
      path: "large.html",
      bytes,
      sha256: "digest",
      contentType: "text/html",
      binary: false,
      fromCache: false,
    },
    64,
  );

  assert.equal(result.contentOmitted, true);
});

test("should omit binary content from MCP context", () => {
  const result = fileResultForTool(
    "project-1",
    {
      path: "asset.png",
      bytes: Buffer.from([1]),
      sha256: "digest",
      contentType: "image/png",
      binary: true,
      fromCache: false,
    },
    64,
  );

  assert.equal(result.contentOmitted, true);
});

test("should omit all text when inline content is disabled", () => {
  const result = fileResultForTool(
    "project-1",
    {
      path: "empty.txt",
      bytes: Buffer.alloc(0),
      sha256: "digest",
      contentType: "text/plain",
      binary: false,
      fromCache: false,
    },
    0,
  );

  assert.equal(result.contentOmitted, true);
});
