/**
 * 诊断通道实现（observability.md）：JSONL 记录，默认关闭；
 * 递归脱敏（凭据形键名 → "***"），单字段超 16KB 截断并标 truncated。
 * 只依赖 protocol 类型与 platform 的文件能力。
 */
import type { Diagnostics } from "../protocol/index.js";
import type { Platform } from "../platform/index.js";

const CREDENTIAL_KEY = /key|token|secret|password|authorization|credential|cookie/i;
const MAX_FIELD_CHARS = 16 * 1024;
const MAX_DEPTH = 8;

/** 递归清洗：凭据形键名的值替换为 "***"；超长字符串截断 */
function sanitize(value: unknown, key: string | undefined, depth: number): unknown {
  if (key !== undefined && CREDENTIAL_KEY.test(key)) return "***";
  if (typeof value === "string") {
    if (value.length <= MAX_FIELD_CHARS) return value;
    return `${value.slice(0, MAX_FIELD_CHARS)}…[truncated ${value.length - MAX_FIELD_CHARS} chars]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, undefined, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // mcp.servers.*.env 的值无论键名都视为敏感（observability.md 第 3 节）
    if (key === "env") {
      out[k] = "***";
      continue;
    }
    out[k] = sanitize(v, k, depth + 1);
  }
  return out;
}

export interface DiagnosticsOptions {
  platform: Platform;
  /** 未 true 时返回 no-op sink（零开销） */
  enabled?: boolean | undefined;
  /**
   * 输出文件绝对路径；缺省时写 logsDir/debug-<ts>-<pid>.jsonl。
   * 与 writeLine 互斥（stderr 输出由调用方注入写入器）。
   */
  file?: string | undefined;
  /** 默认输出目录（<NOCTURNE_HOME>/logs） */
  logsDir: string;
  /** 直接注入的行写入器（如 CLI 的 stderr）；提供时忽略 file */
  writeLine?: ((line: string) => void) | undefined;
  /** sink 初始化/写入失败 → debug_sink_failed */
  warn?: ((code: string, message: string) => void) | undefined;
}

const NOOP: Diagnostics = { record: () => undefined };

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  if (options.enabled !== true) return NOOP;
  const { platform } = options;
  const { paths, fs } = platform;

  const writeLine = options.writeLine;
  let failed = false;
  const fail = (e: unknown) => {
    if (failed) return;
    failed = true;
    options.warn?.(
      "debug_sink_failed",
      `诊断输出失败，已降级为关闭：${e instanceof Error ? e.message : String(e)}`,
    );
  };

  const file =
    options.file ??
    paths.join(
      options.logsDir,
      `debug-${new Date()
        .toISOString()
        .replace(/[-:T]/g, "")
        .replace(/\..+$/, "")}-${process.pid}.jsonl`,
    );

  // 串行追加队列：record 是同步签名，写入排队到后台；
  // 首条记录前确保 logs 目录存在（初始化失败也走 fail 降级）
  let queue: Promise<void> =
    writeLine === undefined
      ? fs.mkdir(paths.dirname(file)).then(
          () => undefined,
          (e: unknown) => {
            fail(e);
          },
        )
      : Promise.resolve();

  return {
    record(kind, data = {}) {
      if (failed) return;
      const entry = sanitize({ kind, time: new Date().toISOString(), ...data }, undefined, 0);
      const line = JSON.stringify(entry);
      if (writeLine !== undefined) {
        try {
          writeLine(line);
        } catch (e) {
          fail(e);
        }
        return;
      }
      queue = queue
        .then(() => fs.appendFile(file, `${line}\n`))
        .catch((e: unknown) => {
          fail(e);
        });
    },
  };
}
