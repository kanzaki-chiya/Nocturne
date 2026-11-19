/**
 * `<NOCTURNE_HOME>/plugins.json` 读写（与 mcp.json 等共用 config 写队列与原子写）。
 * 格式：
 * - 非内置插件启用：{ "enabled": true, "hash": "sha256:..." }
 * - 内置插件停用：{ "enabled": false }（默认开启，重新开启时删除条目）
 */
import { enqueueConfigWrite, writeJsonAtomic } from "../config/files.js";
import type { Platform } from "../platform/index.js";

export type StoredPluginEntry = { enabled: true; hash: string } | { enabled: false };

export interface PluginStoreReadResult {
  entries: Map<string, StoredPluginEntry>;
  warnings: string[];
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPluginStore(platform: Platform, nocturneHome: string) {
  const { fs, paths } = platform;
  const filePath = paths.join(nocturneHome, "plugins.json");

  async function readState(): Promise<PluginStoreReadResult> {
    const entries = new Map<string, StoredPluginEntry>();
    const warnings: string[] = [];
    if (!(await fs.exists(filePath))) return { entries, warnings };

    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readTextFile(filePath));
    } catch {
      warnings.push(`plugins_config_invalid：${filePath} 不是合法 JSON，已忽略`);
      return { entries, warnings };
    }
    if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.plugins)) {
      warnings.push(`plugins_config_invalid：${filePath} 损坏或版本不符，已忽略`);
      return { entries, warnings };
    }
    for (const [id, item] of Object.entries(raw.plugins)) {
      if (!isPlainObject(item)) {
        warnings.push(`plugins_config_invalid：${filePath} 中条目 ${id} 无效，已忽略`);
        continue;
      }
      if (item.enabled === false) {
        entries.set(id, { enabled: false });
        continue;
      }
      if (item.enabled === true && typeof item.hash === "string" && HASH_RE.test(item.hash)) {
        entries.set(id, { enabled: true, hash: item.hash });
        continue;
      }
      warnings.push(`plugins_config_invalid：${filePath} 中条目 ${id} 无效，已忽略`);
    }
    return { entries, warnings };
  }

  async function setEnabled(
    id: string,
    enabled: boolean,
    computeHash?: () => Promise<string>,
    options?: { builtin?: boolean | undefined },
  ): Promise<void> {
    await enqueueConfigWrite(fs, async () => {
      const { entries } = await readState();
      if (options?.builtin === true) {
        if (enabled) {
          entries.delete(id);
        } else {
          entries.set(id, { enabled: false });
        }
      } else if (enabled) {
        if (!computeHash) throw new Error("启用插件需要计算哈希");
        const hash = await computeHash();
        entries.set(id, { enabled: true, hash });
      } else {
        entries.delete(id);
      }
      const sorted = Object.fromEntries(
        [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      await writeJsonAtomic(
        fs,
        paths,
        filePath,
        { version: 1, plugins: sorted },
        { dirMode: 0o700 },
      );
    });
  }

  return { filePath, readState, setEnabled };
}
