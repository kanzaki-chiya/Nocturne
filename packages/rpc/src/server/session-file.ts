import {
  createPlatform,
  READ_FILE_MAX_BYTES,
  READ_FILE_TIMEOUT_MS,
  SessionError,
  type RuntimeSession,
} from "@nocturne/core";

import type { SessionFileContent } from "../shared/methods.js";

type SessionErrorCode = ConstructorParameters<typeof SessionError>[0];
type FsStat = Awaited<ReturnType<ReturnType<typeof createPlatform>["fs"]["lstat"]>>;

const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const WINDOWS_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..+)?$/i;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".pyc",
  ".class",
  ".o",
  ".a",
  ".lib",
]);

const platform = createPlatform();

export function sessionErrorWithBytes(
  code: SessionErrorCode,
  message: string,
  bytes?: number,
): SessionError & { bytes?: number } {
  const err = new SessionError(code, message) as SessionError & { bytes?: number };
  if (bytes !== undefined) err.bytes = bytes;
  return err;
}

function validateRelativeSessionPath(rawPath: string): { segments: string[]; relPath: string } {
  if (rawPath.trim() === "" || CONTROL_CHAR.test(rawPath)) {
    throw new SessionError("invalid_file_path", `无效的文件路径：${rawPath}`);
  }
  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    rawPath.endsWith("/") ||
    rawPath.endsWith("\\") ||
    /^[a-zA-Z]:/.test(rawPath) ||
    platform.paths.isAbsolute(rawPath)
  ) {
    throw new SessionError("invalid_file_path", `只允许会话工作区内的相对路径：${rawPath}`);
  }
  const segments = rawPath.split(/[\\/]/);
  for (const seg of segments) {
    if (
      seg === "" ||
      seg === "." ||
      seg === ".." ||
      seg.includes(":") ||
      WINDOWS_DEVICE.test(seg)
    ) {
      throw new SessionError("invalid_file_path", `不安全的文件路径：${rawPath}`);
    }
  }
  return { segments, relPath: segments.join("/") };
}

function hasBinaryExtension(relPath: string): boolean {
  const slash = relPath.lastIndexOf("/");
  const base = slash < 0 ? relPath : relPath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function decodeSessionText(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.byteLength >= 2) {
      const b0 = bytes[0];
      const b1 = bytes[1];
      if (b0 === 0xff && b1 === 0xfe) {
        if ((bytes.byteLength - 2) % 2 !== 0) return undefined;
        const text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
        return text.includes("\0") ? undefined : text;
      }
      if (b0 === 0xfe && b1 === 0xff) {
        if ((bytes.byteLength - 2) % 2 !== 0) return undefined;
        const text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
        return text.includes("\0") ? undefined : text;
      }
    }
    if (bytes.includes(0)) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SessionError("file_read_timeout", "读取超时，所在磁盘可能不可用"));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function readSessionFile(
  session: RuntimeSession,
  rawPath: string,
  options?: { maxBytes?: number | undefined; timeoutMs?: number | undefined },
): Promise<SessionFileContent> {
  const { segments, relPath } = validateRelativeSessionPath(rawPath);
  const maxBytes = options?.maxBytes ?? READ_FILE_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? READ_FILE_TIMEOUT_MS;

  return withTimeout(
    (async () => {
      const workspaceRoot = session.state().meta.workspaceRoot;
      const realWorkspace = await platform.resolveReal(workspaceRoot).catch(() => {
        throw new SessionError("file_not_found", `工作区目录不存在：${workspaceRoot}`);
      });

      const candidate = platform.paths.join(realWorkspace, ...segments);
      if (
        !platform.paths.isWithin(realWorkspace, candidate) ||
        platform.paths.equals(realWorkspace, candidate)
      ) {
        throw new SessionError("invalid_file_path", `文件路径超出会话工作区：${rawPath}`);
      }

      let cur = realWorkspace;
      let finalStat: FsStat | undefined;
      for (const [i, seg] of segments.entries()) {
        cur = platform.paths.join(cur, seg);
        let st: FsStat;
        try {
          st = await platform.fs.lstat(cur);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            throw new SessionError("file_not_found", `文件不存在：${rawPath}`);
          }
          throw new SessionError(
            "file_read_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (st.type === "symlink") {
          throw new SessionError("invalid_file_path", `不允许通过符号链接读取文件：${rawPath}`);
        }
        if (i < segments.length - 1 && st.type !== "directory") {
          throw new SessionError("file_not_found", `文件不存在：${rawPath}`);
        }
        finalStat = st;
      }

      if (finalStat === undefined) {
        throw new SessionError("file_not_found", `文件不存在：${rawPath}`);
      }
      if (finalStat.type !== "file") {
        throw new SessionError("file_not_regular", `不是普通文件：${rawPath}`);
      }

      const realTarget = await platform.resolveReal(cur).catch((error: unknown) => {
        throw new SessionError(
          "file_read_failed",
          error instanceof Error ? error.message : String(error),
        );
      });
      if (
        !platform.paths.isWithin(realWorkspace, realTarget) ||
        platform.paths.equals(realWorkspace, realTarget)
      ) {
        throw new SessionError("invalid_file_path", `文件路径超出会话工作区：${rawPath}`);
      }

      const index = await session.fileIndex();
      if (!index.some((entry) => entry.kind === "file" && entry.path === relPath)) {
        throw new SessionError("invalid_file_path", `文件不在会话可见文件索引内：${relPath}`);
      }

      if (finalStat.size > maxBytes) {
        throw sessionErrorWithBytes(
          "file_too_large",
          `文件超过 ${maxBytes} 字节上限`,
          finalStat.size,
        );
      }

      let rawBytes: Uint8Array;
      try {
        rawBytes = await platform.fs.readFile(realTarget);
      } catch (error) {
        throw new SessionError(
          "file_read_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      const bytes = rawBytes.byteLength;
      if (bytes > maxBytes) {
        throw sessionErrorWithBytes("file_too_large", `文件超过 ${maxBytes} 字节上限`, bytes);
      }

      if (hasBinaryExtension(relPath)) {
        throw sessionErrorWithBytes("file_binary", "二进制文件无法按文本显示", bytes);
      }
      const text = decodeSessionText(rawBytes);
      if (text === undefined) {
        throw sessionErrorWithBytes("file_binary", "二进制文件无法按文本显示", bytes);
      }

      return {
        kind: "text",
        path: relPath,
        text,
        bytes,
      };
    })(),
    timeoutMs,
  );
}
