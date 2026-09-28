/**
 * Shell 种类、探测与调用方式（ADR-0022）。
 *
 * 本模块只产出"数据 + 调用参数"：分隔符方言、分页器名单、大小写
 * 敏感性等元数据随 ShellDescriptor 交给 tools / permission 消费，
 * platform 自身不 import 权限语义（modules.md 依赖方向）。
 *
 * 分层优先级：NOCTURNE_SHELL > config.json（shell/shellPath）>
 * settings.json（shell/shellPath）> 自动选择。
 */
import { Buffer } from "node:buffer";
import { join } from "node:path";
import process from "node:process";

export type ShellKind = "pwsh" | "powershell" | "bash" | "cmd" | "sh";

export const SHELL_KINDS: readonly ShellKind[] = ["pwsh", "powershell", "bash", "cmd", "sh"];

export function isShellKind(value: string): value is ShellKind {
  return (SHELL_KINDS as readonly string[]).includes(value);
}

/** 权限层分词方言（permissions.md 5.3）：PowerShell 与 cmd/POSIX 的分段规则不同 */
export type ShellDialect = "posix" | "cmd" | "powershell";

export interface ShellInvocation {
  executable: string;
  args: string[];
  /** cmd.exe /d /s /c 需要 Windows verbatim 传参；其余走 Node 常规参数转义 */
  verbatimArgs?: boolean;
}

/**
 * 单个 shell 的完整描述（ADR-0022：元数据随描述符交给 tools / permission）。
 * - invoke：命令 → 子进程 argv
 * - syntax / description：模型可见的语法说明（环境信息 Shell 行与切换提示共用）
 * - pagers：管道末段出现即分页器的 basename（小写，含 .com 形态）
 * - flagPagers：需带特定参数才算分页（PowerShell `Out-Host -Paging` / `oh -Paging`）
 * - risk：该种类的高风险命令元数据（ADR-0022 第 1 节，纯数据；匹配在权限层）
 */
export interface ShellDescriptor {
  kind: ShellKind;
  name: string;
  executable: string;
  invoke(command: string): ShellInvocation;
  syntax: string;
  description: string;
  dialect: ShellDialect;
  pagers: readonly string[];
  flagPagers?: readonly { exe: string; flag: RegExp }[];
  /** 内建命令匹配不区分大小写（PowerShell、cmd） */
  caseInsensitiveCommands: boolean;
  risk: ShellRiskProfile;
}

/**
 * 每 shell 种类的高风险命令元数据（ADR-0022 第 1 节：表集中在此）。
 * 纯数据——不含任何权限判定；匹配语义由权限层执行，经 shell 主体透传。
 * 与 protocol/types.ts 的 ShellRiskProfile 结构相同：platform 不能反向依赖
 * protocol，两侧各自声明，结构漂移由 tools 层赋值在编译期暴露。
 */
export interface ShellRiskProfile {
  /** 命令词与模式匹配是否不区分大小写（pwsh / powershell / cmd 为 true） */
  caseInsensitive: boolean;
  /** 段级通配符高风险模式（各 shell 共用基础表，如 "rm -rf *"） */
  basePatterns: readonly string[];
  /** 命令词与开关共存才算高危（cmd：rd/del/erase/rmdir + /s 系开关） */
  switchVerbs?:
    | {
        verbs: readonly string[];
        /** 匹配开关 token 的正则源串（权限层以不区分大小写编译） */
        switchPattern: string;
      }
    | undefined;
  /** 命令词与两个参数共存才算高危（PowerShell：Remove-Item 系 + recurse/force，允许参数前缀缩写） */
  dualParamVerbs?:
    | {
        verbs: readonly string[];
        params: readonly [string, string];
      }
    | undefined;
  /** 恒高危命令词（cmd 的 format；PowerShell 的系统破坏类 cmdlet 与动态执行别名） */
  alwaysVerbs?: readonly string[] | undefined;
}

export interface DetectedShell {
  kind: ShellKind;
  name: string;
  executable?: string | undefined;
  available: boolean;
}

// ── PowerShell 调用包装（ADR-0022 第 1 节） ──────────────

/**
 * 输出编码前奏：stdout/管道输出统一 UTF-8 无 BOM，静默进度流。
 * 选 -EncodedCommand（UTF-16LE Base64）避开 pwsh.exe 启动期输出编码
 * 与参数转义问题；整个包装脚本作为一条命令传给 PowerShell。
 */
const POWERSHELL_PRELUDE = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$ProgressPreference = 'SilentlyContinue'",
].join("\n");

/**
 * 把用户命令包装成 PowerShell 脚本（ADR-0022 退出码语义）：
 * - 命令以 UTF-8 Base64 内嵌，经 ScriptBlock.Create 点源执行，不引入额外引号层；
 * - 执行前用 AST 判定最后一条语句是否原生（Application）命令：
 *   原生命令取它的 $LASTEXITCODE，非原生命令成功为 0、出错为 1；
 *   `$?` 在 Windows PowerShell 5.1 不反映原生命令失败，所以不能只看 $?。
 */
export function powershellScript(command: string): string {
  const b64 = Buffer.from(command, "utf8").toString("base64");
  return `${POWERSHELL_PRELUDE}
$__nc_src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
$__nc_native = $false
try {
  $__nc_t = $null; $__nc_e = $null
  $__nc_a = [System.Management.Automation.Language.Parser]::ParseInput($__nc_src, [ref]$__nc_t, [ref]$__nc_e)
  if ($__nc_e.Count -eq 0) {
    $__nc_s = $__nc_a.EndBlock.Statements | Select-Object -Last 1
    if ($null -ne $__nc_s -and $__nc_s -is [System.Management.Automation.Language.PipelineAst]) {
      $__nc_p = $__nc_s.PipelineElements | Select-Object -Last 1
      if ($__nc_p -is [System.Management.Automation.Language.CommandAst]) {
        $__nc_n = $__nc_p.GetCommandName()
        if (($__nc_n -eq '&' -or $__nc_n -eq '.') -and $__nc_p.CommandElements.Count -gt 1) {
          $__nc_n = $__nc_p.CommandElements[1].Extent.Text -replace '^[''"]|[''"]$'
        }
        if ($null -ne $__nc_n) {
          $__nc_g = @(Get-Command $__nc_n -ErrorAction SilentlyContinue)
          if ($__nc_g.Count -gt 0 -and $__nc_g[0].CommandType -eq 'Application') { $__nc_native = $true }
        }
      }
    }
  }
} catch {}
# $? 只能在脚本块内部、用户语句之后立即读取——脚本块调用本身会把它
# 重置为 $true，块外读不到非终止错误（Write-Error 会被误判为成功）。
# 故在用户脚本尾部追加探针 $__nc_ok = $?；return/exit 早退时保持 $true。
$__nc_ok = $true
try {
  . ([ScriptBlock]::Create($__nc_src + "\`n\`$__nc_ok = \`$?"))
} catch { exit 1 }
if ($__nc_native) {
  if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }
  exit 0
}
if ($__nc_ok) { exit 0 } else { exit 1 }
`;
}

/** -EncodedCommand：包装脚本整体按 UTF-16LE 编码（PowerShell 约定） */
export function encodePowerShellCommand(command: string): string {
  return Buffer.from(powershellScript(command), "utf16le").toString("base64");
}

// ── 每种 shell 的调用方式与元数据 ──────────────────────────

/** Out-Host / oh 需带 -Paging（允许 PowerShell 参数前缀缩写）才算分页器 */
const PS_PAGING_FLAG = /(?:^|\s)-{1,2}p(aging)?(?=[\s:]|$)/i;

/** 各 shell 共用的高风险基础表（ADR-0022 第 6 节：rm -rf / sudo / git 强推与硬重置） */
const RISK_BASE_PATTERNS: readonly string[] = [
  "rm -rf *",
  "rm -fr *",
  "sudo *",
  "git push --force*",
  "git push -f *",
  "git reset --hard*",
];

/** POSIX 系：仅基础表，大小写敏感 */
const POSIX_RISK: ShellRiskProfile = {
  caseInsensitive: false,
  basePatterns: RISK_BASE_PATTERNS,
};

/**
 * PowerShell：在基础表之上——Remove-Item 及其别名（rm/ri/del/erase/rd/rmdir）
 * 同时带 recurse 与 force（允许前缀缩写）才高危；系统破坏类 cmdlet 与
 * Invoke-Expression/iex 恒高危。均不区分大小写。
 */
const POWERSHELL_RISK: ShellRiskProfile = {
  caseInsensitive: true,
  basePatterns: RISK_BASE_PATTERNS,
  dualParamVerbs: {
    verbs: ["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"],
    params: ["recurse", "force"],
  },
  alwaysVerbs: [
    "format-volume",
    "clear-disk",
    "stop-computer",
    "restart-computer",
    "invoke-expression",
    "iex",
  ],
};

/** cmd：rd/del/erase/rmdir 带 /s 系开关才高危；format 恒高危。不区分大小写。 */
const CMD_RISK: ShellRiskProfile = {
  caseInsensitive: true,
  basePatterns: RISK_BASE_PATTERNS,
  switchVerbs: {
    verbs: ["rd", "rmdir", "del", "erase"],
    // 开关 token：/s 或 /s/q 形态（不区分大小写由权限层编译时处理）
    switchPattern: "^/s(?:$|/)",
  },
  alwaysVerbs: ["format"],
};

/** 各方言的高风险表：权限层检查嵌套 shell 调用（`pwsh -c "…"` 等）的命令体时按内层方言取用 */
export const SHELL_RISK_BY_DIALECT: Readonly<Record<ShellDialect, ShellRiskProfile>> = {
  posix: POSIX_RISK,
  cmd: CMD_RISK,
  powershell: POWERSHELL_RISK,
};

interface ShellMeta {
  name(platform: NodeJS.Platform): string;
  shape: string;
  syntax(platform: NodeJS.Platform): string;
  dialect: ShellDialect;
  pagers: readonly string[];
  flagPagers?: readonly { exe: string; flag: RegExp }[];
  caseInsensitiveCommands: boolean;
  risk: ShellRiskProfile;
  invoke(executable: string, command: string): ShellInvocation;
}

const powershellInvoke = (executable: string, command: string): ShellInvocation => ({
  executable,
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodePowerShellCommand(command),
  ],
});

const posixInvoke = (executable: string, command: string): ShellInvocation => ({
  executable,
  args: ["-c", command],
});

const CMD_SYNTAX =
  "use cmd syntax, not bash or PowerShell. `&` runs commands in sequence, not in the background; " +
  "run long-running commands directly and raise timeoutMs when needed. " +
  "findstr patterns use the console code page and cannot match non-ASCII text in UTF-8 output; " +
  "use ASCII patterns only";

const SHELL_META: Record<ShellKind, ShellMeta> = {
  pwsh: {
    name: () => "PowerShell 7 (pwsh)",
    shape: "-NoLogo -NoProfile -NonInteractive -EncodedCommand <base64>",
    syntax: () =>
      "use PowerShell syntax (not cmd or bash); $var for variables; && and || are supported",
    dialect: "powershell",
    pagers: ["more", "more.com"],
    flagPagers: [
      { exe: "out-host", flag: PS_PAGING_FLAG },
      { exe: "oh", flag: PS_PAGING_FLAG },
    ],
    caseInsensitiveCommands: true,
    risk: POWERSHELL_RISK,
    invoke: powershellInvoke,
  },
  powershell: {
    name: () => "Windows PowerShell 5.1",
    shape: "-NoLogo -NoProfile -NonInteractive -EncodedCommand <base64>",
    syntax: () =>
      "use PowerShell syntax (not cmd or bash); $var for variables; && and || are not supported, separate commands with ;",
    dialect: "powershell",
    pagers: ["more", "more.com"],
    flagPagers: [
      { exe: "out-host", flag: PS_PAGING_FLAG },
      { exe: "oh", flag: PS_PAGING_FLAG },
    ],
    caseInsensitiveCommands: true,
    risk: POWERSHELL_RISK,
    invoke: powershellInvoke,
  },
  bash: {
    name: (p) => (p === "win32" ? "Git Bash" : "Bash"),
    shape: '-c "<command>"',
    syntax: (p) =>
      p === "win32"
        ? "use bash syntax; write Windows paths as C:/... or /c/...; arguments starting with / may be rewritten by MSYS path conversion"
        : "use bash syntax",
    dialect: "posix",
    pagers: ["more", "more.com", "less"],
    caseInsensitiveCommands: false,
    risk: POSIX_RISK,
    invoke: posixInvoke,
  },
  cmd: {
    name: () => "cmd.exe",
    shape: '/d /s /c "<command>"',
    syntax: () => CMD_SYNTAX,
    dialect: "cmd",
    pagers: ["more", "more.com"],
    caseInsensitiveCommands: true,
    risk: CMD_RISK,
    invoke: (executable, command) => ({
      executable,
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatimArgs: true,
    }),
  },
  sh: {
    name: () => "POSIX sh",
    shape: '-c "<command>"',
    syntax: () => "use POSIX sh syntax",
    dialect: "posix",
    pagers: ["more", "more.com", "less"],
    caseInsensitiveCommands: false,
    risk: POSIX_RISK,
    invoke: posixInvoke,
  },
};

/** 生成某种 shell 在给定可执行文件下的完整描述符 */
export function shellDescriptor(
  kind: ShellKind,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): ShellDescriptor {
  const meta = SHELL_META[kind];
  const name = meta.name(platform);
  const syntax = meta.syntax(platform);
  return {
    kind,
    name,
    executable,
    invoke: (command) => meta.invoke(executable, command),
    syntax,
    description: `Commands run with ${name} (${executable}) ${meta.shape}: ${syntax}`,
    dialect: meta.dialect,
    pagers: meta.pagers,
    ...(meta.flagPagers !== undefined ? { flagPagers: meta.flagPagers } : {}),
    caseInsensitiveCommands: meta.caseInsensitiveCommands,
    risk: meta.risk,
  };
}

/** 未携带描述符时的平台默认调用（win32→cmd，其余→/bin/sh；等价 ADR-0022 前行为） */
export function defaultShellInvocation(command: string): ShellInvocation {
  return shellDescriptor(
    process.platform === "win32" ? "cmd" : "sh",
    defaultShellExecutable(),
    process.platform,
  ).invoke(command);
}

function defaultShellExecutable(): string {
  return process.platform === "win32"
    ? (process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe")
    : "/bin/sh";
}

// ── 探测（ADR-0022 第 2 节：结果进程内缓存） ────────────────

/** 探测需要的最小能力面（Platform 实例天然满足；测试可注入假实现） */
export interface ShellProbe {
  fs: { exists(path: string): Promise<boolean> };
  env(name: string): string | undefined;
}

async function findOnPath(probe: ShellProbe, name: string): Promise<string | undefined> {
  const win = process.platform === "win32";
  const dirs = (probe.env("PATH") ?? "").split(win ? ";" : ":");
  const exts = win ? (probe.env("PATHEXT") ?? ".EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    if (dir === "") continue;
    for (const ext of new Set(exts.map((e) => e.toUpperCase()))) {
      const candidate = join(dir, name + ext);
      if (await probe.fs.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Git Bash（ADR-0022）：优先由 git.exe 的位置推导——<Git>\cmd\git.exe
 * 与 <Git>\mingw64\bin\git.exe 都向上找 bin\bash.exe；其次常见安装目录。
 * 不做 PATH 上的裸 bash 查找：System32\bash.exe 是 WSL 入口，必须避开。
 */
async function detectGitBash(probe: ShellProbe): Promise<string | undefined> {
  for (const dir of (probe.env("PATH") ?? "").split(";")) {
    if (dir === "") continue;
    if (!(await probe.fs.exists(join(dir, "git.exe")))) continue;
    for (const candidate of [
      join(dir, "..", "bin", "bash.exe"),
      join(dir, "..", "..", "bin", "bash.exe"),
    ]) {
      if (await probe.fs.exists(candidate)) return candidate;
    }
  }
  const localAppData = probe.env("LOCALAPPDATA") ?? "";
  const candidates = [
    join(probe.env("ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(probe.env("ProgramFiles(x86)") ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    ...(localAppData !== "" ? [join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
  ];
  for (const candidate of candidates) {
    if (await probe.fs.exists(candidate)) return candidate;
  }
  return undefined;
}

let detectionCache = new WeakMap<ShellProbe, Promise<DetectedShell[]>>();

/**
 * 探测全部五种 shell 的可用性；结果按探测面进程内缓存。
 * 检测只做文件存在性判断（PATH 查找 + 默认路径），不启动子进程。
 */
export function detectShells(probe: ShellProbe): Promise<DetectedShell[]> {
  const cached = detectionCache.get(probe);
  if (cached !== undefined) return cached;
  const promise = detectShellsUncached(probe);
  detectionCache.set(probe, promise);
  return promise;
}

/** 测试用：清空探测缓存 */
export function resetShellDetectionCache(): void {
  detectionCache = new WeakMap();
}

async function detectShellsUncached(probe: ShellProbe): Promise<DetectedShell[]> {
  const win = process.platform === "win32";
  const entry = (kind: ShellKind, executable: string | undefined): DetectedShell => ({
    kind,
    name: SHELL_META[kind].name(process.platform),
    executable,
    available: executable !== undefined,
  });
  const result: DetectedShell[] = [];
  if (win) {
    const programFilesPwsh = join(
      probe.env("ProgramFiles") ?? "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    const windir = probe.env("SystemRoot") ?? probe.env("WINDIR") ?? "C:\\Windows";
    const powershellExe = join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    result.push(
      entry(
        "pwsh",
        (await findOnPath(probe, "pwsh")) ??
          ((await probe.fs.exists(programFilesPwsh)) ? programFilesPwsh : undefined),
      ),
      // Windows PowerShell 5.1 是系统组件：只探测不自动入选
      entry("powershell", (await probe.fs.exists(powershellExe)) ? powershellExe : undefined),
      entry("bash", await detectGitBash(probe)),
      // cmd：COMSPEC 指向的文件必须真实存在，否则回退 %SystemRoot%\System32\cmd.exe；
      // 两者都不在则不可用（自动选择顺延、显式选择报错列出可选项）
      entry(
        "cmd",
        await (async () => {
          const comspec = probe.env("COMSPEC");
          if (comspec !== undefined && (await probe.fs.exists(comspec))) return comspec;
          const fallback = join(windir, "System32", "cmd.exe");
          return (await probe.fs.exists(fallback)) ? fallback : undefined;
        })(),
      ),
      entry("sh", undefined),
    );
  } else {
    result.push(
      entry("pwsh", await findOnPath(probe, "pwsh")),
      entry("powershell", undefined),
      entry(
        "bash",
        (await findOnPath(probe, "bash")) ??
          ((await probe.fs.exists("/bin/bash")) ? "/bin/bash" : undefined),
      ),
      entry("cmd", undefined),
      entry("sh", (await probe.fs.exists("/bin/sh")) ? "/bin/sh" : await findOnPath(probe, "sh")),
    );
  }
  return result;
}

// ── 分层选择（ADR-0022 第 2 节） ────────────────────────────

export type ShellSource = "env" | "config" | "settings" | "auto";

/** 某一层给出的 shell 声明：kind 缺省而 path 存在时按文件名推断种类 */
export interface ShellSpec {
  kind?: ShellKind | "auto" | undefined;
  path?: string | undefined;
}

export type ShellSpecParse =
  | { kind: "auto" }
  | { kind: ShellKind; path?: string | undefined }
  | { kind: "invalid"; reason: string };

/**
 * NOCTURNE_SHELL / 层内值解析：种类名、"auto"、路径或文件名——
 * 文件名识别去掉目录与 .exe、不区分大小写；含路径分隔符的值同时作为
 * 显式可执行路径记录。
 */
export function parseShellSpec(value: string): ShellSpecParse {
  const v = value.trim();
  if (v === "" || v.toLowerCase() === "auto") return { kind: "auto" };
  const stem = inferShellKindFromPath(v);
  if (stem !== undefined) {
    // 含目录分隔符 → 视为显式路径；裸文件名 → 仅指定种类（用探测到的安装位置）
    return /[\\/]/.test(v) ? { kind: stem, path: v } : { kind: stem };
  }
  return {
    kind: "invalid",
    reason: `NOCTURNE_SHELL="${v}" 无法识别为支持的 shell（可选：auto | ${SHELL_KINDS.join(" | ")}），已回退自动选择`,
  };
}

/**
 * 按可执行文件名（去目录与 .exe、不区分大小写）推断 shell 种类；
 * 无法识别时返回 undefined。config/settings 的 shellPath-only 推断与它共用。
 */
export function inferShellKindFromPath(pathOrName: string): ShellKind | undefined {
  const base = pathOrName.split(/[\\/]/).at(-1) ?? pathOrName;
  const stem = base.toLowerCase().endsWith(".exe")
    ? base.slice(0, -4).toLowerCase()
    : base.toLowerCase();
  return isShellKind(stem) ? stem : undefined;
}

/**
 * config.json / settings.json 的 {shell, shellPath} → ShellSpec。
 * 返回 undefined 表示该层没有可用的 shell 声明（落到下一层）：
 * shellPath-only 且文件名可识别时按文件名推断种类；文件名不可识别时
 * 返回 undefined——调用层须发警告，不能静默回退自动选择。
 */
export function specFromConfigFields(
  shell: string | undefined,
  shellPath: string | undefined,
): ShellSpec | undefined {
  if (shell === undefined && shellPath === undefined) return undefined;
  if (shell !== undefined) {
    const lower = shell.toLowerCase();
    if (lower === "auto") return { kind: "auto" };
    if (isShellKind(lower)) {
      return { kind: lower, ...(shellPath !== undefined ? { path: shellPath } : {}) };
    }
    // 无法识别的种类名：该层无有效声明——忽略并落到下一层（config 层
    // schema 已先行拒绝非法值；settings 层加载时已警告）。不能伪装成
    // auto 声明，否则一份坏值反而压住下层合法选择
    return undefined;
  }
  // 只有 shellPath：文件名能识别出种类才推断；识别不了不算有效声明
  const inferred = inferShellKindFromPath(shellPath ?? "");
  return inferred === undefined ? undefined : { kind: inferred, path: shellPath };
}

export interface ShellResolution {
  /** 生效 shell；显式选择不可用时为 undefined（此时 error 给出可选项） */
  descriptor?: ShellDescriptor | undefined;
  error?: string | undefined;
  /** 生效选择的来源层 */
  source: ShellSource;
  /** 生效层声明的选择值（auto 或具体种类） */
  selected: ShellKind | "auto";
  /**
   * 生效层为 env / config 时给出该来源——写入 settings.json 的选择
   * 在它之上不生效（无论 settings 当前是否有值）；UI 据此显示
   * 「当前由 NOCTURNE_SHELL / config.json 指定」。
   */
  overriddenBy?: "env" | "config" | undefined;
}

export interface ShellResolver {
  /** 当前生效解析——每次 shell 调用时取值（不在 Turn 开始时快照） */
  current(): ShellResolution;
  /**
   * 试解析某个选择值（"auto" 或种类名）的可用性：可执行文件存在时
   * 返回 descriptor，否则返回含可选项的 error。只查不写——
   * setShell 在写 settings 之前用它拒绝不可用目标。
   */
  probe(kind: ShellKind | "auto"): { descriptor?: ShellDescriptor | undefined; error?: string };
  /** 全部种类的探测结果（含不可用的；listShells / /shell 用） */
  list(): readonly DetectedShell[];
  /** 环境信息 Shell 行文本（会话打开时生成一次） */
  environmentLine(): string;
}

function autoOrder(platform: NodeJS.Platform): readonly ShellKind[] {
  return platform === "win32" ? ["pwsh", "bash", "cmd"] : ["sh"];
}

export function createShellResolver(opts: {
  platform: NodeJS.Platform;
  envValue?: string | undefined;
  /** config.json 层值（wrapSession 时快照） */
  config?: ShellSpec | undefined;
  /** settings.json 层值（live getter：/shell 写入后立即可见） */
  settings(): ShellSpec | undefined;
  detected: readonly DetectedShell[];
  /** 显式路径存在性探测（装配层一次性预探测后同步可查） */
  pathExists(path: string): boolean;
  onWarning?: ((message: string) => void) | undefined;
}): ShellResolver {
  const detectedByKind = new Map(opts.detected.map((d) => [d.kind, d]));
  const availableList = (): string =>
    opts.detected
      .filter((d) => d.available)
      .map((d) => d.kind)
      .join(" | ") || "（无）";

  const explicitError = (spec: ShellSpec, reason: string): string =>
    `指定的 shell ${String(spec.kind)}${spec.path !== undefined ? `（${spec.path}）` : ""}${reason}；` +
    `可用 shell：${availableList()}`;

  const materialize = (
    kind: ShellKind,
    path: string | undefined,
  ): { descriptor?: ShellDescriptor; error?: string } => {
    if (path !== undefined) {
      if (!opts.pathExists(path)) {
        return { error: explicitError({ kind, path }, "的可执行文件不存在") };
      }
      return { descriptor: shellDescriptor(kind, path, opts.platform) };
    }
    const executable = detectedByKind.get(kind)?.executable;
    if (executable === undefined) {
      return { error: explicitError({ kind }, "未安装") };
    }
    return { descriptor: shellDescriptor(kind, executable, opts.platform) };
  };

  const autoPick = (): { descriptor?: ShellDescriptor; error?: string } => {
    for (const kind of autoOrder(opts.platform)) {
      const executable = detectedByKind.get(kind)?.executable;
      if (executable !== undefined) {
        return { descriptor: shellDescriptor(kind, executable, opts.platform) };
      }
    }
    return { error: `未探测到可用 shell（${autoOrder(opts.platform).join(" | ")} 均不可用）` };
  };

  const current = (): ShellResolution => {
    let spec: ShellSpec | undefined;
    let source: ShellSource;
    const envValue = opts.envValue?.trim();
    if (envValue !== undefined && envValue !== "") {
      source = "env";
      const parsed = parseShellSpec(envValue);
      if (parsed.kind === "invalid" || parsed.kind === "auto") {
        spec = { kind: "auto" };
      } else {
        spec = { kind: parsed.kind, ...(parsed.path !== undefined ? { path: parsed.path } : {}) };
      }
    } else if (opts.config !== undefined) {
      spec = opts.config;
      source = "config";
    } else {
      const s = opts.settings();
      if (s !== undefined) {
        spec = s;
        source = "settings";
      } else {
        spec = { kind: "auto" };
        source = "auto";
      }
    }

    const selected = spec.kind ?? "auto";
    const resolved =
      spec.kind === undefined || spec.kind === "auto"
        ? autoPick()
        : materialize(spec.kind, spec.path);

    // 生效层是 env / config 时：settings 层（/shell 的写入目标）的选择
    // 被覆盖——无论它当前是否有值都报告，供 UI 提示「写入不生效」
    const overriddenBy = source === "env" || source === "config" ? source : undefined;

    return {
      ...(resolved.descriptor !== undefined ? { descriptor: resolved.descriptor } : {}),
      ...(resolved.error !== undefined ? { error: resolved.error } : {}),
      source,
      selected,
      ...(overriddenBy !== undefined ? { overriddenBy } : {}),
    };
  };

  // 非法 NOCTURNE_SHELL：resolver 建立时向装配层报告一次（"启动时一条警告"）
  const envValue = opts.envValue?.trim();
  if (envValue !== undefined && envValue !== "") {
    const parsed = parseShellSpec(envValue);
    if (parsed.kind === "invalid") opts.onWarning?.(parsed.reason);
  }

  return {
    current,
    probe: (kind) => (kind === "auto" ? autoPick() : materialize(kind, undefined)),
    list: () => opts.detected,
    environmentLine: () => {
      const res = current();
      if (res.descriptor !== undefined) return res.descriptor.description;
      return `Shell: ${res.error ?? "no usable shell detected"}`;
    },
  };
}

/**
 * fold 进历史时的切换说明（ADR-0022 第 4 节）：措辞与环境信息的语法
 * 说明一致，恢复会话后旧提示原样保留。
 */
export function shellSwitchNote(
  kind: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const meta = isShellKind(kind) ? SHELL_META[kind] : undefined;
  if (meta === undefined) return `[Environment change] shell is now ${kind} (${path})`;
  return `[Environment change] shell is now ${meta.name(platform)} (${path}); ${meta.syntax(platform)}`;
}
