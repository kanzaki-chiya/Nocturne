/**
 * 超预算输出落盘（tools.md 第 4 节）。
 * modelContent 被截断时，完整文本写入
 * <attachmentsDir>/<sessionId>/<callId>.txt（attachmentsDir 由
 * sessionsDir 推导）；文件本身上限 1 MB，超出只写头部并注明。
 * 写盘失败由调用方降级为普通截断——本函数只管写，失败抛给调用方。
 */
import type { FileSystem, PathOps } from "../platform/index.js";

/** 落盘文件上限：1 MB（tools.md 第 4 节） */
export const SPILL_LIMIT_BYTES = 1_000_000;

export interface SpillInput {
  fs: FileSystem;
  paths: PathOps;
  attachmentsDir: string;
  sessionId: string;
  callId: string;
  /** 截断前的完整 modelContent */
  content: string;
}

/** 写入落盘文件，返回绝对路径；失败抛错由调用方降级 */
export async function writeSpill(input: SpillInput): Promise<string> {
  const dir = input.paths.join(input.attachmentsDir, input.sessionId);
  await input.fs.mkdir(dir);
  const filePath = input.paths.join(dir, `${input.callId}.txt`);
  const buf = Buffer.from(input.content, "utf8");
  if (buf.length <= SPILL_LIMIT_BYTES) {
    await input.fs.writeFile(filePath, buf);
  } else {
    const note = `\n…[文件截断：原始输出 ${buf.length} 字节，超过 1 MB 落盘上限]…\n`;
    const head = buf.subarray(0, SPILL_LIMIT_BYTES - Buffer.byteLength(note));
    await input.fs.writeFile(filePath, Buffer.concat([head, Buffer.from(note, "utf8")]));
  }
  return filePath;
}
