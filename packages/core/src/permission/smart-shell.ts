/**
 * smart 预设的 shell 路由（ADR-0057）：纯数据表 + 纯函数，不按工具名分支。
 *
 * 一条 shell 命令走三条通道之一：
 *   - `user`：直接交人，不送审（递归删除非构建产物、dd/mkfs、动态执行等）；
 *   - `allow`：只读白名单，或未被污染的「运行工作区代码」命令；
 *   - `review`：其余一律送审。
 *
 * 白名单逐段匹配（复用 shellSegments / shellDialect）：每段都必须命中，
 * 任一段写文件重定向、带变量展开或触及凭据文件名都不算命中。
 * PowerShell / cmd 的命令词不区分大小写，POSIX 保持大小写敏感。
 */
import type { ShellDialect } from "./pattern.js";
import {
  isOpaquePowerShellCommand,
  nestedShellPayloads,
  normalizePathText,
  shellSegments,
  stageExecutable,
} from "./pattern.js";
import { computeWhere } from "./where.js";

// ── 白名单数据表 ──────────────────────────────────────────

/** 白名单条目：命令词 + 可选的合法子命令 + 禁用参数。 */
export interface SmartReadonlyEntry {
  /** 命令词（小写）。 */
  command: string;
  /** 仅这些方言生效；缺省全部方言。 */
  dialects?: readonly ShellDialect[] | undefined;
  /** 第一个参数必须是其中之一（git status 之类）；缺省不限制。 */
  subcommands?: readonly string[] | undefined;
  /** 整条命令恰好是这些参数列表之一（版本查询：node -v）。 */
  exactArgs?: readonly (readonly string[])[] | undefined;
  /** 出现即不算只读的参数（小写比较，前缀匹配 `--output=`）。 */
  bannedArgs?: readonly string[] | undefined;
}

const FIND_BANNED = [
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
];

/** 文件与文本只读命令（规则文件 §2）。 */
const FILE_TEXT: readonly SmartReadonlyEntry[] = [
  { command: "ls" },
  { command: "dir", dialects: ["cmd", "powershell"] },
  { command: "cat" },
  { command: "type", dialects: ["cmd", "powershell"] },
  { command: "head" },
  { command: "tail" },
  { command: "wc" },
  { command: "rg", bannedArgs: ["--pre", "--hostname-bin"] },
  { command: "grep" },
  { command: "find", bannedArgs: FIND_BANNED },
  { command: "get-childitem", dialects: ["powershell"] },
  { command: "get-content", dialects: ["powershell"] },
  { command: "select-string", dialects: ["powershell"] },
  { command: "test-path", dialects: ["powershell"] },
];

/** git 只读子命令；`add` / `commit` 是工作区内可撤回的写操作（提示词提交 1）。 */
const GIT_SUBCOMMANDS = [
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "ls-files",
  "blame",
  "add",
  "commit",
] as const;

/** 其他只读：echo / pwd / which 族 / 版本查询。 */
const MISC: readonly SmartReadonlyEntry[] = [
  { command: "echo" },
  { command: "pwd" },
  { command: "which" },
  { command: "where", dialects: ["cmd", "powershell"] },
  { command: "get-command", dialects: ["powershell"] },
  ...["node", "pnpm", "npm", "yarn", "cargo", "tsc", "vitest"].map(
    (command): SmartReadonlyEntry => ({
      command,
      exactArgs: [["-v"], ["--version"], ...(command === "tsc" ? [["-version"]] : [])],
    }),
  ),
];

export const SMART_READONLY_COMMANDS: readonly SmartReadonlyEntry[] = [
  ...FILE_TEXT,
  { command: "git", subcommands: GIT_SUBCOMMANDS },
  ...MISC,
];

/** 参数里出现这些文件名即不走白名单（交审查器回答「是否触及凭据」）。 */
const SENSITIVE_NAME =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)[^\\/]*|credentials(?:\.json)?|[^\\/]*\.(?:pem|key|p12|pfx)|\.ssh|\.aws|\.kube|\.gnupg|authorized_keys|sudoers)(?:[\\/]|$)/i;

/** 未展开的变量或命令替换：`$X`、`${X}`、`$(…)`、`$env:X`、`%X%`、反引号。 */
const VARIABLE_TEXT = /\$[^\s'"]|%[A-Za-z_][^%\s]*%|`/;

/** 重定向到空设备或 fd 合并不算写文件。 */
const NULL_REDIRECT = /\d*>>?\s*(?:\/dev\/null|nul|\$null)(?![\w./\\-])/gi;
const FD_MERGE = /\d*>&(?:\d+|-)/g;

// ── 词法小工具 ────────────────────────────────────────────

/** 段内词：去引号，保留 Windows 路径的反斜杠。 */
function segmentWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  for (const c of segment) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    current += c;
    started = true;
  }
  flush();
  return words;
}

function commandWord(word: string): { bare: boolean; name: string } {
  const bare = !/[\\/]/.test(word);
  const name = (word.split(/[\\/]/).at(-1) ?? word).replace(/\.(?:exe|com|bat|cmd|ps1)$/i, "");
  return { bare, name: name.toLowerCase() };
}

/** 去掉空设备重定向与 fd 合并后的文本。 */
function withoutBenignRedirects(text: string): string {
  return text.replaceAll(FD_MERGE, " ").replaceAll(NULL_REDIRECT, " ");
}

/** 段内（引号外）是否有写文件的重定向。 */
function writesFile(segment: string): boolean {
  const text = withoutBenignRedirects(segment);
  let quote: "'" | '"' | undefined;
  for (const c of text) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === ">") return true;
  }
  return false;
}

/** 紧凑短选项簇（-vvd）是否含任一字母。 */
function clusterHas(word: string, letters: string): boolean {
  return (
    /^-[A-Za-z]+$/.test(word) &&
    word
      .slice(1)
      .split("")
      .some((c) => letters.includes(c))
  );
}

// ── 只读白名单 ────────────────────────────────────────────

function gitReadonlyArgs(sub: string, args: string[]): boolean {
  if (sub === "branch") {
    return !args.some(
      (a) =>
        clusterHas(a, "dDmMcCfu") ||
        ["--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream"].some(
          (flag) => a === flag || a.startsWith(`${flag}=`),
        ),
    );
  }
  if (sub === "remote")
    return args.length === 0 || (args.length === 1 && /^(?:-v|--verbose)$/.test(args[0] ?? ""));
  if (sub === "commit") {
    return !args.some(
      (a) =>
        a === "--no-verify" ||
        a === "--amend" ||
        clusterHas(a, "n") ||
        a.startsWith("--no-verify="),
    );
  }
  // diff / log / show 的 --output 会写文件
  return !args.some((a) => a === "--output" || a.startsWith("--output="));
}

/** 单段是否命中白名单。 */
export function matchSmartReadonlySegment(
  segment: string,
  dialect: ShellDialect = "posix",
): boolean {
  const cleaned = withoutBenignRedirects(segment);
  if (writesFile(segment) || VARIABLE_TEXT.test(cleaned)) return false;
  const words = segmentWords(segment);
  const first = words[0];
  if (first === undefined) return false;
  const { bare, name } = commandWord(first);
  if (!bare) return false;
  const fold = dialect !== "posix";
  const args = words.slice(1);
  if (args.some((a) => SENSITIVE_NAME.test(a))) return false;
  for (const entry of SMART_READONLY_COMMANDS) {
    if (entry.dialects !== undefined && !entry.dialects.includes(dialect)) continue;
    const got = fold ? name : (first.split(/[\\/]/).at(-1) ?? first).replace(/\.exe$/i, "");
    if (got !== entry.command) continue;
    const lowered = args.map((a) => a.toLowerCase());
    if (entry.exactArgs !== undefined) {
      return entry.exactArgs.some(
        (exact) => exact.length === lowered.length && exact.every((x, i) => x === lowered[i]),
      );
    }
    if (entry.bannedArgs !== undefined) {
      const banned = entry.bannedArgs;
      if (lowered.some((a) => banned.some((b) => a === b || a.startsWith(`${b}=`)))) return false;
    }
    if (entry.subcommands !== undefined) {
      const sub = fold ? lowered[0] : args[0];
      if (sub === undefined || !entry.subcommands.includes(sub)) return false;
      if (entry.command === "git") return gitReadonlyArgs(sub, args.slice(1));
    }
    return true;
  }
  return false;
}

// ── 会运行工作区代码的命令 ────────────────────────────────

/** 包管理器脚本动作；其余（exec、dlx、install、publish…）一律送审。 */
const SCRIPT_ACTIONS = ["test", "typecheck", "lint", "build", "run"] as const;
/** 包管理器前置选项里带值的那几个。 */
const PM_VALUE_FLAGS = ["--filter", "-f", "-c", "--dir", "--prefix", "-w", "--workspace"];

/** 可指定工作区外输出位置的参数不走代码运行器白名单。 */
const TSC_OUTPUT_FLAGS = [
  "--outdir",
  "--outfile",
  "--out",
  "--declarationdir",
  "--tsbuildinfofile",
  "--generatetrace",
];
const VITEST_OUTPUT_FLAGS = ["--outputfile", "--coverage.reportsdirectory"];

export interface CodeRunner {
  /** `node <file>` 的脚本路径（原样）；其余运行器为 undefined。 */
  nodeTarget?: string | undefined;
}

/** 单段是否运行工作区代码；不是返回 undefined。 */
export function matchCodeRunnerSegment(
  segment: string,
  dialect: ShellDialect = "posix",
): CodeRunner | undefined {
  const cleaned = withoutBenignRedirects(segment);
  if (writesFile(segment) || VARIABLE_TEXT.test(cleaned)) return undefined;
  const words = segmentWords(segment);
  const first = words[0];
  if (first === undefined) return undefined;
  const { bare, name } = commandWord(first);
  if (!bare) return undefined;
  const fold = dialect !== "posix";
  const exe = fold ? name : (first.split(/[\\/]/).at(-1) ?? first).replace(/\.exe$/i, "");
  const args = words.slice(1);
  if (args.some((a) => SENSITIVE_NAME.test(a))) return undefined;
  const lowered = args.map((a) => a.toLowerCase());
  if (exe === "pnpm" || exe === "npm" || exe === "yarn") {
    let i = 0;
    while (i < lowered.length && (lowered[i] ?? "").startsWith("-")) {
      const flag = lowered[i] ?? "";
      i += PM_VALUE_FLAGS.includes(flag) ? 2 : 1;
    }
    const action = lowered[i];
    return action !== undefined && (SCRIPT_ACTIONS as readonly string[]).includes(action)
      ? {}
      : undefined;
  }
  if (exe === "cargo") return lowered[0] === "check" || lowered[0] === "test" ? {} : undefined;
  if (exe === "tsc")
    return lowered[0] === "--init" ||
      lowered.some((arg) => TSC_OUTPUT_FLAGS.includes(arg.split("=")[0] ?? ""))
      ? undefined
      : {};
  if (exe === "vitest")
    return lowered.some((arg) => VITEST_OUTPUT_FLAGS.includes(arg.split("=")[0] ?? ""))
      ? undefined
      : {};
  if (exe === "node") {
    const target = args[0];
    if (target === undefined || target.startsWith("-")) return undefined;
    return { nodeTarget: target };
  }
  return undefined;
}

// ── 路径 ──────────────────────────────────────────────────

export interface SmartShellContext {
  workspaceRoot: string;
  caseSensitive: boolean;
  /** 会话 cwd；缺省时相对路径无法解析。 */
  cwd?: string | undefined;
  /** 本会话放行过的 edit 目标（已按 normalizePathText 规范化）。 */
  approvedEdits?: ReadonlySet<string> | undefined;
}

/** 词法解析目标路径；含 `~`、变量、通配符或无法确定 cwd 时返回 undefined。 */
function resolveLexical(target: string, ctx: SmartShellContext): string | undefined {
  if (target === "" || /^[~$%]|`|[*?[\]]/.test(target) || VARIABLE_TEXT.test(target))
    return undefined;
  const absolute = /^(?:[\\/]|[A-Za-z]:[\\/])/.test(target);
  if (absolute) return normalizePathText(target, ctx.caseSensitive);
  if (ctx.cwd === undefined || ctx.cwd === "") return undefined;
  return normalizePathText(`${ctx.cwd}/${target}`, ctx.caseSensitive);
}

function insideWorkspace(normalized: string, ctx: SmartShellContext): boolean {
  return computeWhere(normalized, ctx.workspaceRoot, ctx.caseSensitive) === "workspace";
}

// ── 直接交人 ──────────────────────────────────────────────

/** 递归删除目标是这些目录名之一才可送审（规则文件 §3）。 */
export const BUILD_ARTIFACT_DIRS: readonly string[] = [
  "dist",
  "build",
  "out",
  "node_modules",
  "target",
  ".turbo",
  ".cache",
  "coverage",
];

const DELETE_WORDS = new Set([
  "rm",
  "rmdir",
  "rd",
  "del",
  "erase",
  "ri",
  "remove-item",
  "unlink",
  "shred",
]);
const OVERWRITE_WORDS = new Set([
  "cp",
  "mv",
  "copy",
  "move",
  "xcopy",
  "robocopy",
  "ln",
  "install",
  "truncate",
  "tee",
  "tee-object",
  "set-content",
  "add-content",
  "out-file",
  "copy-item",
  "move-item",
  "rename-item",
  "new-item",
]);
const DANGEROUS_WORDS = new Set([
  "dd",
  "format",
  "format-volume",
  "diskpart",
  "shutdown",
  "reboot",
  "stop-computer",
  "restart-computer",
]);
const DYNAMIC_EXEC_WORDS = new Set(["iex", "invoke-expression", "eval"]);

function isRecursiveFlag(word: string, dialect: ShellDialect): boolean {
  if (dialect === "cmd") return /^\/s$/i.test(word);
  // PowerShell：-r 到 -Recurse 的任意前缀；POSIX：-r / -R / -rf 簇或 --recursive
  if (dialect === "powershell") return /^-r[a-z]*$/i.test(word);
  return /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(word) || word === "--recursive";
}

function isFlagWord(word: string, dialect: ShellDialect): boolean {
  if (dialect === "cmd") return /^\/[A-Za-z?]$/.test(word);
  return word.startsWith("-");
}

/** 把原文按引号外的 `&& || ; | & 换行` 切段，`$(…)` 与反引号整体保留在段内。 */
function rawStages(command: string): string[] {
  const stages: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote !== undefined) {
      current += c;
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      depth++;
      current += "$(";
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === ")") depth--;
      current += c;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
      if (current.trim() !== "") stages.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") stages.push(current);
  return stages;
}

function recursiveDeleteReason(
  segment: string,
  dialect: ShellDialect,
  ctx: SmartShellContext,
): string | undefined {
  const words = segmentWords(segment);
  const args = words.slice(1);
  if (!args.some((a) => isRecursiveFlag(a, dialect))) return undefined;
  const targets = args.filter((a) => !isFlagWord(a, dialect));
  if (targets.length === 0) return "递归删除没有明确目标";
  for (const target of targets) {
    const resolved = resolveLexical(target, ctx);
    if (resolved === undefined || !insideWorkspace(resolved, ctx)) {
      return `递归删除「${target}」不在工作区内或无法确定位置`;
    }
    const last = resolved.split("/").at(-1)?.toLowerCase() ?? "";
    if (!BUILD_ARTIFACT_DIRS.includes(last)) return `递归删除「${target}」不是构建产物`;
  }
  return undefined;
}

/**
 * 直接交人（规则文件 §3，跳过审查）：返回原因，不命中返回 undefined。
 * 含嵌套 shell 调用（pwsh -c "…"、bash -c "…"）的命令体，最多三层。
 */
export function smartDirectToUser(
  command: string,
  dialect: ShellDialect,
  ctx: SmartShellContext,
  depth = 0,
): string | undefined {
  if (isOpaquePowerShellCommand(command)) return "-EncodedCommand 内容不透明";
  const segments = shellSegments(command, dialect);
  for (const segment of segments) {
    if (stageExecutable(segment) === undefined) continue;
    const first = segmentWords(segment)[0];
    if (first === undefined) continue;
    const { name } = commandWord(first);
    if (DANGEROUS_WORDS.has(name) || name.startsWith("mkfs")) return `危险系统命令 ${name}`;
    if (DYNAMIC_EXEC_WORDS.has(name)) return `动态执行 ${name}`;
    if (DELETE_WORDS.has(name)) {
      const reason = recursiveDeleteReason(segment, dialect, ctx);
      if (reason !== undefined) return reason;
    }
    if ((DELETE_WORDS.has(name) || OVERWRITE_WORDS.has(name)) && VARIABLE_TEXT.test(segment)) {
      return `${name} 的目标含未展开的变量或命令替换`;
    }
  }
  // `$(…)` 与反引号会被 shellSegments 切碎，变量检查再按原文段落补一遍
  for (const stage of rawStages(command)) {
    const exe = stageExecutable(stage);
    const first = segmentWords(stage)[0];
    const name = first === undefined ? exe?.toLowerCase() : commandWord(first).name;
    if (
      name !== undefined &&
      (DELETE_WORDS.has(name) || OVERWRITE_WORDS.has(name)) &&
      VARIABLE_TEXT.test(stage)
    ) {
      return `${name} 的目标含未展开的变量或命令替换`;
    }
    if (/\d*>>?\s*\S*(?:\$[^\s'"]|%[A-Za-z_][^%\s]*%|`)/.test(withoutBenignRedirects(stage))) {
      return "重定向写入的目标含未展开的变量或命令替换";
    }
  }
  if (depth < 3) {
    for (const nested of nestedShellPayloads(command)) {
      const reason = smartDirectToUser(nested.payload, nested.dialect, ctx, depth + 1);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

// ── 分类 ──────────────────────────────────────────────────

export type SmartShellVerdict =
  | { kind: "user"; reason: string }
  | { kind: "allow"; description: string }
  | { kind: "review"; note?: string | undefined };

function isPackageJson(path: string): boolean {
  return path.split("/").at(-1)?.toLowerCase() === "package.json";
}

/** 本会话放行过的 edit 是否让「运行工作区代码」不再可信；返回原因。 */
function codeRunnerTaint(
  runners: readonly CodeRunner[],
  ctx: SmartShellContext,
): string | undefined {
  const edits = ctx.approvedEdits;
  if (edits === undefined || edits.size === 0) {
    // 无记录：node 目标仍要求能解析到工作区内
    for (const runner of runners) {
      if (runner.nodeTarget === undefined) continue;
      const resolved = resolveLexical(runner.nodeTarget, ctx);
      if (resolved === undefined || !insideWorkspace(resolved, ctx)) {
        return `node 执行的「${runner.nodeTarget}」不在工作区内或无法确定位置`;
      }
    }
    return undefined;
  }
  for (const edited of edits) {
    if (isPackageJson(edited)) return "本会话放行过对 package.json 的修改";
  }
  for (const runner of runners) {
    if (runner.nodeTarget === undefined) continue;
    const resolved = resolveLexical(runner.nodeTarget, ctx);
    if (resolved === undefined || !insideWorkspace(resolved, ctx)) {
      return `node 执行的「${runner.nodeTarget}」不在工作区内或无法确定位置`;
    }
    for (const edited of edits) {
      if (edited === resolved || edited.startsWith(`${resolved}/`)) {
        return `node 执行的「${runner.nodeTarget}」在本会话被放行过修改`;
      }
    }
  }
  return undefined;
}

/**
 * 整条命令的路由：直接交人 > 只读白名单（含工作区代码命令） > 送审。
 * 每一段都必须是白名单或代码运行器；空命令送审。
 */
export function classifySmartShell(
  command: string,
  dialect: ShellDialect,
  ctx: SmartShellContext,
): SmartShellVerdict {
  const direct = smartDirectToUser(command, dialect, ctx);
  if (direct !== undefined) return { kind: "user", reason: direct };
  // `2>&1` 的 `&` 会被拆段：先把 fd 合并抹掉再切
  const segments = shellSegments(command.replaceAll(FD_MERGE, " "), dialect).filter(
    (s) => stageExecutable(s) !== undefined,
  );
  if (segments.length === 0) return { kind: "review" };
  const runners: CodeRunner[] = [];
  for (const segment of segments) {
    if (matchSmartReadonlySegment(segment, dialect)) continue;
    const runner = matchCodeRunnerSegment(segment, dialect);
    if (runner === undefined) return { kind: "review" };
    runners.push(runner);
  }
  if (runners.length === 0) return { kind: "allow", description: "预设 smart 只读命令" };
  const taint = codeRunnerTaint(runners, ctx);
  if (taint !== undefined) return { kind: "review", note: `${taint}，运行工作区代码的命令需审查` };
  return { kind: "allow", description: "预设 smart 只读命令（运行工作区脚本）" };
}
