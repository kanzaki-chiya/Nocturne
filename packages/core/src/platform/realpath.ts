/**
 * 真实路径解析（permissions.md 4.2）。
 * 已存在路径解析全部符号链接 / junction；
 * 尚不存在的路径解析最近已存在祖先，再把剩余段词法拼接回去。
 */
import type { FileSystem } from "./fs.js";
import type { PathOps } from "./paths.js";

/**
 * 把 target（应先经 paths.resolve 绝对化）解析为真实路径。
 * 返回路径词法规范化、不含 ".."；任何 I/O 失败原样抛出。
 */
export async function resolveRealPath(
  fs: FileSystem,
  paths: PathOps,
  target: string,
): Promise<string> {
  const abs = paths.normalize(target);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    if (await fs.exists(current)) {
      const real = paths.normalize(await fs.realpath(current));
      if (missing.length === 0) return real;
      // missing 自下而上收集，拼接时反转；各段均为 normalize 后的普通路径段
      return paths.normalize(paths.join(real, ...missing.reverse()));
    }
    const parent = paths.dirname(current);
    if (parent === current) {
      // 理论上不会发生：根目录总是存在
      throw new Error(`无法解析路径（无已存在祖先）: ${target}`);
    }
    missing.push(paths.basename(current));
    current = parent;
  }
}
