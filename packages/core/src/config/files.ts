/**
 * 配置文件读写原语（config.md 第 2、4 节）。
 * 解析失败统一为 ConfigError；写授权数据一律原子替换（临时文件 + rename）。
 */
import type { FileSystem, PathOps } from "../platform/index.js";
import { ConfigError } from "./errors.js";
import { parseConfigFile } from "./schema.js";
import type { ConfigFile } from "./types.js";

export type ConfigLayer = "user" | "project";

/**
 * 读取并校验一份配置文件。
 * - 文件不存在 → undefined；
 * - 读取失败 → ConfigError("config_unavailable")；
 * - 解析 / schema / 凭据字段失败 → ConfigError（调用方决定快速失败或忽略+警告）。
 */
export async function loadConfigFile(
  fs: FileSystem,
  path: string,
): Promise<ConfigFile | undefined> {
  if (!(await fs.exists(path))) return undefined;
  let text: string;
  try {
    text = await fs.readTextFile(path);
  } catch (e) {
    throw new ConfigError(
      "config_unavailable",
      `无法读取配置文件：${e instanceof Error ? e.message : String(e)}`,
      path,
      { cause: e },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(
      "config_invalid",
      `配置文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      path,
      { cause: e },
    );
  }
  return parseConfigFile(raw, path);
}

/** 原子写 JSON 文件：先写同目录临时文件再 rename（config.md 第 3、4 节） */
export async function writeJsonAtomic(
  fs: FileSystem,
  paths: PathOps,
  path: string,
  data: unknown,
): Promise<void> {
  await fs.mkdir(paths.dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw new ConfigError(
      "config_unavailable",
      `写入 ${paths.basename(path)} 失败：${e instanceof Error ? e.message : String(e)}`,
      path,
      { cause: e },
    );
  }
}
