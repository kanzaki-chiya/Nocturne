import { z } from "zod";
import type { Platform } from "../platform/index.js";
import type {
  ExternalAgentConfig,
  ExternalAgentOverview,
  ExternalAgentSaveInput,
  ResolvedConfig,
} from "./types.js";
import { enqueueConfigWrite, writeJsonAtomic } from "./files.js";
import { externalAgentSchema } from "./schema.js";

export { EXTERNAL_AGENT_PRESETS } from "../protocol/external-agents.js";

export class ExternalAgentSettingsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalAgentSettingsError";
  }
}

export function validateExternalAgentConfig(raw: unknown): ExternalAgentConfig {
  const parsed = externalAgentSchema.safeParse(raw);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "config");
    throw new ExternalAgentSettingsError(
      field,
      field === "name"
        ? "名称只能包含小写字母、数字和连字符，且不能为空"
        : "外部 agent 字段无效，请检查命令、参数、环境变量与会话配置项",
    );
  }
  return parsed.data;
}

/** 程序层按条目降级；修改与其他机器维护文件共用配置写入队列。 */
export async function loadExternalAgentStore(platform: Platform, home: string) {
  const path = platform.paths.join(home, "external-agents.json");
  let agents: ExternalAgentConfig[] = [];
  const warnings: string[] = [];
  if (await platform.fs.exists(path)) {
    try {
      const raw: unknown = JSON.parse(await platform.fs.readTextFile(path));
      const file = z.object({ version: z.literal(1), agents: z.array(z.unknown()) }).parse(raw);
      const names = new Set<string>();
      for (const [index, entry] of file.agents.entries()) {
        try {
          const agent = validateExternalAgentConfig(entry);
          const key = agent.name.toLowerCase();
          if (names.has(key)) throw new Error("duplicate");
          names.add(key);
          agents.push(agent);
        } catch {
          warnings.push(
            `external_agent_config_invalid：${path} 中 agents.${index} 无效或重名，已忽略`,
          );
        }
      }
    } catch {
      warnings.push(`external_agent_config_invalid：${path} 损坏或版本不符，已忽略`);
    }
  }
  async function write(next: ExternalAgentConfig[]) {
    try {
      await writeJsonAtomic(
        platform.fs,
        platform.paths,
        path,
        { version: 1, agents: next },
        { dirMode: 0o700 },
      );
    } catch {
      throw new ExternalAgentSettingsError("config", "外部 agent 保存失败，配置未更新");
    }
    agents = next;
  }
  function requireApp(name: string, resolved: ResolvedConfig): number {
    const index = agents.findIndex((agent) => agent.name === name);
    if (index < 0 || resolved.externalAgents.find((agent) => agent.name === name)?.origin !== "app")
      throw new ExternalAgentSettingsError("name", "只能修改程序管理的外部 agent");
    return index;
  }
  return {
    warnings,
    fields: () => ({ externalAgents: agents }),
    save(input: ExternalAgentSaveInput, resolved: ResolvedConfig) {
      return enqueueConfigWrite(platform.fs, async () => {
        if (!z.enum(["create", "replace"]).safeParse(input.mode).success)
          throw new ExternalAgentSettingsError("mode", "保存模式必须是 create 或 replace");
        const entry = validateExternalAgentConfig({ ...input.config, name: input.name });
        if (input.mode === "create") {
          if (
            [...agents, ...resolved.externalAgents].some(
              (agent) => agent.name.toLowerCase() === entry.name.toLowerCase(),
            )
          )
            throw new ExternalAgentSettingsError("name", "外部 agent 名称已存在");
          await write([...agents, entry]);
        } else {
          const index = requireApp(input.name, resolved);
          const next = [...agents];
          next[index] = entry;
          await write(next);
        }
      });
    },
    remove(name: string, resolved: ResolvedConfig) {
      return enqueueConfigWrite(platform.fs, async () => {
        const index = requireApp(name, resolved);
        await write(agents.filter((_, i) => i !== index));
      });
    },
    enabled(name: string, enabled: boolean, resolved: ResolvedConfig) {
      return enqueueConfigWrite(platform.fs, async () => {
        const index = requireApp(name, resolved);
        if (typeof enabled !== "boolean")
          throw new ExternalAgentSettingsError("enabled", "启用状态必须是布尔值");
        await write(agents.map((agent, i) => (i === index ? { ...agent, enabled } : agent)));
      });
    },
  };
}

export function describeExternalAgents(resolved: ResolvedConfig): ExternalAgentOverview[] {
  return resolved.externalAgents.map((agent) => ({ ...agent, editable: agent.origin === "app" }));
}
