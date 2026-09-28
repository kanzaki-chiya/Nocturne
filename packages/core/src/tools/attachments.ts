/**
 * 图片附件存储（ADR-0023 第 2 节）：字节统一落在
 * <attachmentsDir>/<sessionId>/img-<n>.<ext>（与超预算落盘同一目录），
 * 事件与历史里只放 ImageAttachment 引用；n 在会话内递增，恢复后
 * 从目录里已有文件续编号，不覆盖旧文件。
 */
import { createHash } from "node:crypto";

import type { FileSystem, PathOps } from "../platform/index.js";
import { fsErrorCode } from "../platform/index.js";
import type { ImageAttachment, ImageMimeType } from "../protocol/index.js";
import { parseImageSize } from "./image.js";

const EXT: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const IMG_NAME = /^img-(\d+)\./;

export interface AttachmentStore {
  /** 保存字节为 img-<n>.<ext>，返回引用（含 sha256、宽高） */
  save(input: {
    data: Uint8Array;
    mimeType: ImageMimeType;
    label?: string | undefined;
    source: ImageAttachment["source"];
  }): Promise<ImageAttachment>;
  /** 按引用取回字节；文件缺失或 sha256 不符返回 undefined。运行期按 sha256 缓存 */
  load(att: ImageAttachment): Promise<Uint8Array | undefined>;
}

export function createAttachmentStore(opts: {
  fs: FileSystem;
  paths: PathOps;
  attachmentsDir: string;
  sessionId: string;
}): AttachmentStore {
  const { fs, paths, sessionId } = opts;
  const dir = paths.join(opts.attachmentsDir, sessionId);
  /** sha256 → 字节（会话级缓存，无淘汰） */
  const cache = new Map<string, Uint8Array>();
  /** 下一个可用序号；首次 save 时扫目录惰性定起点 */
  let next: number | undefined;
  /** 保存串行化：n 递增与 createExclusive 配对，杜绝并发抢号 */
  let queue: Promise<unknown> = Promise.resolve();

  async function initNext(): Promise<number> {
    if (next !== undefined) return next;
    await fs.mkdir(dir);
    const entries = await fs.readdir(dir).catch(() => []);
    let max = 0;
    for (const e of entries) {
      const m = IMG_NAME.exec(e.name);
      if (m !== null) max = Math.max(max, Number(m[1]));
    }
    next = max + 1;
    return next;
  }

  async function doSave(input: {
    data: Uint8Array;
    mimeType: ImageMimeType;
    label?: string | undefined;
    source: ImageAttachment["source"];
  }): Promise<ImageAttachment> {
    const { data, mimeType } = input;
    const ext = EXT[mimeType];
    let n = await initNext();
    // 排他创建兜底并发/恢复冲突：撞名就让号重试
    for (;;) {
      const file = `img-${n}.${ext}`;
      try {
        await fs.createExclusive(paths.join(dir, file), data);
        next = n + 1;
        const sha256 = createHash("sha256").update(data).digest("hex");
        const size = parseImageSize(data, mimeType);
        cache.set(sha256, data);
        return {
          type: "image",
          file,
          mimeType,
          bytes: data.length,
          sha256,
          ...(size !== undefined ? { width: size.width, height: size.height } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
          source: input.source,
        };
      } catch (e) {
        if (fsErrorCode(e) === "EEXIST") {
          n += 1;
          continue;
        }
        throw e;
      }
    }
  }

  return {
    save(input) {
      const p = queue.then(() => doSave(input));
      queue = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    async load(att) {
      const hit = cache.get(att.sha256);
      if (hit !== undefined) return hit;
      const data = await fs.readFile(paths.join(dir, att.file)).catch(() => undefined);
      if (data === undefined) return undefined;
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (sha256 !== att.sha256) return undefined;
      cache.set(sha256, data);
      return data;
    },
  };
}
