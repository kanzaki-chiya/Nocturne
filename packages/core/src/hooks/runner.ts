/**
 * HookRunner 实现（hooks.md）：每个被触发的条目 = 一个 spawnPipe 子进程，
 * stdin 传 JSON 上下文、stdout 读 JSON 结果、非零退出/超时/解析失败均降级为
 * "无效果 + hook_failed 警告"。继承完整进程环境（Hook 是用户自己的脚本，
 * 与 MCP 的白名单环境相反，见 hooks.md 第 2 节、ADR-0012）。
 */
import type { Diagnostics, HookEntry, HookPoint } from "../protocol/index.js";
import type { Platform } from "../platform/index.js";
import type {
  HookCallInput,
  HookOutput,
  HookRunner,
} from "../tools/types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_FEEDBACK_CHARS = 4_000;

/** matcher 是 `|` 分隔的通配符列表（与权限规则同一套通配语义：* 与 ?） */
function matchTool(matcher: string | undefined, tool: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (tool === undefined) return false;
  return matcher.split("|").some((alt) => {
    let re = "";
    for (const c of alt) {
      if (c === "*") re += ".*";
      else if (c === "?") re += ".";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(tool);
  });
}

/** 该点位的 matcher 只对工具相关点位生效（hooks.md 第 2 节） */
const TOOL_POINTS = new Set<HookPoint>(["PreToolUse", "PostToolUse", "PermissionRequest"]);

export interface HookRunnerOptions {
  hooks: Partial<Record<HookPoint, HookEntry[]>>;
  platform: Platform;
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  diagnostics?: Diagnostics | undefined;
  /** hook_failed → runtime.warning（index.ts 注入 session.emitEphemeral） */
  warn?: ((code: string, message: string) => void) | undefined;
}

interface EntryResult {
  ok: boolean;
  output?: HookOutput;
}

export function createHookRunner(opts: HookRunnerOptions): HookRunner {
  const { platform } = opts;

  /** 收集 stdout 原始字节；超过 64KB 记超限（该条目按失败处理） */
  async function collectStdout(
    proc: { stdoutRaw: AsyncIterable<Buffer> },
    sink: { bytes: number; overflowed: boolean },
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdoutRaw) {
      sink.bytes += chunk.length;
      if (sink.bytes > MAX_STDOUT_BYTES) {
        sink.overflowed = true;
      } else {
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks);
  }

  /** 收集 stderr 文本尾部供诊断（截断至 2000 字符） */
  async function collectStderr(proc: { stderr: AsyncIterable<string> }): Promise<string> {
    let text = "";
    for await (const chunk of proc.stderr) {
      text += chunk;
      if (text.length > 2_000) text = text.slice(-2_000);
    }
    return text;
  }

  /** 单条目执行：spawn → 写 stdin → 等退出 → 解析 stdout */
  async function runEntry(
    point: HookPoint,
    entry: HookEntry,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<EntryResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(entry.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const fail = (reason: string, extra?: Record<string, unknown>): EntryResult => {
      opts.diagnostics?.record("hook.done", {
        point,
        command: entry.command,
        durationMs: Date.now() - startedAt,
        ok: false,
        reason,
        ...extra,
      });
      opts.warn?.("hook_failed", `Hook ${point}（${entry.command}）失败：${reason}`);
      return { ok: false };
    };

    let proc;
    try {
      proc = platform.process.spawnPipe(entry.command, entry.args ?? [], {
        cwd: opts.workspaceRoot,
        env: {
          NOCTURNE_HOOK_EVENT: point,
          NOCTURNE_SESSION_ID: opts.sessionId,
          NOCTURNE_WORKSPACE_ROOT: opts.workspaceRoot,
          NOCTURNE_CWD: opts.cwd,
        },
        timeoutMs,
        signal,
      });
    } catch (e) {
      return fail(`进程启动失败：${e instanceof Error ? e.message : String(e)}`);
    }

    const sink = { bytes: 0, overflowed: false };
    const [exit, stdoutBuf, stderrText] = await Promise.all([
      (async () => {
        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
        return proc.wait();
      })(),
      collectStdout(proc, sink),
      collectStderr(proc),
    ]);

    if (exit.timedOut) {
      return fail(`超过 ${timeoutMs}ms 超时`, { stderrTail: stderrText });
    }
    if (signal?.aborted === true) {
      // 会话中止不算 Hook 失败——安静降级（取消语义由调用方表达）
      return { ok: false };
    }
    if (sink.overflowed) {
      return fail(`stdout 超过 ${MAX_STDOUT_BYTES} 字节上限`, { stderrTail: stderrText });
    }
    if (exit.code !== 0) {
      return fail(`退出码 ${exit.code ?? "null"}`, { stderrTail: stderrText });
    }

    const text = stdoutBuf.toString("utf8").trim();
    if (text === "") {
      opts.diagnostics?.record("hook.done", {
        point,
        command: entry.command,
        durationMs: Date.now() - startedAt,
        ok: true,
        effect: "none",
      });
      return { ok: true, output: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("stdout 不是合法 JSON", { stderrTail: stderrText });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail("stdout JSON 不是对象", { stderrTail: stderrText });
    }
    return { ok: true, output: parsed };
  }

  /** 按点位过滤+串行执行；返回合并后的 HookOutput（undefined = 无意见） */
  async function run(
    point: HookPoint,
    input: HookCallInput,
    signal?: AbortSignal,
  ): Promise<HookOutput | undefined> {
    const all = opts.hooks[point];
    if (all === undefined || all.length === 0) return undefined;
    const entries = TOOL_POINTS.has(point)
      ? all.filter((e) => matchTool(e.matcher, input.tool))
      : all;
    if (entries.length === 0) return undefined;

    const base: Record<string, unknown> = {
      point,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      workspaceRoot: opts.workspaceRoot,
      ...input,
    };

    // 链式状态：PreToolUse 的 updatedInput 对后续条目可见（hooks.md 第 2 节）
    let currentInput = input.input;
    let askReason: string | undefined;
    let merged: HookOutput | undefined;
    let spoke = false;

    for (const entry of entries) {
      if (signal?.aborted === true) return undefined;
      const payload = { ...base };
      if (currentInput !== input.input) payload.input = currentInput;
      opts.diagnostics?.record("hook.run", {
        point,
        command: entry.command,
        tool: input.tool,
      });
      const res = await runEntry(point, entry, payload, signal);
      if (!res.ok) continue;
      const out = res.output ?? {};

      switch (point) {
        case "PreToolUse": {
          if (out.updatedInput !== undefined) {
            currentInput = out.updatedInput;
            spoke = true;
          }
          if (out.decision === "deny") {
            spoke = true;
            return { decision: "deny", reason: out.reason };
          }
          if (out.decision === "ask") {
            spoke = true;
            askReason ??= out.reason;
          }
          break;
        }
        case "PermissionRequest": {
          if (out.action === "allow" || out.action === "deny") {
            spoke = true;
            return { action: out.action, reason: out.reason };
          }
          break;
        }
        case "PostToolUse": {
          if (typeof out.feedback === "string" && out.feedback !== "") {
            spoke = true;
            const prev = merged?.feedback;
            const joined = prev === undefined ? out.feedback : `${prev}\n${out.feedback}`;
            merged = {
              feedback:
                joined.length > MAX_FEEDBACK_CHARS
                  ? joined.slice(0, MAX_FEEDBACK_CHARS)
                  : joined,
            };
          }
          break;
        }
        case "TurnStart": {
          if (out.block === true) {
            spoke = true;
            return { block: true, reason: out.reason };
          }
          break;
        }
        default:
          // TurnEnd / SessionStart / SessionEnd：忽略所有输出
          spoke = true;
          break;
      }
    }

    if (!spoke) return undefined;
    if (merged !== undefined) {
      // PostToolUse 的 feedback 合并结果
      return merged;
    }
    const out: HookOutput = {};
    if (askReason !== undefined) {
      out.decision = "ask";
      out.reason = askReason;
    }
    if (point === "PreToolUse" && currentInput !== input.input) {
      out.updatedInput = currentInput;
    }
    return out;
  }

  return { run };
}
