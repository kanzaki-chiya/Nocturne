/**
 * 面板「文件」标签读取工作区文件（ADR-0060 第 3 节，rpc.md `session.readFile`）。
 * 给用户看自己的文件用，不是 agent 工具，不经权限层；只读，不产生事件。
 */
import { fsErrorCode, type FileSystem, type PathOps } from "../platform/index.js";
import {
  READ_FILE_MAX_BYTES,
  type WorkspaceFileContent,
  type WorkspaceImageMimeType,
} from "../protocol/index.js";
import { SessionError } from "./errors.js";

const IMAGE_TYPES: Record<string, WorkspaceImageMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * 词法检查：拒绝空串、控制字符、`..` 段、Windows 备用数据流与设备名。
 * 绝对路径放行，交给后面的真实路径判定是否越界。
 */
function checkInput(input: unknown, windows: boolean): string {
  if (typeof input !== "string" || input.trim() === "" || /[\u0000-\u001f]/.test(input)) {
    throw new SessionError("invalid_file_path", "文件路径不合法");
  }
  const segments = input.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) {
    throw new SessionError("invalid_file_path", "文件路径不能包含 ..");
  }
  if (windows) {
    // 去掉盘符（C:）和扩展前缀（\\?\）后再看冒号：剩下的冒号只能是备用数据流
    const body = input.replace(/^\\\\\?\\/, "").replace(/^[A-Za-z]:/, "");
    if (body.includes(":")) {
      throw new SessionError("invalid_file_path", "不支持读取备用数据流");
    }
    if (segments.some((s) => RESERVED_NAME.test(s))) {
      throw new SessionError("invalid_file_path", "文件路径不合法");
    }
  }
  return input;
}

function decodeText(data: Uint8Array): string | undefined {
  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data.subarray(2));
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data.subarray(2));
  }
  // 与 read 工具相同的嗅探规则（tools/text.ts）：前 8 KiB 含 NUL 即二进制
  if (data.subarray(0, 8192).includes(0)) return undefined;
  try {
    // fatal：非 UTF-8 内容当作二进制，不显示乱码
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return undefined;
  }
}

export async function readWorkspaceFile(
  fs: FileSystem,
  paths: PathOps,
  workspaceRoot: string,
  input: unknown,
  maxBytes = READ_FILE_MAX_BYTES,
): Promise<WorkspaceFileContent> {
  const windows = paths.sep === "\\";
  const raw = checkInput(input, windows);
  const root = paths.normalize(await fs.realpath(workspaceRoot).catch(() => workspaceRoot));
  const lexical = paths.isAbsolute(raw) ? paths.normalize(raw) : paths.join(root, raw);
  try {
    // 以真实路径判定归属：符号链接、junction 指向工作区外的一律拒绝；
    // 绝对路径也可能是 8.3 短名，词法比较不可靠
    const real = paths.normalize(
      await fs.realpath(lexical).catch((error: unknown) => {
        if (
          !paths.isWithin(root, lexical) &&
          !paths.isWithin(paths.normalize(workspaceRoot), lexical)
        ) {
          throw new SessionError("file_outside_workspace", "只能读取工作区内的文件");
        }
        throw error;
      }),
    );
    if (!paths.isWithin(root, real)) {
      throw new SessionError("file_outside_workspace", "只能读取工作区内的文件");
    }
    const stat = await fs.stat(real);
    if (stat.type !== "file") {
      throw new SessionError("file_not_regular", "只能读取普通文件");
    }
    if (stat.size > maxBytes) {
      throw new SessionError("file_too_large", `文件超过 ${maxBytes} 字节上限`);
    }
    const data = await fs.readFile(real);
    // 读取期间文件可能变大：按实际字节再判一次，仍不截断
    if (data.byteLength > maxBytes) {
      throw new SessionError("file_too_large", `文件超过 ${maxBytes} 字节上限`);
    }
    const relativePath = paths.relative(root, real);
    const ext = /\.([^.\\/]+)$/.exec(real)?.[1]?.toLowerCase() ?? "";
    const mimeType = IMAGE_TYPES[ext];
    if (mimeType !== undefined) {
      return {
        kind: "image",
        absolutePath: real,
        relativePath,
        data,
        mimeType,
        bytes: data.byteLength,
      };
    }
    const text = decodeText(data);
    if (text === undefined) {
      throw new SessionError("file_binary", "二进制文件无法预览");
    }
    return { kind: "text", absolutePath: real, relativePath, text, bytes: data.byteLength };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SessionError("file_not_found", "文件不存在", { cause: error });
    }
    throw new SessionError("file_read_failed", "文件读取失败", { cause: error });
  }
}
