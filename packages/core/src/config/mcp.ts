import { z } from "zod";
import type { Platform } from "../platform/index.js";
import type {
  McpSaveInput,
  McpServerEntry,
  McpServerOverview,
  McpValue,
} from "../protocol/index.js";
import type { CredentialStore, ResolvedConfig } from "./types.js";
import { enqueueConfigWrite, writeJsonAtomic } from "./files.js";
import { MCP_ID, mcpEntrySchema } from "./schema.js";

export class McpSettingsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "McpSettingsError";
  }
}

export const mcpCredentialId = (id: string, name: string, entry: McpServerEntry): string =>
  `mcp/${id}/${entry.type === "http" ? name.toLowerCase() : name}`;
export const mcpValues = (entry: McpServerEntry): Record<string, McpValue> =>
  (entry.type === "http" ? entry.headers : entry.env) ?? {};

export function validateMcpEntry(raw: unknown): McpServerEntry {
  const parsed = mcpEntrySchema(true).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const branch = parsed.error.issues.flatMap((i) =>
      i.code === "invalid_union"
        ? (i.errors[
            typeof raw === "object" && raw !== null && "type" in raw && raw.type === "http" ? 1 : 0
          ] ?? [])
        : [i],
    );
    const detail = branch.find((i) => i.path.length > 0) ?? issue;
    throw new McpSettingsError(
      String(detail?.path[0] ?? "config"),
      "服务器字段无效，请检查类型、地址、命令和超时",
    );
  }
  const values = mcpValues(parsed.data);
  const names = new Set<string>();
  for (const name of Object.keys(values)) {
    if (
      !(
        parsed.data.type === "http" ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/
      ).test(name)
    )
      throw new McpSettingsError(
        parsed.data.type === "http" ? "headers" : "env",
        "变量名或请求头名无效",
      );
    const normalized = parsed.data.type === "http" ? name.toLowerCase() : name;
    if (names.has(normalized)) throw new McpSettingsError("headers", "请求头名重复");
    names.add(normalized);
    const value = values[name];
    if (
      typeof value === "string" &&
      (/key|token|secret|password|authorization/i.test(name) ||
        /^(sk-|ghp_|ntn_|Bearer\s)/i.test(value)) &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
    )
      throw new McpSettingsError(
        parsed.data.type === "http" ? "headers" : "env",
        "密钥请保存到凭据库或引用环境变量",
      );
  }
  return parsed.data;
}

export async function loadMcpStore(platform: Platform, home: string, credentials: CredentialStore) {
  const path = platform.paths.join(home, "mcp.json");
  let servers: Record<string, McpServerEntry> = {};
  const warnings: string[] = [];
  if (await platform.fs.exists(path)) {
    try {
      const raw: unknown = JSON.parse(await platform.fs.readTextFile(path));
      const file = z
        .object({ version: z.literal(1), servers: z.record(z.string(), z.unknown()) })
        .parse(raw);
      for (const [id, entry] of Object.entries(file.servers)) {
        try {
          if (!MCP_ID.test(id)) throw new Error("id");
          servers[id] = validateMcpEntry(entry);
        } catch {
          warnings.push(`mcp_config_invalid：${path} 中服务器 ${id} 无效，已忽略`);
        }
      }
    } catch {
      warnings.push(`mcp_config_invalid：${path} 损坏或版本不符，已忽略`);
    }
  }
  let pending: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = pending.then(() => enqueueConfigWrite(platform.fs, task));
    pending = run.catch(() => undefined);
    return run;
  }
  async function write(next: Record<string, McpServerEntry>, changes: Map<string, string | null>) {
    const previous = new Map<string, string | undefined>();
    try {
      for (const [key, value] of changes) {
        previous.set(key, await credentials.get(key));
        if (value === null) await credentials.delete(key);
        else await credentials.set(key, value);
      }
      await writeJsonAtomic(
        platform.fs,
        platform.paths,
        path,
        { version: 1, servers: next },
        { dirMode: 0o700 },
      );
      servers = next;
    } catch {
      let rollbackFailed = false;
      for (const [key, value] of previous) {
        try {
          if (value === undefined) await credentials.delete(key);
          else await credentials.set(key, value);
        } catch {
          rollbackFailed = true;
        }
      }
      throw new McpSettingsError(
        "config",
        rollbackFailed
          ? "MCP 保存失败，凭据恢复未完成，请重新设置凭据"
          : "MCP 保存失败，配置未更新",
      );
    }
  }
  function requireApp(id: string, resolved: ResolvedConfig) {
    if (!servers[id] || resolved.mcpServers.find((s) => s.name === id)?.origin !== "app")
      throw new McpSettingsError("id", "只能修改程序管理的服务器");
  }
  return {
    warnings,
    fields: () => ({ mcp: { servers } }),
    async save(input: McpSaveInput, resolved: ResolvedConfig) {
      return enqueue(async () => {
        if (!MCP_ID.test(input.id))
          throw new McpSettingsError("id", "名称须为 1–32 个字母、数字、下划线或连字符");
        if (input.mode === "create") {
          if (
            [...Object.keys(servers), ...resolved.mcpServers.map((s) => s.name)].some(
              (id) => id.toLowerCase() === input.id.toLowerCase(),
            )
          )
            throw new McpSettingsError("id", "服务器名称已存在");
        } else requireApp(input.id, resolved);
        const entry = validateMcpEntry(input.config);
        const values = mcpValues(entry);
        if (
          credentials.backend() === "none" &&
          Object.values(values).some((v) => typeof v !== "string")
        )
          throw new McpSettingsError("secrets", "系统凭据后端不可用，请引用环境变量");
        const changes = new Map<string, string | null>();
        const kept = new Set(
          Object.entries(values)
            .filter(([, v]) => typeof v !== "string")
            .map(([name]) => mcpCredentialId(input.id, name, entry)),
        );
        for (const [name, value] of Object.entries(input.secrets ?? {})) {
          const key = mcpCredentialId(input.id, name, entry);
          if (!kept.has(key) && value !== null)
            throw new McpSettingsError("secrets", "凭据必须对应 stored 字段");
          changes.set(key, value);
        }
        const old = servers[input.id];
        if (old)
          for (const [name, value] of Object.entries(mcpValues(old))) {
            const key = mcpCredentialId(input.id, name, old);
            if (typeof value !== "string" && !kept.has(key)) changes.set(key, null);
          }
        await write({ ...servers, [input.id]: entry }, changes);
      });
    },
    async remove(id: string, resolved: ResolvedConfig) {
      return enqueue(async () => {
        requireApp(id, resolved);
        const old = servers[id];
        const next = Object.fromEntries(Object.entries(servers).filter(([name]) => name !== id));
        const changes = new Map<string, string | null>();
        if (old)
          for (const [name, value] of Object.entries(mcpValues(old)))
            if (typeof value !== "string") changes.set(mcpCredentialId(id, name, old), null);
        await write(next, changes);
      });
    },
    async enabled(id: string, enabled: boolean, resolved: ResolvedConfig) {
      return enqueue(async () => {
        requireApp(id, resolved);
        if (typeof enabled !== "boolean")
          throw new McpSettingsError("enabled", "启用状态必须是布尔值");
        await write({ ...servers, [id]: { ...servers[id], enabled } }, new Map());
      });
    },
  };
}

export function describeMcp(
  resolved: ResolvedConfig,
  home: string,
  workspace: string | undefined,
  credentials: CredentialStore,
  platform: Platform,
): McpServerOverview[] {
  return resolved.mcpServers.map((s) => {
    const values = Object.entries(mcpValues(s.entry)).map(([name, value]) =>
      typeof value !== "string"
        ? {
            name,
            kind: "stored" as const,
            stored: credentials.has(mcpCredentialId(s.name, name, s.entry))
              ? ("set" as const)
              : ("missing" as const),
          }
        : {
            name,
            kind: /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
              ? ("env" as const)
              : ("literal" as const),
            value,
          },
    );
    return {
      id: s.name,
      origin: s.origin,
      editable: s.origin === "app",
      trusted: true,
      path: platform.paths.join(
        s.origin === "project" ? platform.paths.join(workspace ?? "", ".nocturne") : home,
        s.origin === "app" ? "mcp.json" : "config.json",
      ),
      transport: s.entry.type ?? "stdio",
      enabled: s.entry.enabled !== false,
      startupTimeoutMs: s.entry.startupTimeoutMs ?? 15000,
      callTimeoutMs: s.entry.callTimeoutMs ?? 60000,
      ...(s.entry.type === "http"
        ? { url: s.entry.url, headers: values }
        : { command: s.entry.command, args: s.entry.args ?? [], cwd: s.entry.cwd, env: values }),
    };
  });
}
