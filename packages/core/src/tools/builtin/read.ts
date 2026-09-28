/**
 * read 工具（tools.md 第 6 节）：读取文本文件，带行号输出。
 * 检测二进制文件；记录"已读状态"（路径、修改时间）。
 * PNG/JPEG/GIF/WebP 图片按 ADR-0023 第 2 节作为图片附件返回。
 */
import type { ImageMimeType, SubjectRequest } from "../../protocol/index.js";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  parseImageSize,
  SUPPORTED_IMAGE_FORMATS,
  sniffImageMime,
} from "../image.js";
import type { ToolContext, ToolDefinition, ToolScope } from "../types.js";

interface ReadInput {
  path: string;
  /** 起始行（1 起），默认 1 */
  offset?: number;
  /** 最多返回行数，默认 2000 */
  limit?: number;
}

type ReadOutput =
  | {
      path: string;
      totalLines: number;
      offset: number;
      returnedLines: number;
    }
  | {
      path: string;
      mimeType: ImageMimeType;
      width: number;
      height: number;
      bytes: number;
    };

const BINARY_SNIFF_BYTES = 8192;
const DEFAULT_LIMIT = 2000;

/** 图片大小的人读格式：<1KB → "N B"；<1MB → 整数 "N KB"；否则一位小数 "N.N MB" */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_LIMIT_TEXT = `单张图片原始文件不超过 5 MB（5×1024×1024 字节）、每边不超过 ${IMAGE_MAX_EDGE} px`;

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export const readTool: ToolDefinition<ReadInput, ReadOutput> = {
  name: "read",
  description:
    "读取文本文件，返回带行号的内容；也可读取 PNG、JPEG、GIF、WebP 图片（图片忽略 offset/limit）。支持 offset（起始行）与 limit（行数）。",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "文件路径（相对 cwd 或绝对路径）" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 10_000 },

  permissionSubjects(input: ReadInput, scope: ToolScope): SubjectRequest[] {
    return [
      {
        kind: "read",
        target: scope.paths.resolve(scope.cwd, input.path),
      },
    ];
  },

  async execute(input: ReadInput, ctx: ToolContext) {
    const approved = ctx.subjects.find((s) => s.kind === "read");
    const target = approved?.resolved ?? input.path;

    const stat = await ctx.fs.stat(target).catch(() => undefined);
    if (stat === undefined) {
      return {
        status: "error",
        modelContent: `文件不存在或不可访问：${target}`,
        error: { code: "file_not_found", message: `文件不存在：${target}` },
      };
    }
    if (stat.type === "directory") {
      return {
        status: "error",
        modelContent: `${target} 是目录，不是文件`,
        error: { code: "is_directory", message: `${target} 是目录` },
      };
    }

    const bytes = await ctx.fs.readFile(target).catch(() => undefined);
    if (bytes === undefined) {
      return {
        status: "error",
        modelContent: `无法读取文件：${target}`,
        error: { code: "read_failed", message: `无法读取：${target}` },
      };
    }

    // 图片（ADR-0023 第 2 节）：魔数识别后走附件路径——不写 readState、
    // 忽略 offset/limit；是否投影给模型由上层按模型能力决定，工具不判断
    const mime = sniffImageMime(bytes);
    if (mime !== undefined) {
      if (bytes.length > IMAGE_MAX_BYTES) {
        const message = `图片超出大小限制（${IMAGE_LIMIT_TEXT}）：实际 ${formatBytes(bytes.length)}`;
        return {
          status: "error",
          modelContent: `${target}：${message}`,
          error: { code: "image_too_large", message },
        };
      }
      const size = parseImageSize(bytes, mime);
      if (size === undefined) {
        const message = "图片文件头损坏或被截断，无法解析尺寸";
        return {
          status: "error",
          modelContent: `${target}：${message}`,
          error: { code: "image_corrupt", message },
        };
      }
      if (size.width > IMAGE_MAX_EDGE || size.height > IMAGE_MAX_EDGE) {
        const message = `图片超出大小限制（${IMAGE_LIMIT_TEXT}）：实际 ${size.width}×${size.height}`;
        return {
          status: "error",
          modelContent: `${target}：${message}`,
          error: { code: "image_too_large", message },
        };
      }
      return {
        status: "ok",
        modelContent: `Image file: ${input.path} (${mime}, ${size.width}×${size.height}, ${formatBytes(bytes.length)})`,
        output: {
          path: target,
          mimeType: mime,
          width: size.width,
          height: size.height,
          bytes: bytes.length,
        },
        attachments: [{ mimeType: mime, data: bytes, label: ctx.paths.basename(target) }],
      };
    }

    if (isBinary(bytes)) {
      const message = `二进制文件（read 只支持文本与 ${SUPPORTED_IMAGE_FORMATS} 图片）`;
      return {
        status: "error",
        modelContent: `${target} 是二进制文件，无法用 read 读取：${message}`,
        error: { code: "binary_file", message },
      };
    }

    const text = new TextDecoder("utf-8").decode(bytes);
    const lines = text.split("\n");
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const start = Math.min(Math.max(offset - 1, 0), lines.length);
    const end = Math.min(start + limit, lines.length);

    const numbered: string[] = [];
    for (let i = start; i < end; i++) {
      numbered.push(`${i + 1}|${(lines[i] ?? "").replace(/\r$/, "")}`);
    }
    const remaining = lines.length - end;
    if (remaining > 0) {
      numbered.push(`…（其后还有 ${remaining} 行，用 offset 继续读取）`);
    }

    // 记录"已读状态"（Phase 2 的 write/edit 据此做先读检查与过期检测）
    ctx.readState.record(target, { mtimeMs: stat.mtimeMs, size: stat.size });

    return {
      status: "ok",
      modelContent: numbered.join("\n"),
      output: {
        path: target,
        totalLines: lines.length,
        offset,
        returnedLines: end - start,
      },
    };
  },
};
