/**
 * 模式匹配原语（permissions.md 5.1）。
 * - 路径类（read / edit）：glob——`*` 不跨目录分隔符，`**` 跨任意层级，`?` 单字符；
 *   模式与目标都先规范化（"/" 分隔、词法消除 . / ..、按平台折叠大小写）；
 *   相对模式拼接到 workspaceRoot 之下。
 * - shell / network / mcp：字符串通配符——`*` 任意字符序列，`?` 单字符；
 *   大小写敏感，不做词法变形。
 */
import type { PermissionSubject } from "../protocol/index.js";

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

const COMPOSITE_SHELL = /&&|\|\||[;&|`<>]|\$\(|\r|\n/;

/**
 * shell 组合命令判定（permissions.md 5.3）：含 `&&`、`||`、`;`、`|`、
 * 反引号、`$(`、重定向、换行等控制符时，基于模式的 allow 不适用（按 ask 对待）。
 */
export function isCompositeShell(command: string): boolean {
  return COMPOSITE_SHELL.test(command);
}
