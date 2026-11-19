import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DocPluginError } from "./errors.js";

export function assertAbsolutePath(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DocPluginError("invalid_argument", `${fieldName} must be a non-empty absolute path.`);
  }
  if (!path.isAbsolute(value)) {
    throw new DocPluginError(
      "invalid_argument",
      `${fieldName} must be an absolute path, received: ${value}`,
    );
  }
  return path.resolve(value);
}

export function assertSourceExists(filePath: string, fieldName = "path"): void {
  if (!existsSync(filePath)) {
    throw new DocPluginError("file_not_found", `${fieldName} does not exist: ${filePath}`);
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new DocPluginError("invalid_argument", `${fieldName} is not a file: ${filePath}`);
  }
}

export function assertOutputWritable(outputPath: string, overwrite: boolean | undefined): void {
  if (existsSync(outputPath) && overwrite !== true) {
    throw new DocPluginError(
      "file_exists",
      `Target file already exists: ${outputPath}. Pass overwrite: true to replace it.`,
    );
  }
}

export function assertNonEmptyFileProduced(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new DocPluginError("output_missing", `Expected output file was not created: ${filePath}`);
  }
  const st = statSync(filePath);
  if (!st.isFile() || st.size === 0) {
    throw new DocPluginError("output_missing", `Output file is empty: ${filePath}`);
  }
}

export function toFileUrl(absPath: string): string {
  return pathToFileURL(path.resolve(absPath)).href;
}

/**
 * Parse 1-based page selection like "1", "1-3", "1,3,5-7".
 * Returns deduplicated list preserving order.
 */
export function parsePageRange(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new DocPluginError(
      "invalid_argument",
      'pages must be a string such as "1", "1-3", or "1,3,5-7".',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const result: number[] = [];
  const seen = new Set<number>();
  const parts = trimmed.split(",");
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) {
      throw new DocPluginError("invalid_argument", `Invalid pages expression: "${raw}"`);
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new DocPluginError("invalid_argument", `Invalid page range "${part}" in "${raw}"`);
      }
      if (end - start > 500) {
        throw new DocPluginError("invalid_argument", `Page range "${part}" is too large.`);
      }
      for (let p = start; p <= end; p++) {
        if (!seen.has(p)) {
          seen.add(p);
          result.push(p);
        }
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      const page = Number(part);
      if (!Number.isInteger(page) || page < 1) {
        throw new DocPluginError("invalid_argument", `Page number must be >= 1, got "${part}"`);
      }
      if (!seen.has(page)) {
        seen.add(page);
        result.push(page);
      }
      continue;
    }
    throw new DocPluginError("invalid_argument", `Invalid page token "${part}" in "${raw}"`);
  }
  return result;
}
