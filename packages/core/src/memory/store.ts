/**
 * 长期记忆文件读写、索引生成与总览查询（ADR-0098）。
 * 每条记忆一个 `<name>.md` 文件，临时文件 + rename 原子写入。
 */
import { parseDocument, stringify } from "yaml";

import { fsErrorCode, type FileSystem, type PathOps, type Platform } from "../platform/index.js";
import {
  isMemoryType,
  isValidMemoryName,
  MEMORY_INDEX_MAX_CHARS,
  type MemoryContextSnapshot,
  type MemoryDescription,
  type MemoryEntry,
  type MemoryEntryMeta,
  type MemoryScope,
  type MemoryScopeIndex,
  type MemoryScopeOverview,
  type MemorySettings,
  type MemoryType,
  type OtherProjectMemory,
} from "../protocol/index.js";
import {
  globalMemoryDir,
  isDefaultMemoryWorkspace,
  projectMemoryKey,
  projectsMemoryRoot,
  resolveMemoryScopeDir,
} from "./scopes.js";

const MEMORY_TRUNCATION_MARKER = "\n... [truncated: memory index exceeded 25,000 characters]";

export type ParseMemoryResult =
  | {
      ok: true;
      description: string;
      type: MemoryType;
      content: string;
      raw: string;
    }
  | { ok: false; error: string };

/** 解析单条记忆文件的前言与正文 */
export function parseMemoryFile(text: string, expectedName: string): ParseMemoryResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { ok: false, error: "缺少 YAML 前言" };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(normalized.slice(end))) {
    return { ok: false, error: "YAML 前言未闭合" };
  }
  const doc = parseDocument(normalized.slice(4, end), { uniqueKeys: true });
  if (doc.errors.length > 0) {
    return { ok: false, error: `YAML 解析失败：${doc.errors[0]?.message ?? "语法错误"}` };
  }
  const rawFields: unknown = doc.toJS({ maxAliasCount: 100 });
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    return { ok: false, error: "YAML 前言必须是键值对象" };
  }
  const fields = rawFields as Record<string, unknown>;
  if (!isValidMemoryName(fields.name)) {
    return { ok: false, error: "前言 name 无效（须匹配 ^[a-z0-9][a-z0-9-]*$）" };
  }
  if (fields.name !== expectedName) {
    return { ok: false, error: `前言 name "${fields.name}" 与文件名 "${expectedName}" 不一致` };
  }
  if (typeof fields.description !== "string" || fields.description.trim() === "") {
    return { ok: false, error: "前言 description 必须是非空字符串" };
  }
  if (!isMemoryType(fields.type)) {
    return { ok: false, error: "前言 type 必须是 user | feedback | project | reference" };
  }
  const content = normalized
    .slice(end + 4)
    .replace(/^\n{1,2}/, "")
    .replace(/\n$/, "");
  return {
    ok: true,
    description: fields.description.trim(),
    type: fields.type,
    content,
    raw: text,
  };
}

/** 序列化单条记忆为带 YAML 前言的 Markdown */
export function formatMemoryFile(input: {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}): string {
  const cleanDescription = input.description.replace(/\r?\n/g, " ").trim();
  const frontmatter = stringify({
    name: input.name,
    description: cleanDescription,
    type: input.type,
  }).trimEnd();
  const body = input.content.replace(/\r\n/g, "\n").trim();
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function writeTextAtomic(
  fs: FileSystem,
  paths: PathOps,
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(paths.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

async function ensureWorkspaceJson(
  platform: Platform,
  dir: string,
  projectPath: string,
): Promise<void> {
  const workspaceJsonPath = platform.paths.join(dir, "workspace.json");
  if (await platform.fs.exists(workspaceJsonPath)) {
    try {
      const parsed = JSON.parse(await platform.fs.readTextFile(workspaceJsonPath)) as {
        version?: unknown;
        path?: unknown;
      };
      if (parsed.version === 1 && typeof parsed.path === "string" && parsed.path !== "") return;
    } catch {
      // 损坏时重新写入
    }
  }
  await writeTextAtomic(
    platform.fs,
    platform.paths,
    workspaceJsonPath,
    `${JSON.stringify({ version: 1, path: projectPath }, null, 2)}\n`,
  );
}

/** 列出单个范围内的记忆条目与损坏前言警告 */
export async function listMemoryDir(
  platform: Platform,
  dir: string,
): Promise<{ entries: MemoryEntryMeta[]; warnings: string[] }> {
  if (!(await platform.fs.exists(dir))) {
    return { entries: [], warnings: [] };
  }
  const dirEntries = await platform.fs.readdir(dir);
  const entries: MemoryEntryMeta[] = [];
  const warnings: string[] = [];
  for (const item of dirEntries) {
    if (item.type !== "file" || !item.name.endsWith(".md")) continue;
    const stem = item.name.slice(0, -3);
    if (!isValidMemoryName(stem)) {
      warnings.push(`${item.path}: 文件名不符合规范（须匹配 ^[a-z0-9][a-z0-9-]*$.md）`);
      continue;
    }
    try {
      const [text, stat] = await Promise.all([
        platform.fs.readTextFile(item.path),
        platform.fs.stat(item.path),
      ]);
      const parsed = parseMemoryFile(text, stem);
      if (!parsed.ok) {
        warnings.push(`${item.path}: ${parsed.error}`);
        continue;
      }
      entries.push({
        name: stem,
        description: parsed.description,
        type: parsed.type,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      });
    } catch (e) {
      warnings.push(`${item.path}: 读取失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, warnings };
}

export type ReadMemoryResult =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; code: "memory_not_found" | "invalid_memory"; message: string };

/** 读取单条记忆全文 */
export async function readMemoryEntry(
  platform: Platform,
  dir: string,
  scope: MemoryScope,
  name: string,
): Promise<ReadMemoryResult> {
  if (!isValidMemoryName(name)) {
    return {
      ok: false,
      code: "invalid_memory",
      message: `Invalid memory name "${name}". Name must match ^[a-z0-9][a-z0-9-]*$.`,
    };
  }
  const filePath = platform.paths.join(dir, `${name}.md`);
  const stat = await platform.fs.lstat(filePath).catch(() => undefined);
  if (stat?.type !== "file") {
    return {
      ok: false,
      code: "memory_not_found",
      message: `Memory "${name}" was not found in ${scope} scope.`,
    };
  }
  const text = await platform.fs.readTextFile(filePath);
  const parsed = parseMemoryFile(text, name);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "invalid_memory",
      message: `Memory "${name}" in ${scope} scope has invalid frontmatter: ${parsed.error}`,
    };
  }
  return {
    ok: true,
    entry: {
      scope,
      name,
      description: parsed.description,
      type: parsed.type,
      content: parsed.content,
      raw: parsed.raw,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    },
  };
}

/** 新建或覆盖单条记忆（临时文件 + rename；首次写项目范围创建 workspace.json） */
export async function writeMemoryEntry(
  platform: Platform,
  target: {
    dir: string;
    scope: MemoryScope;
    projectPath?: string | undefined;
  },
  input: {
    name: string;
    description: string;
    type: MemoryType;
    content: string;
  },
): Promise<MemoryEntry> {
  if (!isValidMemoryName(input.name)) {
    throw new Error(`Invalid memory name "${input.name}". Name must match ^[a-z0-9][a-z0-9-]*$.`);
  }
  if (typeof input.description !== "string" || input.description.trim() === "") {
    throw new Error("Memory description must be a non-empty string.");
  }
  if (!isMemoryType(input.type)) {
    throw new Error("Memory type must be user, feedback, project, or reference.");
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    throw new Error("Memory content must be a non-empty string.");
  }
  await platform.fs.mkdir(target.dir);
  if (target.scope === "project" && target.projectPath !== undefined) {
    await ensureWorkspaceJson(platform, target.dir, target.projectPath);
  }
  const raw = formatMemoryFile(input);
  const filePath = platform.paths.join(target.dir, `${input.name}.md`);
  await writeTextAtomic(platform.fs, platform.paths, filePath, raw);
  const stat = await platform.fs.stat(filePath);
  return {
    scope: target.scope,
    name: input.name,
    description: input.description.replace(/\r?\n/g, " ").trim(),
    type: input.type,
    content: input.content.replace(/\r\n/g, "\n").trim(),
    raw,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

/** 删除单条记忆文件；文件不存在返回 false */
export async function deleteMemoryEntry(
  platform: Platform,
  dir: string,
  name: string,
): Promise<boolean> {
  if (!isValidMemoryName(name)) {
    throw new Error(`Invalid memory name "${name}". Name must match ^[a-z0-9][a-z0-9-]*$.`);
  }
  const filePath = platform.paths.join(dir, `${name}.md`);
  try {
    await platform.fs.unlink(filePath);
    return true;
  } catch (e) {
    if (fsErrorCode(e) === "ENOENT") return false;
    throw e;
  }
}

/** 清空范围内所有记忆文件（项目范围同时清理 workspace.json） */
export async function clearMemoryDir(
  platform: Platform,
  dir: string,
  scope: MemoryScope,
): Promise<void> {
  if (!(await platform.fs.exists(dir))) return;
  const entries = await platform.fs.readdir(dir);
  for (const item of entries) {
    if (item.type !== "file") continue;
    if (item.name.endsWith(".md") || (scope === "project" && item.name === "workspace.json")) {
      await platform.fs.unlink(item.path).catch((e: unknown) => {
        if (fsErrorCode(e) !== "ENOENT") throw e;
      });
    }
  }
}

/** 生成单个范围的索引文本（超 25,000 字符截断加标记，空范围为 `(empty)`） */
export function formatMemoryScopeIndex(
  entries: readonly Pick<MemoryEntryMeta, "name" | "type" | "description">[],
  maxChars = MEMORY_INDEX_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (entries.length === 0) {
    return { text: "(empty)", truncated: false };
  }
  const lines = entries.map(
    (e) => `- ${e.name} (${e.type}): ${e.description.replace(/\r?\n/g, " ").trim()}`,
  );
  const full = lines.join("\n");
  if (full.length <= maxChars) {
    return { text: full, truncated: false };
  }
  const budget = Math.max(0, maxChars - MEMORY_TRUNCATION_MARKER.length);
  const kept: string[] = [];
  let len = 0;
  for (const line of lines) {
    const addition = kept.length === 0 ? line.length : 1 + line.length;
    if (len + addition > budget) break;
    kept.push(line);
    len += addition;
  }
  if (kept.length === 0) {
    const head = (lines[0] ?? "").slice(0, budget);
    return {
      text: `${head}${MEMORY_TRUNCATION_MARKER.trimStart()}`.slice(0, maxChars),
      truncated: true,
    };
  }
  return {
    text: `${kept.join("\n")}${MEMORY_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

/** 为上下文组装拍摄记忆索引快照（只包含启用的范围） */
export async function snapshotMemoryContext(
  platform: Platform,
  nocturneHome: string,
  input: {
    scopes: readonly MemoryScope[];
    workspaceRoot: string;
    suiteId?: string | undefined;
    writable: boolean;
  },
): Promise<MemoryContextSnapshot | undefined> {
  if (input.scopes.length === 0) return undefined;
  const scopes: MemoryScopeIndex[] = [];
  for (const scope of input.scopes) {
    const resolved = await resolveMemoryScopeDir(platform, nocturneHome, {
      scope,
      ...(scope === "suite" ? { key: input.suiteId } : { workspaceRoot: input.workspaceRoot }),
    });
    if (resolved === undefined) continue;
    const { entries } = await listMemoryDir(platform, resolved.dir);
    const { text, truncated } = formatMemoryScopeIndex(entries);
    scopes.push({
      scope,
      text,
      count: entries.length,
      ...(truncated ? { truncated: true } : {}),
    });
  }
  if (scopes.length === 0) return undefined;
  return { writable: input.writable, scopes };
}

/** 查询全局、当前项目、其他项目（及可选组曲）的记忆总览（ADR-0098 §7） */
export async function describeMemoryStore(
  platform: Platform,
  nocturneHome: string,
  input: {
    workspaceRoot: string;
    switches: MemorySettings;
    suiteId?: string | undefined;
  },
): Promise<MemoryDescription> {
  const globalDir = globalMemoryDir(platform, nocturneHome);
  const globalList = await listMemoryDir(platform, globalDir);
  const global: MemoryScopeOverview = {
    enabled: input.switches.global,
    dir: globalDir,
    entries: globalList.entries,
    warnings: globalList.warnings,
  };

  let project: MemoryScopeOverview | undefined;
  let currentProjectKey: string | undefined;
  if (!(await isDefaultMemoryWorkspace(platform, nocturneHome, input.workspaceRoot))) {
    const resolved = await projectMemoryKey(platform, input.workspaceRoot);
    currentProjectKey = resolved.key;
    const projectDir = platform.paths.join(
      projectsMemoryRoot(platform, nocturneHome),
      resolved.key,
    );
    const projectList = await listMemoryDir(platform, projectDir);
    project = {
      enabled: input.switches.project,
      dir: projectDir,
      entries: projectList.entries,
      warnings: projectList.warnings,
    };
  }

  const otherProjects: OtherProjectMemory[] = [];
  const projectsRoot = projectsMemoryRoot(platform, nocturneHome);
  if (await platform.fs.exists(projectsRoot)) {
    for (const dirEntry of await platform.fs.readdir(projectsRoot)) {
      if (dirEntry.type !== "directory") continue;
      if (currentProjectKey !== undefined && dirEntry.name === currentProjectKey) continue;
      const wsJsonPath = platform.paths.join(dirEntry.path, "workspace.json");
      if (!(await platform.fs.exists(wsJsonPath))) continue;
      try {
        const wsJson = JSON.parse(await platform.fs.readTextFile(wsJsonPath)) as {
          version?: unknown;
          path?: unknown;
        };
        if (wsJson.version !== 1 || typeof wsJson.path !== "string" || wsJson.path === "") continue;
        const { entries } = await listMemoryDir(platform, dirEntry.path);
        if (entries.length === 0) continue;
        otherProjects.push({
          key: dirEntry.name,
          path: wsJson.path,
          count: entries.length,
        });
      } catch {
        // workspace.json 损坏时跳过
      }
    }
  }
  otherProjects.sort((a, b) => a.path.localeCompare(b.path) || a.key.localeCompare(b.key));

  let suite: MemoryScopeOverview | undefined;
  if (input.suiteId !== undefined) {
    const resolvedSuite = await resolveMemoryScopeDir(platform, nocturneHome, {
      scope: "suite",
      key: input.suiteId,
    });
    if (resolvedSuite !== undefined) {
      const suiteList = await listMemoryDir(platform, resolvedSuite.dir);
      suite = {
        enabled: true,
        dir: resolvedSuite.dir,
        entries: suiteList.entries,
        warnings: suiteList.warnings,
      };
    }
  }

  return {
    global,
    ...(project !== undefined ? { project } : {}),
    ...(suite !== undefined ? { suite } : {}),
    otherProjects,
  };
}
