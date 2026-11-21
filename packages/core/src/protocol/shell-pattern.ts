/**
 * Shell 命令模式匹配、组合命令分段、高风险判定与规则建议（纯函数，无 I/O 与 Node 依赖）。
 * 供权限层与客户端共用（ADR-0022、ADR-0106）。
 */
import type { PermissionSubject, ShellRiskProfile } from "./types.js";

/**
 * shell 字符串通配符匹配（多项式时间有界，避免回溯型 RegExp 在多 `*` 未命中输入上的指数退化）：
 * `*` 匹配任意字符序列（含换行），`?` 匹配任意单个 UTF-16 码元（含换行），大小写敏感，
 * 其余字符一律按字面匹配。
 */
export function matchShellPattern(pattern: string, command: string): boolean {
  let p = 0;
  let s = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (s < command.length) {
    if (p < pattern.length && pattern.charCodeAt(p) === 42 /* * */) {
      starIdx = p;
      matchIdx = s;
      p++;
    } else if (
      p < pattern.length &&
      (pattern.charCodeAt(p) === 63 /* ? */ || pattern.charCodeAt(p) === command.charCodeAt(s))
    ) {
      p++;
      s++;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      matchIdx++;
      s = matchIdx;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern.charCodeAt(p) === 42 /* * */) {
    p++;
  }
  return p === pattern.length;
}

/**
 * shell 分词方言（ADR-0022）：命令主体携带执行它的 shell 种类，
 * 权限层据此选择分段规则；缺省/未知一律按 POSIX 保守处理。
 */
export type ShellDialect = "posix" | "cmd" | "powershell";

export function shellDialect(kind: string | undefined): ShellDialect {
  if (kind === "pwsh" || kind === "powershell") return "powershell";
  if (kind === "cmd") return "cmd";
  return "posix";
}

const COMPOSITE_SHELL_POSIX = /&&|\|\||[;&|`<>]|\$\(|\r|\n/;
// PowerShell 额外切开脚本块 { } —— & 与 ` 不作为命令边界的差异点不拆开列：
// `&` 在两种方言里一律切开（PowerShell 7 中 `a & b` 是后台运算符，拆开更保守；
// `&` 调用运算符后面的内容切出后照常作为一段求值）
const COMPOSITE_SHELL_POWERSHELL = /&&|\|\||[;&|`<>{}]|\$\(|\r|\n/;

/**
 * shell 组合命令判定（permissions.md 5.3）：含 `&&`、`||`、`;`、`|`、
 * 反引号、`$(`、重定向、换行等控制符时，基于模式的 allow 不适用（按 ask 对待）。
 * 保守起见沿用原始文本判定：引号内的控制符同样触发组合判定。
 * dialect === "powershell" 时脚本块 `{` `}` 也算组合。
 */
export function isCompositeShell(command: string, dialect: ShellDialect = "posix"): boolean {
  return (dialect === "powershell" ? COMPOSITE_SHELL_POWERSHELL : COMPOSITE_SHELL_POSIX).test(
    command,
  );
}

// ── shell 命令的轻量词法切分 ──────────────────────────────
//
// 供 shell 工具的末尾分页预检（tools.md 第 6 节）使用。权限层的
// shellSegments 不用它：引号内的命令同样会被执行，拆段必须保守。

/** 词法记号：文本片段或控制分隔符，都保留原文 */
export interface ShellToken {
  /** 原文；分隔符记号保留原分隔符（"|" 与 "||" 可区分） */
  text: string;
  /** true = 控制分隔符；false = 普通文本片段（含引号原文） */
  separator: boolean;
}

/** 双字符分隔符（先于单字符匹配） */
const SHELL_SEPARATORS_2 = new Set(["&&", "||", "$("]);
/** 单字符分隔符；不含 < > ——重定向不是命令边界 */
const SHELL_SEPARATORS_1 = new Set(["&", "|", ";", "`", "(", ")", "\r", "\n"]);
/** 引号外反斜杠的转义对象（bash）：转义后是普通文本，不起分隔作用 */
const BARE_ESCAPES = new Set([
  "&",
  "|",
  ";",
  "(",
  ")",
  "`",
  "$",
  "<",
  ">",
  "'",
  '"',
  "\\",
  " ",
  "\t",
  "\r",
  "\n",
]);
/** 双引号内反斜杠的转义对象（bash）；其余 \x 原样保留（Windows 路径不受影响） */
const DQUOTE_ESCAPES = new Set(['"', "\\", "$", "`", "\r", "\n"]);

/** 把命令行切成文本片段与分隔符记号（引号感知） */
export function lexShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let buf = "";
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (buf !== "") {
      tokens.push({ text: buf, separator: false });
      buf = "";
    }
  };
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    const next = command[i + 1];
    if (quote === "'") {
      buf += c;
      if (c === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        if (next === '"') {
          // cmd 风格的 "" 转义引号：仍在引号内
          buf += '""';
          i++;
        } else {
          buf += c;
          quote = undefined;
        }
        continue;
      }
      buf += c;
      if (c === "\\" && next !== undefined && DQUOTE_ESCAPES.has(next)) {
        buf += next;
        i++;
      }
      continue;
    }
    if (c === "\\" && next !== undefined && BARE_ESCAPES.has(next)) {
      buf += c + next;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      buf += c;
      quote = c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (SHELL_SEPARATORS_2.has(two)) {
      flush();
      tokens.push({ text: two, separator: true });
      i++;
      continue;
    }
    if (SHELL_SEPARATORS_1.has(c)) {
      flush();
      tokens.push({ text: c, separator: true });
      continue;
    }
    buf += c;
  }
  flush();
  return tokens;
}

const SHELL_SEPARATORS_POSIX = /&&|\|\||\$\(|[;&|`()\r\n]/;
// PowerShell（ADR-0022 第 6 节）：; | && || $( 之外另切脚本块 { }；
// `&` 仍切（调用运算符与后台运算符后的内容都照常成段求值）
const SHELL_SEPARATORS_POWERSHELL = /&&|\|\||\$\(|[;&|`(){}\r\n]/;

/**
 * 组合命令拆段（全放行规则下逐段求值用）：按控制符切开、去空白。
 * 刻意不做引号感知：`sh -c "cd x; rm -rf build"` 要切出 `rm -rf build"`
 * 才能命中高风险表，引号内的命令同样会被执行。
 * 重定向目标（`2>&1`、`> out.txt`）会成为独立短段，照常求值即可。
 */
export function shellSegments(command: string, dialect: ShellDialect = "posix"): string[] {
  return command
    .split(dialect === "powershell" ? SHELL_SEPARATORS_POWERSHELL : SHELL_SEPARATORS_POSIX)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** 首个词去引号：空白或重定向符结束；引号/转义规则与 lexShellCommand 相同 */
function firstWord(text: string): string | undefined {
  let word = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const next = text[i + 1];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        if (next === '"') {
          word += '"';
          i++;
        } else {
          quote = undefined;
        }
        continue;
      }
      if (c === "\\" && next !== undefined && DQUOTE_ESCAPES.has(next)) {
        word += next;
        i++;
        continue;
      }
      word += c;
      continue;
    }
    if (/\s/.test(c) || c === "<" || c === ">") break;
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\" && next !== undefined && BARE_ESCAPES.has(next)) {
      word += next;
      i++;
      continue;
    }
    word += c;
  }
  return word === "" ? undefined : word;
}

/** 段首的环境赋值（FOO=v）与重定向（>f、> f、2>f）不计入可执行名 */
const STAGE_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|\d*[<>]+\s*\S*)\s*/;

/** 管道段的可执行名：剥离段首赋值与重定向后取首词，去引号取 basename */
export function stageExecutable(stage: string): string | undefined {
  let rest = stage.trimStart();
  for (;;) {
    const m = STAGE_PREFIX.exec(rest);
    if (m === null || m[0] === "") break;
    rest = rest.slice(m[0].length).trimStart();
  }
  const word = firstWord(rest);
  return word?.split(/[\\/]/).at(-1);
}

/**
 * 每个独立命令的管道末段原文（分词规则同 shellTailExecutables）；
 * ADR-0022：PowerShell 的 Out-Host -Paging 需要段内参数，故导出的
 * 是原文而非可执行名。
 */
export function shellTailStages(command: string): string[] {
  const out: string[] = [];
  let stage = "";
  for (const tok of lexShellCommand(command)) {
    if (!tok.separator) {
      stage += tok.text;
      continue;
    }
    if (tok.text === "|") stage = "";
    else {
      if (stage.trim() !== "") out.push(stage);
      stage = "";
    }
  }
  if (stage.trim() !== "") out.push(stage);
  return out;
}

/**
 * 每个独立命令的管道末段可执行名（`&&`、`||`、`&`、`;`、换行、反引号、
 * `$(`、`(`/`)` 都是命令边界；`|` 只区分管道段、不结束命令）。
 * 例如 `a | more && b | less` → ["more", "less"]；`a | more | sort` 只
 * 报告末段的 "sort"（分页工具在中间段不误报）。返回顺序即命令出现顺序。
 */
export function shellTailExecutables(command: string): string[] {
  const out: string[] = [];
  for (const stage of shellTailStages(command)) {
    const exe = stageExecutable(stage);
    if (exe !== undefined) out.push(exe);
  }
  return out;
}

// ── 高风险命令匹配（ADR-0022 第 6 节） ──────────────────

/** 主体未携带元数据时的保守回退：POSIX 基础表（大小写敏感、无种类专属词表） */
const FALLBACK_RISK: ShellRiskProfile = {
  caseInsensitive: false,
  basePatterns: [
    "rm -rf *",
    "rm -fr *",
    "sudo *",
    "git push --force*",
    "git push -f *",
    "git reset --hard*",
  ],
};

/** 命令首词归一化：跳过 PowerShell 调用运算符 & / .，去引号、路径与常见扩展名 */
function riskCommandWord(segment: string): string | undefined {
  let rest = segment.trimStart();
  for (;;) {
    const c = rest.charAt(0);
    if ((c === "&" || c === ".") && /[\s'"]/.test(rest.charAt(1))) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    break;
  }
  const word = firstWord(rest)?.split(/[\\/]/).at(-1);
  return word?.replace(/\.(exe|com|bat|cmd)$/i, "").toLowerCase();
}

/** 段内存在某个 PowerShell 参数前缀缩写（-r … -Recurse、-f … -Force） */
function hasPsParamPrefix(segment: string, name: string): boolean {
  for (const tok of segment.split(/\s+/)) {
    const m = /^-{1,2}([a-z]+)/i.exec(tok);
    if (m !== null) {
      const given = m[1]?.toLowerCase() ?? "";
      if (given !== "" && name.startsWith(given)) return true;
    }
  }
  return false;
}

/**
 * 高风险判定：risk 为生效 shell 描述符透传的元数据（ShellDescriptor.risk）。
 * 元数据缺省时按 FALLBACK_RISK（POSIX 基础表）保守处理。
 */
export function isRiskyShellCommand(segment: string, risk?: ShellRiskProfile): boolean {
  const profile = risk ?? FALLBACK_RISK;
  const text = profile.caseInsensitive ? segment.toLowerCase() : segment;
  for (const pattern of profile.basePatterns) {
    if (matchShellPattern(pattern, text)) return true;
  }
  const word = riskCommandWord(text);
  if (word === undefined) return false;
  if (profile.alwaysVerbs?.includes(word)) return true;
  const sw = profile.switchVerbs;
  if (sw?.verbs.includes(word)) {
    const swRe = new RegExp(sw.switchPattern, "i");
    if (segment.split(/\s+/).some((tok) => swRe.test(tok))) return true;
  }
  const dp = profile.dualParamVerbs;
  if (
    dp !== undefined &&
    dp.verbs.includes(word) &&
    hasPsParamPrefix(segment, dp.params[0]) &&
    hasPsParamPrefix(segment, dp.params[1])
  ) {
    return true;
  }
  return false;
}

// ── 嵌套 shell 调用（pwsh -c "…"、cmd /c "…"、bash -c "…"） ──────────

const NESTED_SHELL =
  /(?:^|[\s"'`;&|(])(?:[^\s"'`;&|()]*[\\/])?(pwsh|powershell|cmd|sh|bash|zsh|dash|ksh)(?:\.exe)?(?=\s)/gi;

function nestedDialect(name: string): ShellDialect {
  const n = name.toLowerCase();
  if (n === "pwsh" || n === "powershell") return "powershell";
  if (n === "cmd") return "cmd";
  return "posix";
}

/** 该 token 是否为内层 shell 的「执行命令文本」参数 */
function isCommandFlag(token: string, dialect: ShellDialect): boolean {
  if (dialect === "cmd") return /^\/[ck]$/i.test(token);
  if (dialect === "powershell") {
    const m = /^-{1,2}([a-z]+)$/i.exec(token);
    return m !== null && "command".startsWith((m[1] ?? "").toLowerCase());
  }
  // POSIX：-c 或合并短选项（-lc、-ec）
  return /^-[a-z]*c[a-z]*$/i.test(token);
}

/** 去掉命令体外面的一层引号（只有开头引号时只去开头） */
function unquotePayload(text: string): string {
  const t = text.trim();
  const q = t.charAt(0);
  if (q !== '"' && q !== "'") return t;
  return t.length > 1 && t.endsWith(q) ? t.slice(1, -1) : t.slice(1);
}

/** 文本中各处嵌套 shell 调用的命令体及其方言 */
export function nestedShellPayloads(command: string): { dialect: ShellDialect; payload: string }[] {
  const out: { dialect: ShellDialect; payload: string }[] = [];
  for (const m of command.matchAll(NESTED_SHELL)) {
    const dialect = nestedDialect(m[1] ?? "");
    let rest = command.slice(m.index + m[0].length);
    // 命令参数前允许若干其他参数（-NoProfile、/d /s、-ExecutionPolicy Bypass 等）
    for (let i = 0; i < 8; i++) {
      const tok = /^\s*(\S+)/.exec(rest);
      if (tok === null) break;
      rest = rest.slice(tok[0].length);
      if (isCommandFlag(tok[1] ?? "", dialect)) {
        const payload = unquotePayload(rest);
        if (payload !== "") out.push({ dialect, payload });
        break;
      }
    }
  }
  return out;
}

/**
 * 找出命令中命中高风险表的段（含嵌套 shell 调用的命令体，最多三层）。
 * byDialect 缺省时，嵌套命令体按 POSIX 基础表保守检查。
 */
export function findRiskySegment(
  command: string,
  dialect: ShellDialect,
  risk: ShellRiskProfile | undefined,
  byDialect: Readonly<Record<string, ShellRiskProfile>> | undefined,
  depth = 0,
): string | undefined {
  const direct = shellSegments(command, dialect).find((segment) =>
    isRiskyShellCommand(segment, risk),
  );
  if (direct !== undefined || depth >= 3) return direct;
  for (const nested of nestedShellPayloads(command)) {
    const hit = findRiskySegment(
      nested.payload,
      nested.dialect,
      byDialect?.[nested.dialect],
      byDialect,
      depth + 1,
    );
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * 不透明的 PowerShell -EncodedCommand（含嵌套 pwsh/powershell 调用）：
 * 文本里出现 pwsh/powershell 可执行名与 -EncodedCommand（或它的
 * 前缀缩写 / -ec 别名）即判定——编码负载无法做内容审查，至少 ask。
 */
const POWERSHELL_EXE_TOKEN = /(?:^|[\s"'`/\\|&;(])(?:pwsh|powershell)(?:\.exe)?(?=[\s"'|&;():]|$)/i;

export function isOpaquePowerShellCommand(command: string): boolean {
  if (!POWERSHELL_EXE_TOKEN.test(command)) return false;
  for (const raw of command.split(/\s+/)) {
    const tok = raw.replace(/^["']+/, "").replace(/["';]+$/, "");
    const m = /^-{1,2}([a-zA-Z]+)/.exec(tok);
    if (m === null) continue;
    const flag = (m[1] ?? "").toLowerCase();
    if (flag === "ec" || "encodedcommand".startsWith(flag) || "encodedarguments".startsWith(flag)) {
      return true;
    }
  }
  return false;
}

// ── 确认命令转项目模式规则（ADR-0106） ─────────────────────

export type ShellRuleValidationResult =
  | { ok: true; pattern: string }
  | {
      ok: false;
      reason: "mismatch" | "first_word" | "composite";
      message: string;
    };

/**
 * 校验用户输入的 shell 模式规则是否合法且覆盖当前命令。
 * 权限闸门 respond 与桌面端表单共用同一校验逻辑。
 */
export function validateShellRulePattern(
  pattern: string,
  command: string,
  dialect: ShellDialect = "posix",
): ShellRuleValidationResult {
  const trimmed = pattern.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return { ok: false, reason: "mismatch", message: "不匹配当前命令" };
  }
  if (isCompositeShell(pattern, dialect) || isCompositeShell(trimmed, dialect)) {
    return { ok: false, reason: "composite", message: "不能包含 &&、|、; 等连接符" };
  }
  const cmdFirst = command.trim().split(/\s+/)[0] ?? "";
  const patFirst = trimmed.split(/\s+/)[0] ?? "";
  if (cmdFirst === "" || /[*?]/.test(cmdFirst)) {
    return { ok: false, reason: "mismatch", message: "不匹配当前命令" };
  }
  if (/[*?]/.test(patFirst) || patFirst !== cmdFirst) {
    return { ok: false, reason: "first_word", message: `开头要是 ${cmdFirst}` };
  }
  if (!matchShellPattern(trimmed, command)) {
    return { ok: false, reason: "mismatch", message: "不匹配当前命令" };
  }
  return { ok: true, pattern: trimmed };
}

const NON_PLAIN_WORD_CHAR = /[/\\.'"`=*?]/;

function isPlainShellWord(word: string, dialect: ShellDialect): boolean {
  if (word === "" || word.startsWith("-")) return false;
  if (NON_PLAIN_WORD_CHAR.test(word)) return false;
  if (isCompositeShell(word, dialect)) return false;
  return true;
}

/**
 * 为单条 shell 命令生成默认建议模式：从开头取 2–3 个连续普通词，
 * 后接空格与非空白内容时生成 `<前缀> *`，否则返回完整命令。
 */
export function suggestShellRulePattern(command: string, dialect: ShellDialect = "posix"): string {
  if (command === "" || /^\s/.test(command) || isCompositeShell(command, dialect)) {
    return command;
  }
  let plainCount = 0;
  let pos = 0;
  let prefixEnd = 0;
  while (pos < command.length && plainCount < 3) {
    let end = pos;
    while (end < command.length && !/\s/.test(command.charAt(end))) {
      end++;
    }
    const word = command.slice(pos, end);
    if (!isPlainShellWord(word, dialect)) break;
    plainCount++;
    prefixEnd = end;
    pos = end;
    while (pos < command.length && /\s/.test(command.charAt(pos))) {
      pos++;
    }
  }
  if (plainCount < 2) return command;
  const tail = command.slice(prefixEnd);
  if (!tail.startsWith(" ") || tail.trim() === "") return command;
  const candidate = `${command.slice(0, prefixEnd)} *`;
  return validateShellRulePattern(candidate, command, dialect).ok ? candidate : command;
}

/**
 * 判断 shell 主体是否满足项目级模式 Grant 的排除条件（非组合、非不透明 PowerShell、无高风险段）。
 * 权限层求值与桌面端「会匹配的命令」共用同一口径。
 */
export function isShellSubjectEligibleForPatternGrant(
  subject: Pick<
    PermissionSubject,
    "kind" | "target" | "shell" | "shellRisk" | "shellRiskByDialect"
  >,
  fallbackShell?: {
    shell?: string | undefined;
    shellRisk?: ShellRiskProfile | undefined;
    shellRiskByDialect?: Readonly<Record<string, ShellRiskProfile>> | undefined;
  },
): boolean {
  if (subject.kind !== "shell") return false;
  const dialect = shellDialect(subject.shell ?? fallbackShell?.shell);
  if (isCompositeShell(subject.target, dialect)) return false;
  if (isOpaquePowerShellCommand(subject.target)) return false;
  if (
    findRiskySegment(
      subject.target,
      dialect,
      subject.shellRisk ?? fallbackShell?.shellRisk,
      subject.shellRiskByDialect ?? fallbackShell?.shellRiskByDialect,
    ) !== undefined
  ) {
    return false;
  }
  return true;
}

/** 判断指定 shell 模式 Grant 是否会命中给定主体（含全部排除条件） */
export function matchesShellPatternGrant(
  pattern: string,
  subject: Pick<
    PermissionSubject,
    "kind" | "target" | "shell" | "shellRisk" | "shellRiskByDialect"
  >,
  fallbackShell?: {
    shell?: string | undefined;
    shellRisk?: ShellRiskProfile | undefined;
    shellRiskByDialect?: Readonly<Record<string, ShellRiskProfile>> | undefined;
  },
): boolean {
  if (!isShellSubjectEligibleForPatternGrant(subject, fallbackShell)) return false;
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  return matchShellPattern(trimmed, subject.target);
}
