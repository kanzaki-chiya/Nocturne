/**
 * 面板「文件」标签读取本机文件（ADR-0060 第 3 节及 2026-10-18 修订，rpc.md
 * `runtime.readFile`）。给电脑前的用户看自己的文件用，不是 agent 工具，不经权限层；
 * 只读，不产生事件，不依赖会话。
 *
 * 网络路径一律拒绝且不去访问：回答内容来自模型，访问 `\\server\share` 会让系统向
 * 那台主机发起 SMB 连接并带上 Windows 凭据。链接目标也按同样规则逐级检查，
 * 而不是交给 realpath——realpath 会跟着 junction / 符号链接去打开网络位置。
 */
import { fsErrorCode, type FileSystem, type PathOps } from "../platform/index.js";
import {
  READ_FILE_MAX_BYTES,
  type LocalFileContent,
  type LocalImageMimeType,
} from "../protocol/index.js";
import { SessionError } from "./errors.js";

const IMAGE_TYPES: Record<string, LocalImageMimeType> = {
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
/** 链接最多跟这么多层，防环 */
const MAX_LINK_HOPS = 40;

/**
 * Windows 网络路径的词法判断：`\\server\share`、`//server/share`、`\\?\UNC\...`、
 * `\??\UNC\...`。只看字符串，不访问文件系统。`\\?\C:\` 这类本地扩展路径不算。
 */
export function isNetworkPath(input: string): boolean {
  const p = input.replaceAll("/", "\\");
  if (/^\\\\[?.]\\unc\\/i.test(p) || /^\\\?\?\\unc\\/i.test(p)) return true;
  return p.startsWith("\\\\") && !/^\\\\[?.]\\/.test(p);
}

/** 本地扩展前缀 `\\?\C:\x` / `\??\C:\x` → `C:\x`；其他形式原样返回 */
function stripLocalPrefix(p: string): string {
  return p.replace(/^(?:\\\\\?\\|\\\?\?\\)(?=[A-Za-z]:)/, "");
}

/**
 * 词法检查：拒绝空串、相对路径、控制字符、`..` 段、网络路径、设备命名空间、
 * Windows 备用数据流与设备名。
 */
function checkInput(input: unknown, paths: PathOps): string {
  if (typeof input !== "string" || input.trim() === "" || /[\u0000-\u001f]/.test(input)) {
    throw new SessionError("invalid_file_path", "文件路径不合法");
  }
  const windows = paths.sep === "\\";
  if (windows && isNetworkPath(input)) {
    throw new SessionError("file_network_path", "不读取网络路径上的文件");
  }
  const raw = windows ? stripLocalPrefix(input) : input;
  if (windows && /^(?:\\\\[?.]\\|\\\?\?\\)/.test(raw)) {
    throw new SessionError("invalid_file_path", "不支持设备路径");
  }
  if (!paths.isAbsolute(raw) || (windows && !/^[A-Za-z]:[\\/]/.test(raw))) {
    throw new SessionError("invalid_file_path", "只接受绝对路径");
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) {
    throw new SessionError("invalid_file_path", "文件路径不能包含 ..");
  }
  if (windows) {
    // 去掉盘符后再看冒号：剩下的冒号只能是备用数据流
    if (raw.slice(2).includes(":")) {
      throw new SessionError("invalid_file_path", "不支持读取备用数据流");
    }
    if (segments.some((s) => RESERVED_NAME.test(s))) {
      throw new SessionError("invalid_file_path", "文件路径不合法");
    }
  }
  return paths.normalize(raw);
}

/**
 * 逐级解析链接得到真实路径：每一级只做 lstat（不跟随），遇到链接读出目标，
 * 目标是网络路径就停下拒绝，否则拼上剩余部分从头再解析。lstat 与 readlink
 * 只读链接本身，不会打开它指向的位置。
 */
export async function resolveLocalPath(
  fs: FileSystem,
  paths: PathOps,
  absolute: string,
): Promise<string> {
  const windows = paths.sep === "\\";
  let current = paths.normalize(absolute);
  for (let hops = 0; ; hops++) {
    const segments: string[] = [];
    let root = current;
    while (paths.dirname(root) !== root) {
      segments.unshift(paths.basename(root));
      root = paths.dirname(root);
    }
    let resolved = root;
    let jumped = false;
    for (let i = 0; i < segments.length; i++) {
      const next = paths.join(resolved, segments[i] ?? "");
      const stat = await fs.lstat(next);
      if (stat.type !== "symlink") {
        resolved = next;
        continue;
      }
      if (hops >= MAX_LINK_HOPS) {
        throw new SessionError("file_read_failed", "链接层数过多");
      }
      const target = await fs.readlink(next);
      if (windows && isNetworkPath(target)) {
        throw new SessionError("file_network_path", "文件链接到网络位置，不读取");
      }
      const local = windows ? stripLocalPrefix(target) : target;
      const base = paths.isAbsolute(local) ? local : paths.join(resolved, local);
      current = paths.normalize(paths.join(base, ...segments.slice(i + 1)));
      jumped = true;
      break;
    }
    if (!jumped) return resolved;
  }
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

export async function readLocalFile(
  fs: FileSystem,
  paths: PathOps,
  input: unknown,
  maxBytes = READ_FILE_MAX_BYTES,
): Promise<LocalFileContent> {
  const lexical = checkInput(input, paths);
  try {
    const real = await resolveLocalPath(fs, paths, lexical);
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
    const ext = /\.([^.\\/]+)$/.exec(real)?.[1]?.toLowerCase() ?? "";
    const mimeType = IMAGE_TYPES[ext];
    if (mimeType !== undefined) {
      return { kind: "image", absolutePath: real, data, mimeType, bytes: data.byteLength };
    }
    const text = decodeText(data);
    if (text === undefined) {
      throw new SessionError("file_binary", "二进制文件无法预览");
    }
    return { kind: "text", absolutePath: real, text, bytes: data.byteLength };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SessionError("file_not_found", "文件不存在", { cause: error });
    }
    throw new SessionError("file_read_failed", "文件读取失败", { cause: error });
  }
}
