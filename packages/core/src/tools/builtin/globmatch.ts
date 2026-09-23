/**
 * 极简 glob → RegExp 转换（内置工具内部使用）。
 * 支持：*、?、**、{a,b}、[...]、转义。匹配以 "/" 分隔的相对路径。
 */

const REGEXP_SPECIALS = /[.+^$()|\\]/g;

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // **/ 可匹配零层目录；** 匹配任意字符（含 /）
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
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
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
      } else {
        const inner = glob.slice(i + 1, end);
        const alts = inner
          .split(",")
          .map((a) => a.replaceAll(REGEXP_SPECIALS, "\\$&").replaceAll("*", "[^/]*"));
        re += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
        i += 1;
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end + 1;
      }
    } else {
      re += c.replaceAll(REGEXP_SPECIALS, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
