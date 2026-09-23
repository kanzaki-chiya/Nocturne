/**
 * 路径规范化与比较（纯词法操作，无 I/O）。
 * 大小写敏感性由运行平台决定，以数据形式提供给权限层（permissions.md 4.2）。
 */
import path from "node:path";

export interface PathOps {
  /** 当前平台路径分隔符 */
  readonly sep: string;
  /** 当前文件系统是否大小写敏感（Windows/macOS 默认不敏感） */
  readonly caseSensitive: boolean;
  /** 词法绝对化 + 规范化：消除 "." 与 ".."，统一分隔符。无 I/O */
  resolve(cwd: string, p: string): string;
  normalize(p: string): string;
  isAbsolute(p: string): boolean;
  join(...segments: string[]): string;
  dirname(p: string): string;
  basename(p: string): string;
  relative(from: string, to: string): string;
  /** 比较用规范化形式：normalize + 去扩展前缀 + 大小写折叠（不敏感平台） */
  canonicalize(p: string): string;
  /** 路径等价（按平台大小写规则） */
  equals(a: string, b: string): boolean;
  /** p === root 或位于 root 之下（词法判断，输入应先经 realpath 解析） */
  isWithin(root: string, p: string): boolean;
}

/** Windows 扩展长度前缀：\\?\C:\x → C:\x，\\?\UNC\server\x → \\server\x */
function stripExtendedPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

export function createPathOps(caseSensitive: boolean): PathOps {
  function normalize(p: string): string {
    return path.normalize(stripExtendedPrefix(p));
  }

  function canonicalize(p: string): string {
    let n = normalize(p);
    // 去掉末尾分隔符（根目录除外）：path.normalize 会保留 "C:\ws\" 的尾巴
    const rootLen = path.parse(n).root.length;
    while (n.length > rootLen && n.endsWith(path.sep)) {
      n = n.slice(0, -1);
    }
    return caseSensitive ? n : n.toLowerCase();
  }

  return {
    sep: path.sep,
    caseSensitive,
    resolve: (cwd, p) => path.resolve(cwd, p),
    normalize,
    isAbsolute: (p) => path.isAbsolute(p),
    join: (...segments) => path.join(...segments),
    dirname: (p) => path.dirname(p),
    basename: (p) => path.basename(p),
    relative: (from, to) => path.relative(from, to),
    canonicalize,
    equals: (a, b) => canonicalize(a) === canonicalize(b),
    isWithin(root, p) {
      const r = canonicalize(root);
      const c = canonicalize(p);
      if (c === r) return true;
      const prefix = r.endsWith(path.sep) ? r : r + path.sep;
      return c.startsWith(prefix);
    },
  };
}
