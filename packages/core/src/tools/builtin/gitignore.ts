/**
 * 极简 .gitignore 匹配（内置工具内部使用）。
 * 支持：注释、! 取反、目录限定（尾 /）、锚定（含 /）、*、?、**。
 * 规则按文件内顺序求值，后写者优先；深层 .gitignore 覆盖浅层。
 * 已知简化：不处理"被忽略目录内个别文件的取反重包含"等边角情形。
 */

interface IgnoreRule {
  /** 匹配条目本身或其内容（"pat" 或 "pat/..."） */
  re: RegExp;
  /** 仅匹配内容（"pat/..."），dirOnly 规则用于非目录条目 */
  reContent: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function segmentToRegex(pat: string): string {
  let re = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat.charAt(i);
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = pat.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
        i += 1;
      } else {
        let cls = pat.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end + 1;
      }
    } else {
      re += c.replaceAll(/[.+^$(){}|\\]/g, "\\$&");
      i += 1;
    }
  }
  return re;
}

/** 解析一份 .gitignore 内容；匹配用的 relPath 相对于该文件所在目录，"/" 分隔 */
export function compileGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw;
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === "") continue;
    const anchored = line.includes("/");
    const seg = segmentToRegex(line.replace(/^\//, ""));
    const body = anchored ? `^${seg}` : `(?:^|/)${seg}`;
    rules.push({
      re: new RegExp(`${body}(?:/|$)`),
      reContent: new RegExp(`${body}/`),
      negate,
      dirOnly,
    });
  }
  return rules;
}

/** 一层 .gitignore 的判定：返回 true/false/undefined（无规则命中） */
export function matchGitignore(
  rules: IgnoreRule[],
  relPath: string,
  isDir: boolean,
): boolean | undefined {
  let result: boolean | undefined;
  for (const rule of rules) {
    const hit = rule.dirOnly
      ? isDir
        ? rule.re.test(relPath)
        : rule.reContent.test(relPath)
      : rule.re.test(relPath);
    if (hit) result = !rule.negate;
  }
  return result;
}

/** 忽略判定链：从深层 .gitignore 到浅层，第一个命中的规则层决定 */
export class GitignoreChain {
  private readonly layers: { rules: IgnoreRule[]; baseRel: string }[] = [];

  /** 进入一个目录时压入该目录的 .gitignore（baseRel = 该目录相对 root 的路径，root 为 ""） */
  push(baseRel: string, content: string | undefined): void {
    this.layers.push({ rules: compileGitignore(content ?? ""), baseRel });
  }

  pop(): void {
    this.layers.pop();
  }

  /** relPath 相对 root（"/" 分隔）；isDir 为该条目是否目录 */
  ignores(relPath: string, isDir: boolean): boolean {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (layer === undefined) continue;
      const prefix = layer.baseRel === "" ? "" : `${layer.baseRel}/`;
      if (!relPath.startsWith(prefix)) continue;
      const rel = relPath.slice(prefix.length);
      const matched = matchGitignore(layer.rules, rel, isDir);
      if (matched !== undefined) return matched;
    }
    return false;
  }
}
