/**
 * HookRunner 实现（hooks.md）：每个被触发的条目 = 一个 spawnPipe 子进程，
 * stdin 传 JSON 上下文、stdout 读 JSON 结果、非零退出/超时/解析失败均降级为
 * "无效果 + hook_failed 警告"。
 * - 用户配置的 Hook 继承完整进程环境（hooks.md 第 2 节、ADR-0012）。
 * - 插件 Hook（ADR-0096 第二期）走白名单环境（envMode: "minimal"）、按宿主区分调用形式、
 *   仅在父会话运行 SessionStart/SessionEnd，并按宿主格式映射 stdin/stdout/matcher。
 */
import {
  MAX_HOOK_CONTEXT_ENTRY_CHARS,
  MAX_HOOK_CONTEXT_TOTAL_CHARS,
  type Diagnostics,
  type HookContextEntry,
  type HookEntry,
  type HookPoint,
} from "../protocol/index.js";
import { detectShells, shellDescriptor, type Platform } from "../platform/index.js";
import type { PluginHookSpec } from "../plugins/index.js";
import type { HookCallInput, HookOutput, HookRunner } from "../tools/types.js";

export type HookRunnerEntry = HookEntry & { plugin?: PluginHookSpec | undefined };

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_FEEDBACK_CHARS = 4_000;

const EXACT_MATCHER_RE = /^[A-Za-z0-9_\- ,|]+$/;
const PLACEHOLDER_RE =
  /\$\{(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR)\}/g;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/**
 * 插件 Hook matcher（ADR-0096）：
 * - `*`、空串或缺省匹配全部；
 * - 仅含 `[A-Za-z0-9_\- ,|]` 时按 `|` / `,` 切成精确列表匹配；
 * - 否则按正则匹配；正则非法时抛出由调用方跳过并告警。
 */
function matchPluginMatcher(matcher: string | undefined, target: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (EXACT_MATCHER_RE.test(matcher)) {
    const tokens = matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (tokens.length === 0) return true;
    return target !== undefined && tokens.includes(target);
  }
  const re = new RegExp(matcher);
  return target !== undefined && re.test(target);
}

function expandPlaceholders(
  raw: string,
  vars: { pluginRoot: string; pluginDataDir: string; workspaceRoot: string },
): string {
  return raw.replace(PLACEHOLDER_RE, (match, key: string) => {
    switch (key) {
      case "PLUGIN_ROOT":
      case "CLAUDE_PLUGIN_ROOT":
        return vars.pluginRoot;
      case "PLUGIN_DATA":
      case "CLAUDE_PLUGIN_DATA":
        return vars.pluginDataDir;
      case "CLAUDE_PROJECT_DIR":
        return vars.workspaceRoot;
      default:
        return match;
    }
  });
}

function entryDisplayLabel(point: HookPoint, entry: HookRunnerEntry): string {
  return entry.plugin !== undefined
    ? `plugin ${entry.plugin.pluginLabel} ${point}`
    : `hook ${point} ${entry.command}`;
}

function entryWarnTarget(point: HookPoint, entry: HookRunnerEntry): string {
  return entry.plugin !== undefined
    ? `plugin ${entry.plugin.pluginLabel} ${point}`
    : `${point}（${entry.command}）`;
}

/** 该点位的 matcher 只对工具相关点位生效（hooks.md 第 2 节） */
const TOOL_POINTS = new Set<HookPoint>(["PreToolUse", "PostToolUse", "PermissionRequest"]);

export interface HookRunnerOptions {
  hooks: Partial<Record<HookPoint, HookRunnerEntry[]>>;
  platform: Platform;
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  diagnostics?: Diagnostics | undefined;
  /** hook_failed → runtime.warning（index.ts 注入 session.emitEphemeral） */
  warn?: ((code: string, message: string) => void) | undefined;
}

interface RawHookOutput extends HookOutput {
  additionalContext?: unknown;
}

interface EntryResult {
  ok: boolean;
  output?: RawHookOutput;
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

  async function resolvePluginInvocation(
    plugin: PluginHookSpec,
  ): Promise<{ command: string; args: string[]; verbatimArgs: boolean }> {
    const vars = {
      pluginRoot: plugin.pluginRoot,
      pluginDataDir: plugin.pluginDataDir,
      workspaceRoot: opts.workspaceRoot,
    };
    const expandedCmd = expandPlaceholders(plugin.rawCommand, vars);
    const expandedArgs = plugin.rawArgs?.map((arg) => expandPlaceholders(arg, vars));

    if (plugin.host === "codex") {
      if (process.platform === "win32") {
        const comspec = nonEmpty(platform.env("COMSPEC")) ?? "C:\\Windows\\System32\\cmd.exe";
        const inv = shellDescriptor("cmd", comspec, "win32").invoke(expandedCmd);
        return {
          command: inv.executable,
          args: inv.args,
          verbatimArgs: inv.verbatimArgs === true,
        };
      }
      const shellExe = nonEmpty(platform.env("SHELL")) ?? "/bin/sh";
      return {
        command: shellExe,
        args: ["-lc", expandedCmd],
        verbatimArgs: false,
      };
    }

    // Claude Code 来源：有 args 走 exec 形式；否则按 shell 字段（缺省 bash → PowerShell / sh -c）
    if (expandedArgs !== undefined) {
      return {
        command: expandedCmd,
        args: expandedArgs,
        verbatimArgs: false,
      };
    }

    if (process.platform === "win32") {
      const detected = await detectShells(platform);
      const picked =
        plugin.shell === "powershell"
          ? (detected.find((d) => d.kind === "pwsh" && d.available) ??
            detected.find((d) => d.kind === "powershell" && d.available))
          : (detected.find((d) => d.kind === "bash" && d.available) ??
            detected.find((d) => d.kind === "pwsh" && d.available) ??
            detected.find((d) => d.kind === "powershell" && d.available));
      if (picked?.executable === undefined) {
        throw new Error("未找到可用 shell（Git Bash 或 PowerShell）");
      }
      const inv = shellDescriptor(picked.kind, picked.executable, "win32").invoke(expandedCmd);
      return {
        command: inv.executable,
        args: inv.args,
        verbatimArgs: inv.verbatimArgs === true,
      };
    }

    if (plugin.shell === "powershell") {
      const detected = await detectShells(platform);
      const pwsh = detected.find((d) => d.kind === "pwsh" && d.available);
      if (pwsh?.executable === undefined) {
        throw new Error("未找到可用 PowerShell（pwsh）");
      }
      const inv = shellDescriptor("pwsh", pwsh.executable, process.platform).invoke(expandedCmd);
      return {
        command: inv.executable,
        args: inv.args,
        verbatimArgs: inv.verbatimArgs === true,
      };
    }

    const inv = shellDescriptor("sh", "/bin/sh", process.platform).invoke(expandedCmd);
    return {
      command: inv.executable,
      args: inv.args,
      verbatimArgs: inv.verbatimArgs === true,
    };
  }

  function buildPluginStdinPayload(
    point: HookPoint,
    input: HookCallInput,
  ): Record<string, unknown> {
    const common: Record<string, unknown> = {
      hook_event_name: point,
      session_id: opts.sessionId,
      cwd: opts.cwd,
    };
    switch (point) {
      case "SessionStart": {
        const source =
          input.source === "fork"
            ? "resume"
            : (input.source ?? (input.resumed ? "resume" : "startup"));
        return { ...common, source };
      }
      case "UserPromptSubmit": {
        const prompt =
          input.skill !== undefined
            ? input.skill.arguments !== undefined && input.skill.arguments !== ""
              ? `/${input.skill.name} ${input.skill.arguments}`
              : `/${input.skill.name}`
            : (input.text ?? "");
        return { ...common, turn_id: input.turnId, prompt };
      }
      case "SubagentStart":
        return { ...common, agent_type: input.agentType };
      case "SessionEnd":
        return { ...common, reason: input.reason };
      default:
        return common;
    }
  }

  /** 单条目执行：spawn → 写 stdin → 等退出 → 解析 stdout */
  async function runEntry(
    point: HookPoint,
    entry: HookRunnerEntry,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<EntryResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(entry.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const plugin = entry.plugin;
    const fail = (reason: string, extra?: Record<string, unknown>): EntryResult => {
      opts.diagnostics?.record("hook.done", {
        point,
        command: entry.command,
        ...(plugin !== undefined ? { plugin: plugin.pluginLabel } : {}),
        durationMs: Date.now() - startedAt,
        ok: false,
        reason,
        ...extra,
      });
      opts.warn?.("hook_failed", `Hook ${entryWarnTarget(point, entry)}失败：${reason}`);
      return { ok: false };
    };

    let proc;
    try {
      if (plugin !== undefined) {
        await platform.fs.mkdir(plugin.pluginDataDir);
        const inv = await resolvePluginInvocation(plugin);
        proc = platform.process.spawnPipe(inv.command, inv.args, {
          cwd: opts.workspaceRoot,
          envMode: "minimal",
          verbatimArgs: inv.verbatimArgs,
          env: {
            PLUGIN_ROOT: plugin.pluginRoot,
            CLAUDE_PLUGIN_ROOT: plugin.pluginRoot,
            PLUGIN_DATA: plugin.pluginDataDir,
            CLAUDE_PLUGIN_DATA: plugin.pluginDataDir,
            CLAUDE_PROJECT_DIR: opts.workspaceRoot,
            NOCTURNE_HOOK_EVENT: point,
            NOCTURNE_SESSION_ID: opts.sessionId,
            NOCTURNE_WORKSPACE_ROOT: opts.workspaceRoot,
            NOCTURNE_CWD: opts.cwd,
          },
          timeoutMs,
          signal,
        });
      } else {
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
      }
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

    if (plugin !== undefined) {
      if (exit.code === 2 && point === "UserPromptSubmit") {
        const reason = stderrText.trim();
        opts.diagnostics?.record("hook.done", {
          point,
          command: entry.command,
          plugin: plugin.pluginLabel,
          durationMs: Date.now() - startedAt,
          ok: true,
          effect: "block",
        });
        return {
          ok: true,
          output: { block: true, ...(reason !== "" ? { reason } : {}) },
        };
      }
      if (exit.code !== 0) {
        return fail(`退出码 ${exit.code ?? "null"}`, { stderrTail: stderrText });
      }
      const text = stdoutBuf.toString("utf8").trim();
      if (text === "") {
        opts.diagnostics?.record("hook.done", {
          point,
          command: entry.command,
          plugin: plugin.pluginLabel,
          durationMs: Date.now() - startedAt,
          ok: true,
          effect: "none",
        });
        return { ok: true, output: {} };
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (isPlainObject(parsed)) {
          const hso = parsed.hookSpecificOutput;
          const additionalContext =
            isPlainObject(hso) && typeof hso.additionalContext === "string"
              ? hso.additionalContext
              : undefined;
          if (point === "UserPromptSubmit" && parsed.decision === "block") {
            const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
            return {
              ok: true,
              output: {
                block: true,
                ...(reason !== undefined ? { reason } : {}),
                ...(additionalContext !== undefined ? { additionalContext } : {}),
              },
            };
          }
          return {
            ok: true,
            output: additionalContext !== undefined ? { additionalContext } : {},
          };
        }
      } catch {
        // 非 JSON 文本：整段作为上下文注入
      }
      return { ok: true, output: { additionalContext: text } };
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
    const pluginStartSource =
      input.source === "fork" ? "resume" : (input.source ?? (input.resumed ? "resume" : "startup"));

    const entries: HookRunnerEntry[] = [];
    for (const e of all) {
      if (e.plugin !== undefined) {
        // 插件的 SessionStart / SessionEnd 只在父会话运行，子会话只跑 SubagentStart
        if (input.subagent !== undefined && (point === "SessionStart" || point === "SessionEnd")) {
          continue;
        }
        if (point === "SessionStart" || point === "SubagentStart") {
          const target = point === "SessionStart" ? pluginStartSource : input.agentType;
          try {
            if (!matchPluginMatcher(e.matcher, target)) continue;
          } catch {
            opts.warn?.(
              "hook_failed",
              `Hook ${entryWarnTarget(point, e)}失败：matcher 正则无效（${e.matcher ?? ""}）`,
            );
            continue;
          }
        }
        // UserPromptSubmit 与 SessionEnd 忽略 matcher
        entries.push(e);
      } else if (TOOL_POINTS.has(point)) {
        if (matchTool(e.matcher, input.tool)) entries.push(e);
      } else {
        entries.push(e);
      }
    }
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
    const contextEntries: HookContextEntry[] = [];
    let contextChars = 0;
    let contextDropped = false;
    let spoke = false;

    const collectContext = (entry: HookRunnerEntry, raw: unknown): void => {
      if (typeof raw !== "string" || raw === "") return;
      const truncated =
        raw.length > MAX_HOOK_CONTEXT_ENTRY_CHARS ? raw.length - MAX_HOOK_CONTEXT_ENTRY_CHARS : 0;
      const text = truncated > 0 ? raw.slice(0, MAX_HOOK_CONTEXT_ENTRY_CHARS) : raw;
      if (contextDropped || contextChars + text.length > MAX_HOOK_CONTEXT_TOTAL_CHARS) {
        contextDropped = true;
        opts.diagnostics?.record("hook.context_dropped", {
          point,
          command: entry.command,
          ...(entry.plugin !== undefined ? { plugin: entry.plugin.pluginLabel } : {}),
          chars: text.length,
          totalChars: contextChars,
          limit: MAX_HOOK_CONTEXT_TOTAL_CHARS,
        });
        return;
      }
      contextChars += text.length;
      contextEntries.push({
        hook: entryDisplayLabel(point, entry),
        text,
        ...(truncated > 0 ? { truncated } : {}),
      });
    };

    for (const entry of entries) {
      if (signal?.aborted === true) return undefined;
      const payload =
        entry.plugin !== undefined
          ? buildPluginStdinPayload(point, input)
          : (() => {
              const next = { ...base };
              if (currentInput !== input.input) next.input = currentInput;
              return next;
            })();
      opts.diagnostics?.record("hook.run", {
        point,
        command: entry.command,
        ...(entry.plugin !== undefined ? { plugin: entry.plugin.pluginLabel } : {}),
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
                joined.length > MAX_FEEDBACK_CHARS ? joined.slice(0, MAX_FEEDBACK_CHARS) : joined,
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
        case "UserPromptSubmit": {
          if (out.block === true) {
            spoke = true;
            return { block: true, reason: out.reason };
          }
          collectContext(entry, out.additionalContext);
          if (contextEntries.length > 0) spoke = true;
          break;
        }
        case "SessionStart":
        case "SubagentStart": {
          collectContext(entry, out.additionalContext);
          spoke = true;
          break;
        }
        default:
          // TurnEnd / SessionEnd：忽略所有输出
          spoke = true;
          break;
      }
    }

    if (!spoke) return undefined;
    if (point === "SessionStart" || point === "SubagentStart") {
      if (signal?.aborted === true) return undefined;
      return { contextEntries };
    }
    if (point === "UserPromptSubmit") {
      return contextEntries.length > 0 ? { contextEntries } : undefined;
    }
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
