// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import path from "node:path";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const SPOOFING_CHARACTER_PATTERN =
  /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const WINDOWS_RESERVED_NAME_PATTERN =
  /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
const WINDOWS_INVALID_CHARACTER_PATTERN = /[<>:"|?*]/;
const WINDOWS_SHORT_NAME_PATTERN = /^[^~]{1,6}~[0-9]+(?:\.|$)/i;

/**
 * Determine whether a value is a safe Claude Design project identifier.
 *
 * @param {unknown} value Candidate identifier.
 * @returns {boolean} True for a bounded identifier accepted by the bridge.
 */
export const isValidProjectId = (value) =>
  typeof value === "string" && PROJECT_ID_PATTERN.test(value);

/**
 * Normalize a project-relative Claude Design path and reject unsafe filesystem syntax.
 *
 * @param {unknown} value Candidate project path.
 * @returns {string | null} Normalized slash-delimited path, or null when invalid.
 */
export const normalizeDesignPath = (value) => {
  if (typeof value !== "string" || !value || value.length > 2048) {
    return null;
  }
  const normalizedValue = value.normalize("NFC");
  if (
    normalizedValue.length > 2048 ||
    CONTROL_CHARACTER_PATTERN.test(normalizedValue) ||
    SPOOFING_CHARACTER_PATTERN.test(normalizedValue) ||
    path.posix.isAbsolute(normalizedValue) ||
    path.win32.isAbsolute(normalizedValue)
  ) {
    return null;
  }
  const normalized = normalizedValue.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        WINDOWS_INVALID_CHARACTER_PATTERN.test(segment) ||
        WINDOWS_RESERVED_NAME_PATTERN.test(segment) ||
        WINDOWS_SHORT_NAME_PATTERN.test(segment) ||
        /[.\s]$/u.test(segment),
    )
  ) {
    return null;
  }
  return segments.join("/");
};
