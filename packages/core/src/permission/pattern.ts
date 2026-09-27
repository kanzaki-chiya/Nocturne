/**
 * 模式匹配原语（permissions.md 5.1）。
 * - 路径类（read / edit）：glob——`*` 不跨目录分隔符，`**` 跨任意层级，`?` 单字符；
 *   模式与目标都先规范化（"/" 分隔、词法消除 . / ..、按平台折叠大小写）；
 *   相对模式拼接到 workspaceRoot 之下。
 * - shell / network / mcp：字符串通配符——`*` 任意字符序列，`?` 单字符；
 *   大小写敏感，不做词法变形。
 */
import type { PermissionSubject, ShellRiskProfile } from "../protocol/index.js";

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 词法规范化路径：统一 "/" 分隔、消除 "." / ".."、去多余分隔符与尾部 "/"。
 * 输入应是绝对路径（resolved 经 realpath，target 经词法绝对化）。
 */
export function normalizePathText(p: string, caseSensitive: boolean): string {
  const raw = p.replaceAll("\\", "/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const prefix = raw.startsWith("/") ? "/" : "";
  let joined = prefix + out.join("/");
  if (joined === "") joined = prefix === "/" ? "/" : ".";
  if (!caseSensitive) joined = joined.toLowerCase();
  return joined;
}

function isAbsoluteNormalized(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

/** 规范化规则模式；相对模式拼到 workspaceRoot 之下（permissions.md 5.1） */
export function normalizePattern(
  pattern: string,
  workspaceRoot: string,
  caseSensitive: boolean,
): string {
  const norm = normalizePathText(pattern, caseSensitive);
  if (isAbsoluteNormalized(norm)) return norm;
  const root = normalizePathText(workspaceRoot, caseSensitive);
  return `${root}/${norm}`;
}

/** 路径 glob → 正则：双星段允许零层目录，`**` 跨分隔符，`*`/`?` 不跨分隔符 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRegExp(c ?? "");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** 字符串通配符 → 正则（shell / network / mcp）：大小写敏感 */
function wildcardToRegExp(pattern: string): RegExp {
  let re = "";
  for (const c of pattern) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`);
}

const PATH_KINDS = new Set(["read", "edit"]);

/** 路径类主体（read / edit）：有 resolved / where；shell、network、mcp 没有 */
export function isPathKind(kind: string): boolean {
  return PATH_KINDS.has(kind);
}

/**
 * 规则 pattern 是否命中主体（只比较 pattern，不判 kind/where）。
 * 路径类：pattern 同时与规范化 target 和 resolved 比较，任一命中即中（4.2）。
 */
export function matchPattern(
  pattern: string,
  subject: PermissionSubject,
  workspaceRoot: string,
  caseSensitive: boolean,
): boolean {
  if (isPathKind(subject.kind)) {
    // `**` 作为"所有路径"的显式写法：预设用它配合 where 区分工作区内/外，
    // 相对模式词法上拼到 workspaceRoot 之下无法表达"工作区外"，必须特判
    if (pattern === "**") return true;
    const re = globToRegExp(normalizePattern(pattern, workspaceRoot, caseSensitive));
    const candidates = [subject.target, subject.resolved]
      .filter((v): v is string => v !== undefined && v !== "")
      .map((v) => normalizePathText(v, caseSensitive));
    return candidates.some((c) => re.test(c));
  }
  return wildcardToRegExp(pattern).test(subject.target);
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
// 这不是完整的 shell 解析器，词法层已知的简化：
// - 引号（"…" 与 '…'）内的控制符一律视为文本；引号内的 $(…) / 反引号
//   不再展开（`echo "$(x | more)"` 不切出内层管道）；
// - 反斜杠转义按 bash 习惯：引号外只对控制符生效（`\|` 不切断，
//   `C:\Windows` 的路径分隔符原样保留），双引号内只对 " \ $ ` 换行生效，
//   单引号内无转义；双引号内相邻的 "" 按 cmd 习惯仍留在引号内；
//   普通字符前的 `\` 原样保留（Windows 路径必需），因此 `mo\re` 这类
//   bash 式词内转义不会被识别为 `more`——可接受，这是可用性护栏不是
//   安全边界；
// - cmd 的 ^ 转义、here-doc、case/if 等复合语法不处理。
// 与 permissions.md 5.3 的定位一致：这是提示，不是安全边界。

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

/** 把命令行切成文本片段与分隔符记号（引号感知；规则见上方注释块） */
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
//
// 每 shell 种类的表集中在 platform 的 ShellDescriptor.risk，经 shell 主体
// 以 shellRisk 透传到此处；这里只执行匹配语义（通配符表达不了"两个标志共存、
// 允许参数前缀缩写、大小写不敏感"这类规则）。policy 把预设级 allow 降级为 ask；
// 用户显式规则照旧按命令原文匹配并可覆盖。

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
 * - basePatterns：各 shell 共用的通配符基础表；
 * - switchVerbs：命令词与开关共存才命中（cmd 的 rd /s 式规则）；
 * - dualParamVerbs：命令词与两个参数共存才命中（PowerShell 的 -Recurse -Force，
 *   允许参数前缀缩写）；
 * - alwaysVerbs：恒高危命令词（cmd format、PS Format-Volume/Invoke-Expression 等）。
 * 元数据缺省时按 FALLBACK_RISK（POSIX 基础表）保守处理。
 */
export function isRiskyShellCommand(segment: string, risk?: ShellRiskProfile): boolean {
  const profile = risk ?? FALLBACK_RISK;
  const text = profile.caseInsensitive ? segment.toLowerCase() : segment;
  for (const pattern of profile.basePatterns) {
    if (wildcardToRegExp(pattern).test(text)) return true;
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
