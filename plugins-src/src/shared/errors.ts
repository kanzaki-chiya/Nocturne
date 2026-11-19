import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type DocErrorCode =
  | "libreoffice_not_found"
  | "libreoffice_uno_unavailable"
  | "invalid_argument"
  | "file_not_found"
  | "file_exists"
  | "output_missing"
  | "timeout"
  | "engine_error";

export class DocPluginError extends Error {
  readonly code: DocErrorCode;

  constructor(code: DocErrorCode, message: string) {
    super(message);
    this.name = "DocPluginError";
    this.code = code;
  }
}

export function isDocPluginError(error: unknown): error is DocPluginError {
  return error instanceof DocPluginError;
}

export function toToolError(error: unknown): CallToolResult {
  if (isDocPluginError(error)) {
    return {
      isError: true,
      content: [{ type: "text", text: `[${error.code}] ${error.message}` }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `[engine_error] ${message}` }],
  };
}
