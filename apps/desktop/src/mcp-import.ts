import type { McpServerEntry, McpValueOverview } from "@nocturne/core/protocol";

export const secretName = (name: string): boolean =>
  /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/i.test(name);
export interface McpDraft {
  id: string;
  config: McpServerEntry;
  secrets: Record<string, string | null>;
}
export interface McpImportRow {
  id: string;
  draft?: McpDraft;
  notice: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseMcpImport(text: string, existing: readonly string[]): McpImportRow[] {
  const raw: unknown = JSON.parse(text);
  if (!object(raw)) throw new Error("请粘贴 JSON 对象");
  const entries = object(raw.mcpServers)
    ? raw.mcpServers
    : "command" in raw || "url" in raw
      ? { "": raw }
      : raw;
  const seen = new Set(existing.map((id) => id.toLowerCase()));
  return Object.entries(entries).map(([id, value]) => {
    if (!object(value)) return { id, notice: "条目无效，跳过" };
    if (value.type === "sse") return { id, notice: "旧版 SSE 传输暂不支持，跳过" };
    const http =
      value.type === "http" ||
      value.type === "streamable-http" ||
      (typeof value.url === "string" && !value.command);
    if (
      value.type &&
      (typeof value.type !== "string" || !["stdio", "http", "streamable-http"].includes(value.type))
    )
      return { id, notice: "传输暂不支持，跳过" };
    if (
      http
        ? ["command", "args", "env", "cwd"].some((key) => key in value)
        : ["url", "headers"].some((key) => key in value)
    )
      return { id, notice: "传输字段混写，跳过" };
    const config: McpServerEntry = http
      ? { type: "http", url: typeof value.url === "string" ? value.url : "" }
      : {
          type: "stdio",
          command: typeof value.command === "string" ? value.command : "",
          args: Array.isArray(value.args)
            ? value.args.filter((arg): arg is string => typeof arg === "string")
            : [],
        };
    if (!http && typeof value.cwd === "string") config.cwd = value.cwd;
    if (typeof value.enabled === "boolean") config.enabled = value.enabled;
    if (typeof value.startupTimeoutMs === "number")
      config.startupTimeoutMs = value.startupTimeoutMs;
    if (typeof value.callTimeoutMs === "number") config.callTimeoutMs = value.callTimeoutMs;
    const secrets: Record<string, string | null> = {};
    const source = http ? value.headers : value.env;
    const values: NonNullable<McpServerEntry["env"]> = {};
    if (object(source))
      for (const [name, val] of Object.entries(source)) {
        if (typeof val !== "string") continue;
        if (
          !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(val) &&
          (secretName(name) || /^(sk-|ghp_|ntn_|Bearer\s)/i.test(val))
        ) {
          values[name] = { stored: true };
          secrets[name] = val;
        } else values[name] = val;
      }
    if (http) config.headers = values;
    else config.env = values;
    const duplicate = seen.has(id.toLowerCase());
    seen.add(id.toLowerCase());
    const allowed = new Set([
      "type",
      "url",
      "headers",
      "command",
      "args",
      "env",
      "cwd",
      "enabled",
      "startupTimeoutMs",
      "callTimeoutMs",
    ]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    const notice = [
      duplicate ? "与已有服务器重名，确认时需要改名" : id ? "可导入" : "确认时填写名称",
      Object.keys(secrets).length ? "密钥将保存到凭据库" : "",
      http && (!Object.keys(values).some(secretName) || unknown.some((key) => /oauth/i.test(key)))
        ? "如需 OAuth 登录，本版本暂不支持"
        : "",
      unknown.length ? `未支持字段 ${unknown.join("、")}，不会导入` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return { id, draft: { id, config, secrets }, notice };
  });
}

export function overviewValues(
  rows: readonly McpValueOverview[],
): NonNullable<McpServerEntry["env"]> {
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      row.kind === "stored" ? { stored: true as const } : (row.value ?? ""),
    ]),
  );
}
