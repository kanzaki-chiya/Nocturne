/**
 * Rust 外壳与前端之间的线格式（docs/apps/desktop.md）。
 * 对应 src-tauri/src/backend.rs 的 BackendMessage 与 node.rs 的 NodeProbe。
 */

export type BackendMessage =
  { kind: "line"; line: string } | { kind: "closed"; code: number | null; stderr: string[] };

export type NodeSource = "env" | "bundled" | "path";

export type NodeStepStatus = "unset" | "not-bundled" | "missing" | "found" | "skipped";

export interface NodeProbeStep {
  source: NodeSource;
  status: NodeStepStatus;
  path: string | null;
}

export interface NodeProbe {
  required: string;
  steps: NodeProbeStep[];
  selected: {
    source: NodeSource;
    path: string;
    version: string | null;
    error: string | null;
  } | null;
  ok: boolean;
}
