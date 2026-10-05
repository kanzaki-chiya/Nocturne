import type { McpServerEntry } from "./types.js";

export interface McpValueOverview {
  name: string;
  kind: "literal" | "env" | "stored";
  value?: string | undefined;
  stored?: "set" | "missing" | undefined;
}

export interface McpServerOverview {
  id: string;
  origin: "app" | "user" | "project";
  editable: boolean;
  trusted: boolean;
  path: string;
  transport: "stdio" | "http";
  enabled: boolean;
  command?: string | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  env?: McpValueOverview[] | undefined;
  url?: string | undefined;
  headers?: McpValueOverview[] | undefined;
  startupTimeoutMs: number;
  callTimeoutMs: number;
}

export interface McpSaveInput {
  mode: "create" | "replace";
  id: string;
  config: McpServerEntry;
  secrets?: Record<string, string | null> | undefined;
  workspaceRoot?: string | undefined;
}

export type McpProbeInput = {
  workspaceRoot?: string | undefined;
} & (
  | { id: string; config?: never; secrets?: never }
  | {
      id?: never;
      config: McpServerEntry;
      secrets?: Record<string, string | null> | undefined;
      credentialServerId?: string | undefined;
    }
);

export interface McpProbeResult {
  ok: boolean;
  durationMs: number;
  serverInfo?: { name: string; version: string } | undefined;
  tools: { name: string; description?: string | undefined }[];
  error?:
    | {
        code:
          | "spawn_failed"
          | "startup_timeout"
          | "initialize_failed"
          | "mcp_secret_missing"
          | "connect_failed"
          | "http_status"
          | "auth_required"
          | "http_redirect";
        message: string;
      }
    | undefined;
  stderrTail?: string[] | undefined;
  httpStatus?: number | undefined;
}
