/**
 * 会话 Markdown 本地文件链接解析与候选路径收集（ADR-0129）：
 * 将带标题的 Markdown 链接目标做单次安全解码与合法性校验后，复用到
 * `splitCodeRef` 与 `session.resolveFiles` 的去重批查路径中。
 *
 * 外链白名单走既有 `isAllowedExternalUrl`；UNC、编码后变成网络/设备路径的目标、
 * 协议相对网址、设备路径、`file:` 及其他未放行协议、纯锚点均在此阶段拦截，
 * 绝不送进 `resolveFiles` 或本地打开器。
 */
import { splitCodeRef } from "@nocturne/core/protocol";
import type { Token, Tokens } from "marked";

import { isAllowedExternalUrl } from "./external-url";
import { isNetworkPath } from "./side-panel";

export interface ParsedFileLinkTarget {
  path: string;
  line?: number;
  endLine?: number;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SCHEME_WITH_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const DISALLOWED_SCHEMES =
  /^(?:file|http|https|javascript|vbscript|data|blob|about|mailto|tel|sms|urn|ftp|ftps|sftp|ssh|smb|ws|wss|cid|mid|geo|news|nntp|irc|ircs|chrome|edge|tauri|nocturne|vscode|vscode-insiders|cursor|obsidian|notion|slack|discord|tg|weixin|ms-settings|ms-windows-store):/i;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const NT_OBJECT_UNESCAPED = /^\?\?[\\/]/;

function decodeHrefOnce(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 保留含字面 `%`（如 `<Z:/dir/100% real.md>`）或非法转义的原路径，不做破坏性截断
    return raw;
  }
}

function isDisallowedCandidate(candidate: string): boolean {
  if (candidate === "" || CONTROL_CHARS.test(candidate)) return true;
  if (candidate.startsWith("#")) return true;
  if (
    candidate.startsWith("\\") ||
    candidate.startsWith("//") ||
    candidate.startsWith("/\\") ||
    NT_OBJECT_UNESCAPED.test(candidate) ||
    isNetworkPath(candidate)
  ) {
    return true;
  }
  if (SCHEME_WITH_AUTHORITY.test(candidate) || DISALLOWED_SCHEMES.test(candidate)) {
    return true;
  }
  return false;
}

/**
 * 将 Markdown link 的 `href` 规范化为本地文件引用目标（路径 + 可选 `:行[-行]`）。
 * 非本地路径、外链、危险路径或非法目标返回 `undefined`。
 */
export function parseMarkdownFileLinkTarget(href: string): ParsedFileLinkTarget | undefined {
  const raw = href.trim();
  if (isDisallowedCandidate(raw) || isAllowedExternalUrl(raw)) return undefined;

  const decoded = decodeHrefOnce(raw).trim();
  if (isDisallowedCandidate(decoded) || isAllowedExternalUrl(decoded)) return undefined;

  const split = splitCodeRef(decoded);
  if (split === undefined) return undefined;

  const targetPath = split.path;
  if (isDisallowedCandidate(targetPath)) return undefined;

  // 除 Windows 盘符（如 `Z:/`、`C:\`）外，路径部分不得残留冒号（拦未知协议与 NTFS ADS）
  const afterDrive = WINDOWS_DRIVE_PREFIX.test(targetPath) ? targetPath.slice(2) : targetPath;
  if (afterDrive.includes(":")) return undefined;

  return split;
}

/**
 * 收集单条 Markdown 消息中的所有本地文件候选路径（同时覆盖行内代码与带标题链接），
 * 同一目标路径去重后只交给 `session.resolveFiles` 查询一次。
 * 链接标题内部不再递归收集 codespan，避免生成嵌套交互项或多余查询。
 */
export function collectMarkdownFileRefPaths(tokens: readonly Token[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };
  const collect = (list: readonly Token[]) => {
    for (const token of list) {
      if (token.type === "codespan") {
        const split = splitCodeRef((token as Tokens.Codespan).text);
        if (split !== undefined && !isNetworkPath(split.path)) {
          add(split.path);
        }
        continue;
      }
      if (token.type === "link") {
        const target = parseMarkdownFileLinkTarget((token as Tokens.Link).href);
        if (target !== undefined) add(target.path);
        continue;
      }
      const inner = (token as { tokens?: readonly Token[] }).tokens;
      if (inner !== undefined) collect(inner);
      if (token.type === "table") {
        const table = token as Tokens.Table;
        for (const cell of table.header) collect(cell.tokens);
        for (const row of table.rows) {
          for (const cell of row) collect(cell.tokens);
        }
      }
      if (token.type === "list") {
        for (const item of (token as Tokens.List).items) collect(item.tokens);
      }
    }
  };
  collect(tokens);
  return paths;
}

/** 提取链接标题的纯文本，用作右键菜单的无障碍标签。 */
export function markdownLinkPlainText(
  tokens: readonly Token[] | undefined,
  fallback: string,
): string {
  if (tokens === undefined || tokens.length === 0) return fallback;
  const parts: string[] = [];
  const walk = (nodes: readonly Token[]) => {
    for (const node of nodes) {
      const inner = (node as { tokens?: readonly Token[] }).tokens;
      if (inner !== undefined && inner.length > 0) {
        walk(inner);
      } else if ("text" in node && typeof node.text === "string") {
        parts.push(node.text);
      } else {
        parts.push(node.raw);
      }
    }
  };
  walk(tokens);
  const joined = parts.join("").trim();
  return joined !== "" ? joined : fallback;
}
