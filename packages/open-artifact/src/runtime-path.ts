import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface ResolvedOpenArtifactRuntime {
  dir: string;
  version: string;
  entry: string;
}

const RUNTIME_ENTRY_REL = join("scripts", "open-artifact.mjs");
const BUNDLED_RUNTIME_SUBDIR = "open-artifact-runtime";

function readRuntimeDir(dir: string): ResolvedOpenArtifactRuntime | undefined {
  const absDir = resolve(dir);
  const entry = join(absDir, RUNTIME_ENTRY_REL);
  if (!existsSync(entry)) return undefined;
  const pkgPath = join(absDir, "package.json");
  let version = "0.0.0";
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
        version = parsed.version.trim();
      }
    } catch {
      // ignore malformed package.json
    }
  }
  return { dir: absDir, version, entry };
}

/**
 * 解析随包或本地安装的 @open-artifact/cli 运行时目录。
 * 优先级：
 * 1. 显式 runtimeDir；
 * 2. NOCTURNE_OPEN_ARTIFACT_RUNTIME_DIR；
 * 3. 入口文件（process.argv[1]）或模块目录旁边的 open-artifact-runtime/（桌面/单文件随包布局）；
 * 4. node_modules/@open-artifact/cli（开发态或独立安装）。
 */
export function resolveBundledOpenArtifactRuntime(
  explicitDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { entryPath?: string | undefined; fromUrl?: string | undefined },
): ResolvedOpenArtifactRuntime | undefined {
  const candidates: string[] = [];
  const push = (dir: string): void => {
    const trimmed = dir.trim();
    if (trimmed !== "" && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };
  if (explicitDir !== undefined) {
    push(explicitDir);
  }
  const envDir = env.NOCTURNE_OPEN_ARTIFACT_RUNTIME_DIR;
  if (typeof envDir === "string") {
    push(envDir);
  }
  const entryPath = options && "entryPath" in options ? options.entryPath : process.argv[1];
  if (typeof entryPath === "string" && entryPath.length > 0) {
    push(join(dirname(resolve(entryPath)), BUNDLED_RUNTIME_SUBDIR));
  }
  const fromUrl = options && "fromUrl" in options ? options.fromUrl : import.meta.url;
  if (typeof fromUrl === "string" && fromUrl.length > 0) {
    try {
      push(join(dirname(fileURLToPath(fromUrl)), BUNDLED_RUNTIME_SUBDIR));
    } catch {
      // ignore non-file URL
    }
  }
  for (const dir of candidates) {
    const found = readRuntimeDir(dir);
    if (found !== undefined) return found;
  }
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@open-artifact/cli/package.json");
    const found = readRuntimeDir(dirname(pkgJson));
    if (found !== undefined) return found;
  } catch {
    // 未随包安装时允许退回到系统/共享 OPEN_ARTIFACT_HOME 已有运行时
  }
  return undefined;
}
