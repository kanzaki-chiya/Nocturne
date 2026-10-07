/** 用户声明的外部 ACP agent（ADR-0049 §4）；项目层永不生效。 */
export interface ExternalAgentConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
  /** 不透明的 ACP mode id，Core 不解释其含义。 */
  mode?: string | undefined;
  /** 不透明的 ACP config id → option value。 */
  configOptions?: Record<string, string> | undefined;
  description?: string | undefined;
  enabled: boolean;
}

export interface ResolvedExternalAgentConfig extends ExternalAgentConfig {
  origin: "app" | "user";
  path?: string | undefined;
}

export interface ExternalAgentOverview extends ResolvedExternalAgentConfig {
  editable: boolean;
}

export interface ExternalAgentsDescription {
  agents: ExternalAgentOverview[];
  warnings: string[];
}

export interface ExternalAgentSaveInput {
  mode: "create" | "replace";
  name: string;
  config: Omit<ExternalAgentConfig, "name">;
}

/** 已核实的 ACP 启动命令（ADR-0049 修订）；仅供界面填入，不自动启用、不强制逐项询问参数。 */
export const EXTERNAL_AGENT_PRESETS: readonly ExternalAgentConfig[] = [
  {
    name: "omp",
    command: "omp",
    args: ["--mode", "acp"],
    enabled: false,
    description: "omp ACP 子代理",
  },
  {
    name: "codex",
    command: "npx",
    args: ["@agentclientprotocol/codex-acp"],
    enabled: false,
    description: "Codex ACP 子代理",
  },
];

export type ExternalAgentProbeInput = { name: string } | { config: ExternalAgentConfig };

export interface ExternalAgentProbeResult {
  ok: boolean;
  durationMs: number;
  agentInfo?: { name: string; version: string; title?: string | undefined } | undefined;
  authMethods?: { id: string; name: string; description?: string | undefined }[] | undefined;
  configOptions: {
    id: string;
    name: string;
    description?: string | undefined;
    category?: string | undefined;
    currentValue: string;
    options: { value: string; name: string }[];
  }[];
  error?: { code: string; message: string } | undefined;
}
