import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function isExistingDirectory(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isRepoRoot(dirPath: string): boolean {
  return (
    existsSync(join(dirPath, "pnpm-workspace.yaml")) &&
    existsSync(join(dirPath, "apps", "cli", "package.json"))
  );
}

/**
 * 解析随发行包或仓库提供的内置插件目录（ADR-0100 第 3 节）：
 * 1. 入口文件所在目录下的 `plugins/`（单文件 bundle、npm 包、桌面端资源目录）；
 * 2. 模块所在目录下的 `plugins/`；
 * 3. 开发环境（从仓库 `apps/cli/dist` 或 `apps/cli/src` 运行）回落到仓库根 `plugins/`；
 * 4. 均不存在时返回 undefined（不传给 createRuntime）。
 */
export function resolveBuiltinPluginsDir(options?: {
  fromUrl?: string | undefined;
  entryPath?: string | undefined;
}): string | undefined {
  const baseDirs: string[] = [];
  const pushDir = (dir: string): void => {
    if (!baseDirs.includes(dir)) baseDirs.push(dir);
  };

  const entry = options && "entryPath" in options ? options.entryPath : process.argv[1];
  if (entry !== undefined && entry.length > 0) {
    pushDir(dirname(resolve(entry)));
  }

  const fromUrl = options && "fromUrl" in options ? options.fromUrl : import.meta.url;
  if (fromUrl !== undefined && fromUrl.length > 0) {
    try {
      pushDir(dirname(fileURLToPath(fromUrl)));
    } catch {
      // 非 file: URL 时跳过
    }
  }

  for (const dir of baseDirs) {
    const candidate = join(dir, "plugins");
    if (isExistingDirectory(candidate)) return candidate;
  }

  for (const dir of baseDirs) {
    const repoRoot = resolve(dir, "..", "..", "..");
    if (isRepoRoot(repoRoot)) {
      const candidate = join(repoRoot, "plugins");
      if (isExistingDirectory(candidate)) return candidate;
    }
  }

  return undefined;
}
