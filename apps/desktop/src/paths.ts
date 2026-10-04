import { projectKey } from "./session-tree";

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function slashes(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * 展示用路径：cwd 之内的显示相对路径（"/" 分隔），之外按原样显示绝对路径；
 * 相对输入只做归一（去 "./"、"\" → "/"）。cwd 内判定沿用 projectKey 的
 * 归并规则（Windows 风格路径忽略大小写与分隔符差异）；projectKey 只做等长
 * 变换（小写化与分隔符统一），所以归并键长度可直接用来切原始串。
 */
export function displayPath(path: string, cwd: string | undefined): string {
  const p = path.trim();
  if (cwd !== undefined && cwd !== "" && isAbsolute(p)) {
    const key = projectKey(cwd);
    const pathKey = projectKey(p);
    if (pathKey === key) return ".";
    if (pathKey.startsWith(`${key}\\`) || pathKey.startsWith(`${key}/`)) {
      return slashes(p.slice(key.length + 1)).replace(/^(\.\/)+/, "");
    }
    return p;
  }
  return slashes(p).replace(/^(\.\/)+/, "");
}

/** 主目录缩写："~/rest"；不在主目录内或 home 未知时原样返回。 */
export function abbreviateHome(path: string, home: string | null | undefined): string {
  if (home === null || home === undefined || home === "") return path;
  const pathKey = projectKey(path);
  const homeKey = projectKey(home);
  if (pathKey === homeKey) return "~";
  if (pathKey.startsWith(`${homeKey}\\`) || pathKey.startsWith(`${homeKey}/`)) {
    return `~${path.slice(homeKey.length)}`;
  }
  return path;
}

/** 中段省略：保留头尾，中间一个 "…"；不超过 max 时原样返回。 */
export function middleTruncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const room = max - 1;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
