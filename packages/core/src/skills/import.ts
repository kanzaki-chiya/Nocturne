/**
 * 技能导入（ADR-0048 修订 U-08）：只从本地文件夹导入，只复制文件。
 *
 * 预检（previewSkillImport）返回候选与冲突，不写任何东西；执行
 * （commitSkillImport）按逐项决定写入目标目录。目标只有两种：
 * 用户级 `<nocturneHome>/skills/` 或工作区 `.nocturne/skills/`。
 * 写入经 platform 文件系统，客户端不直接写技能目录。
 */
import type { Platform } from "../platform/index.js";
import type { SkillsConfig } from "../protocol/index.js";
import { discoverSkills, parseSkill } from "./discovery.js";
export type {
  SkillImportCandidateView,
  SkillImportDecisionView,
  SkillImportInput,
  SkillImportOutput,
  SkillImportResultView,
} from "../protocol/index.js";

/** 单个技能总大小上限（字节）：超过的候选不可勾选（skills.md 第 7 节）。 */
export const SKILL_IMPORT_SIZE_LIMIT_BYTES = 1 * 1024 * 1024;
export class SkillImportError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillImportError";
  }
}

/** frontmatter name 行改写：有则替换，无则在开栏后插入。 */
export function rewriteSkillName(text: string, name: string): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return `---\nname: ${name}\n---\n${normalized}`;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return normalized;
  const head = normalized.slice(4, end);
  const rest = normalized.slice(end);
  if (/^name:[ \t]*.*$/m.test(head)) {
    return `---\n${head.replace(/^name:[ \t]*.*$/m, `name: ${name}`)}${rest}`;
  }
  return `---\nname: ${name}\n${head.replace(/^\n/, "")}${rest}`;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillImportCandidate {
  /** 目录名（改名前）；改名后以 finalName 为准 */
  name: string;
  /** 来源目录绝对路径 */
  sourcePath: string;
  /** SKILL.md 声明名与目录名不一致时给出 */
  declaredName?: string | undefined;
  valid: boolean;
  /** 不合格原因；缺说明只警告，不进这里 */
  reason?: string | undefined;
  /** 跳过的符号链接相对路径 */
  skippedLinks: string[];
  /** 来源总字节（含 SKILL.md，不含跳过的链接目标） */
  sizeBytes: number;
  /** 缺少 description：可用但模型看不到 */
  missingDescription: boolean;
  /** 目标目录已有同名（大小写不敏感） */
  targetConflict: boolean;
  /** 其他目录已有同名：给出"将被覆盖 / 将覆盖"的提示 */
  shadowNote?: string | undefined;
  /** 预填的改名建议（冲突时默认 `name-2` 起） */
  suggestedName?: string | undefined;
}

export interface SkillImportPreview {
  targetDir: string;
  targetLayer: "user" | "project";
  candidates: SkillImportCandidate[];
}

async function readSkillFields(
  platform: Platform,
  dir: string,
): Promise<{ fields: Record<string, unknown>; body: string; text: string }> {
  const { fs } = platform;
  const text = await fs.readTextFile(platform.paths.join(dir, "SKILL.md"));
  try {
    const { fields, body } = parseSkill(text, platform.paths.basename(dir));
    return { fields, body, text };
  } catch (e) {
    throw new SkillImportError("source", e instanceof Error ? e.message : String(e));
  }
}

/** 递归累加字节；符号链接只记录相对路径、不跟随、不计入。 */
async function measureDir(
  platform: Platform,
  dir: string,
  base: string,
): Promise<{ size: number; links: string[] }> {
  const { fs, paths } = platform;
  let size = 0;
  const links: string[] = [];
  const stack = [dir];
  let current: string | undefined;
  while ((current = stack.pop()) !== undefined) {
    const entries = await fs.readdir(current);
    for (const entry of entries) {
      const full = entry.path;
      const stat = await fs.lstat(full);
      if (stat.type === "symlink") {
        links.push(paths.relative(base, full));
        continue;
      }
      if (stat.type === "directory") {
        stack.push(full);
        continue;
      }
      if (stat.type === "file") size += stat.size;
    }
  }
  return { size, links };
}

async function buildCandidate(
  platform: Platform,
  sourcePath: string,
  targetNames: Set<string>,
  shadowOf: (name: string) => string | undefined,
  takeSuggested: (name: string) => string,
): Promise<SkillImportCandidate> {
  const { paths } = platform;
  const dirName = paths.basename(sourcePath);
  const { size, links } = await measureDir(platform, sourcePath, sourcePath);
  const base: Omit<
    SkillImportCandidate,
    "valid" | "targetConflict" | "shadowNote" | "suggestedName"
  > & {
    valid?: boolean;
    reason?: string | undefined;
  } = {
    name: dirName,
    sourcePath,
    skippedLinks: links,
    sizeBytes: size,
    missingDescription: false,
  };
  if (size > SKILL_IMPORT_SIZE_LIMIT_BYTES) {
    return {
      ...base,
      valid: false,
      reason: `技能总大小超过上限（${size} 字节 > ${SKILL_IMPORT_SIZE_LIMIT_BYTES} 字节）`,
      targetConflict: false,
    };
  }
  let fields: Record<string, unknown>;
  try {
    ({ fields } = await readSkillFields(platform, sourcePath));
  } catch (e) {
    return {
      ...base,
      valid: false,
      reason: e instanceof Error ? e.message : String(e),
      targetConflict: false,
    };
  }
  const declared = typeof fields.name === "string" ? fields.name : dirName;
  const name = declared;
  if (!NAME_RE.test(name) || name.length > 64) {
    return {
      ...base,
      name,
      ...(declared !== dirName ? { declaredName: declared } : {}),
      valid: false,
      reason: `名字 ${name} 不符合 Agent Skills 规范（小写字母/数字/连字符，最多 64 字符）`,
      targetConflict: false,
    };
  }
  const missingDescription =
    typeof fields.description !== "string" || fields.description.trim() === "";
  const lower = name.toLowerCase();
  const targetConflict = targetNames.has(lower);
  return {
    ...base,
    name,
    ...(declared !== dirName ? { declaredName: declared } : {}),
    valid: true,
    missingDescription,
    targetConflict,
    ...(targetConflict ? { suggestedName: takeSuggested(lower) } : {}),
    ...(targetConflict ? {} : { shadowNote: shadowOf(lower) }),
  };
}

/**
 * 预检：扫描来源、校验格式、计算冲突。不写任何东西。
 * target 为 "user" 时目标目录是 `<nocturneHome>/skills`，为 "project"
 * 时是 `<workspaceRoot>/.nocturne/skills`（调用方保证 workspaceRoot 存在）。
 */
export async function previewSkillImport(
  platform: Platform,
  input: {
    sourceDir: string;
    target: "user" | "project";
    nocturneHome: string;
    workspaceRoot: string;
    cwd: string;
    config?: SkillsConfig | undefined;
  },
): Promise<SkillImportPreview> {
  const { fs, paths } = platform;
  const targetDir =
    input.target === "user"
      ? paths.join(input.nocturneHome, "skills")
      : paths.join(input.workspaceRoot, ".nocturne/skills");
  const sourceStat = await fs.lstat(input.sourceDir).catch(() => undefined);
  if (sourceStat === undefined) throw new SkillImportError("source", "来源文件夹不存在");
  if (sourceStat.type !== "directory" || (await fs.lstat(input.sourceDir)).type === "symlink")
    throw new SkillImportError("source", "来源必须是本地文件夹");
  // 来源本身含 SKILL.md 时作为单个技能；否则扫描下一层子目录
  const hasSkill = await fs.exists(paths.join(input.sourceDir, "SKILL.md"));
  const dirs: string[] = [];
  if (hasSkill) {
    dirs.push(input.sourceDir);
  } else {
    const entries = await fs.readdir(input.sourceDir);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "directory") continue;
      if (await fs.exists(paths.join(entry.path, "SKILL.md"))) dirs.push(entry.path);
    }
  }
  if (dirs.length === 0)
    throw new SkillImportError("source", "文件夹里没有找到技能（需要 SKILL.md）");

  const targetNames = new Set<string>();
  if (await fs.exists(targetDir)) {
    for (const entry of await fs.readdir(targetDir)) {
      targetNames.add(entry.name.toLowerCase());
    }
  }
  const discovery = await discoverSkills(platform, {
    nocturneHome: input.nocturneHome,
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    config: input.config,
  });
  const byName = new Map<string, { layer: "user" | "project"; entryPath: string }>();
  for (const skill of discovery.skills) {
    const key = skill.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { layer: skill.layer, entryPath: skill.entryPath });
  }
  const shadowOf = (lower: string): string | undefined => {
    const existing = byName.get(lower);
    if (existing === undefined) return undefined;
    if (input.target === "user" && existing.layer === "project")
      return "导入后用户层生效，将覆盖项目层的同名技能";
    if (input.target === "project" && existing.layer === "user")
      return "用户层已有同名技能，导入后仍被用户层覆盖";
    return undefined;
  };
  const used = new Set(targetNames);
  const takeSuggested = (lower: string): string => {
    let i = 2;
    while (used.has(`${lower}-${i}`)) i++;
    const name = `${lower}-${i}`;
    used.add(name);
    return name;
  };
  const candidates: SkillImportCandidate[] = [];
  for (const dir of dirs) {
    candidates.push(await buildCandidate(platform, dir, targetNames, shadowOf, takeSuggested));
  }
  return { targetDir, targetLayer: input.target, candidates };
}

export interface SkillImportDecision {
  /** 来源目录（与 preview 返回的 sourcePath 对应） */
  sourcePath: string;
  /** rename 时的新名；overwrite/skip 时缺省 */
  name?: string | undefined;
  action: "rename" | "overwrite" | "skip";
}

export interface SkillImportResult {
  sourcePath: string;
  name: string;
  status: "imported" | "skipped";
  /** skip 原因或失败 presently 抛错（commit 整体失败时） */
  reason?: string | undefined;
  /** 目标目录 */
  targetPath: string;
  /** 改名后的实际名（rename 时与来源不同） */
  finalName?: string | undefined;
  missingDescription: boolean;
}

/** 递归复制文件；符号链接跳过（只复制文件，不执行任何脚本）。 */
async function copyTree(platform: Platform, from: string, to: string): Promise<void> {
  const { fs } = platform;
  await fs.mkdir(to);
  const stack: { from: string; to: string }[] = [{ from, to }];
  while (stack.length > 0) {
    const { from: src, to: dst } = stack.pop() as { from: string; to: string };
    for (const entry of await fs.readdir(src)) {
      const srcFull = entry.path;
      const dstFull = platform.paths.join(dst, entry.name);
      const stat = await fs.lstat(srcFull);
      if (stat.type === "symlink") continue;
      if (stat.type === "directory") {
        await fs.mkdir(dstFull);
        stack.push({ from: srcFull, to: dstFull });
        continue;
      }
      if (stat.type === "file") {
        await fs.writeFile(dstFull, await fs.readFile(srcFull));
      }
    }
  }
}

/**
 * 执行导入：按逐项决定写入目标目录。overwrite 先复制到临时目录，
 * 成功后原子替换（旧目录改名备份，失败回滚），原技能保持不变。
 * 单项失败抛 SkillImportError，已完成的项不回滚（结果页逐项展示由
 * 调用方在失败前收集——失败时整体抛错，成功项已落盘）。
 */
export async function commitSkillImport(
  platform: Platform,
  input: {
    targetDir: string;
    decisions: SkillImportDecision[];
  },
): Promise<SkillImportResult[]> {
  const { fs, paths } = platform;
  await fs.mkdir(input.targetDir);
  const results: SkillImportResult[] = [];
  for (const decision of input.decisions) {
    if (decision.action === "skip") {
      results.push({
        sourcePath: decision.sourcePath,
        name: paths.basename(decision.sourcePath),
        status: "skipped",
        reason: "已跳过",
        targetPath: "",
        missingDescription: false,
      });
      continue;
    }
    const { fields } = await readSkillFields(platform, decision.sourcePath).catch((e: unknown) => {
      throw new SkillImportError("source", e instanceof Error ? e.message : String(e));
    });
    const sourceName =
      typeof fields.name === "string" ? fields.name : paths.basename(decision.sourcePath);
    const finalName = decision.action === "rename" ? (decision.name ?? "") : sourceName;
    if (decision.action === "rename" && (!NAME_RE.test(finalName) || finalName.length > 64)) {
      throw new SkillImportError("name", `改名 ${finalName} 不符合技能名字规范`);
    }
    const targetPath = paths.join(input.targetDir, finalName);
    const { size } = await measureDir(platform, decision.sourcePath, decision.sourcePath);
    if (size > SKILL_IMPORT_SIZE_LIMIT_BYTES) {
      throw new SkillImportError("source", `技能总大小超过上限（${size} 字节）`);
    }
    // 目标已存在且非 overwrite：必须经 rename 解决，commit 不静默覆盖
    if (decision.action !== "overwrite" && (await fs.exists(targetPath))) {
      throw new SkillImportError("name", `目标已存在同名技能 ${finalName}，请选择改名、覆盖或跳过`);
    }
    const staging = paths.join(input.targetDir, `.${finalName}.tmp-${process.pid}`);
    await fs.rm(staging, { recursive: true, force: true });
    await copyTree(platform, decision.sourcePath, staging);
    if (decision.action === "rename") {
      const skillFile = paths.join(staging, "SKILL.md");
      await fs.writeFile(skillFile, rewriteSkillName(await fs.readTextFile(skillFile), finalName));
    }
    const missingDescription =
      typeof fields.description !== "string" || fields.description.trim() === "";
    if (decision.action === "overwrite" && (await fs.exists(targetPath))) {
      const backup = paths.join(input.targetDir, `.${finalName}.bak-${process.pid}`);
      await fs.rm(backup, { recursive: true, force: true });
      try {
        await fs.rename(targetPath, backup);
        try {
          await fs.rename(staging, targetPath);
        } catch (e) {
          await fs.rename(backup, targetPath).catch(() => undefined);
          throw e;
        }
        await fs.rm(backup, { recursive: true, force: true });
      } catch (e) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw new SkillImportError("target", e instanceof Error ? e.message : String(e));
      }
    } else {
      try {
        await fs.rename(staging, targetPath);
      } catch (e) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw new SkillImportError("target", e instanceof Error ? e.message : String(e));
      }
    }
    results.push({
      sourcePath: decision.sourcePath,
      name: sourceName,
      status: "imported",
      targetPath,
      ...(decision.action === "rename" ? { finalName } : {}),
      missingDescription,
    });
  }
  return results;
}
