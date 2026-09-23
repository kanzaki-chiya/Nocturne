/**
 * 已读状态记录（tools.md 第 6 节）。
 * 保存在运行时内存中，会话恢复后需要重新读取；Phase 1 仅 read 写入，
 * write/edit 在 Phase 2 消费。
 */
import type { PathOps } from "../platform/index.js";
import type { ReadStateStore } from "./types.js";

export function createReadStateStore(paths: PathOps): ReadStateStore {
  const map = new Map<string, { mtimeMs: number; size: number }>();
  return {
    record(path, stat) {
      map.set(paths.canonicalize(path), stat);
    },
    get(path) {
      return map.get(paths.canonicalize(path));
    },
  };
}
