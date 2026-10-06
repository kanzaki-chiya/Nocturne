import type { ExternalAgentConfig } from "./types.js";

/** 已核实的 ACP 启动命令（ADR-0049 修订）；仅供选择，不自动启用。 */
export const EXTERNAL_AGENT_PRESETS: readonly ExternalAgentConfig[] = [
  { name: "omp", command: "omp", args: ["--mode", "acp"], enabled: false },
  {
    name: "codex",
    command: "npx",
    args: ["@agentclientprotocol/codex-acp"],
    enabled: false,
  },
];
