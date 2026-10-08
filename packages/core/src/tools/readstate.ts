/**
 * 已读状态记录（tools.md 第 6 节）。
 * 保存在运行时内存中，会话恢复后需要重新读取；read/edit/write/apply_patch
 * 与 @文件 引用写入，guard 消费。记录内容哈希（sha256）用于区分"只改
 * mtime、内容未变"与真正的内容变化；小文件的完整原文用于 stale 时附带
 * diff（每会话最多 50 份，按最久未用淘汰，其余只留哈希）。
 */
import { createHash } from "node:crypto";
import type { PathOps } from "../platform/index.js";
import type { ReadStateRecord, ReadStateStore } from "./types.js";

/** 保留原文的上限：文件 ≤64KB 才留文本 */
export const READ_STATE_MAX_TEXT_BYTES = 64 * 1024;
/** 每会话最多保留的文本份数，超过按最久未用淘汰 */
export const READ_STATE_MAX_TEXTS = 50;
/** stale_file 附带 diff 的字符上限，超过则不附 diff、要求重新 read */
export const STALE_DIFF_MAX_CHARS = 4000;

/** 去掉开头的 BOM：read 用 TextDecoder 解码会去掉，fs.readTextFile 不去，两边统一后再比较 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 文本内容的 sha256 十六进制（utf8 编码，忽略开头的 BOM） */
export function hashText(text: string): string {
  return createHash("sha256").update(stripBom(text), "utf8").digest("hex");
}

/** 文本按 utf8 是否 ≤64KB */
export function isSmallText(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= READ_STATE_MAX_TEXT_BYTES;
}

export function createReadStateStore(paths: PathOps): ReadStateStore {
  const map = new Map<string, ReadStateRecord>();
  const countTexts = (): number => {
    let count = 0;
    for (const entry of map.values()) {
      if (entry.text !== undefined) count++;
    }
    return count;
  };
  const evictIfNeeded = (): void => {
    while (countTexts() > READ_STATE_MAX_TEXTS) {
      for (const [key, entry] of map) {
        if (entry.text !== undefined) {
          const { mtimeMs, size, hash } = entry;
          map.set(key, { mtimeMs, size, hash });
          break;
        }
      }
    }
  };
  return {
    record(path, stat) {
      const key = paths.canonicalize(path);
      // 先删再设：有文本的条目借 Map 插入顺序表达新近程度
      map.delete(key);
      if (stat.text !== undefined) {
        map.set(key, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          hash: stat.hash,
          text: stat.text,
        });
        evictIfNeeded();
      } else {
        // 部分读取、大文件：只留哈希，旧文本视为失效
        map.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, hash: stat.hash });
      }
    },
    get(path) {
      const key = paths.canonicalize(path);
      const entry = map.get(key);
      if (entry?.text !== undefined) {
        // 触碰即最近使用
        map.delete(key);
        map.set(key, entry);
      }
      return entry;
    },
  };
}
