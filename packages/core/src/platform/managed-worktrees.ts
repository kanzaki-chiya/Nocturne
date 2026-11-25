/**
 * 本机 Nocturne 托管工作树注册表、实时状态巡检、置顶、可验证恢复快照、安全清理与恢复。
 * 位于 platform 层（允许真实文件系统与 git 子进程 I/O，不依赖项目内非 platform 模块）。
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitMainRepository, resolveWorktreeRootPath } from "./workspace-branches.js";

const runFile = promisify(execFile);

export type PlatformManagedWorktreeKind = "session" | "subagent";
export type PlatformManagedWorktreeState = "active" | "merged" | "ahead";

export interface ManagedWorktreeRegistryEntry {
  id: string;
  kind: PlatformManagedWorktreeKind;
  repository: string;
  worktreePath: string;
  branch: string;
  ownsBranch: boolean;
  sessionId: string;
  childSessionId?: string | undefined;
  pinned: boolean;
  createdAt: number;
  lastUsedAt: number;
}

interface ManagedWorktreeRegistryFile {
  version: 1;
  entries: ManagedWorktreeRegistryEntry[];
}

export interface PlatformWorktreeRecoverySnapshot {
  version: 1;
  id: string;
  createdAt: string;
  reason: "auto" | "manual";
  kind: PlatformManagedWorktreeKind;
  repository: string;
  projectName: string;
  originalPath: string;
  branch: string;
  ownsBranch: boolean;
  headSha: string;
  baseSha?: string | undefined;
  sessionId: string;
  childSessionId?: string | undefined;
  sourceTitle?: string | undefined;
  aheadCount: number;
  dirty: boolean;
  hasBundle: boolean;
  bundlePath?: string | undefined;
  hasStagedPatch?: boolean | undefined;
  stagedPatchPath?: string | undefined;
  stagedPatchSha256?: string | undefined;
  hasWorkingPatch: boolean;
  workingPatchPath?: string | undefined;
  workingPatchSha256?: string | undefined;
  intentToAddPaths?: string[] | undefined;
  stateFingerprint?: string | undefined;
  untrackedFiles: { path: string; sha256: string; size: number }[];
  untrackedSymlinks: { path: string; target: string }[];
  snapshotDir: string;
  restoreSteps: string[];
}

export interface PlatformManagedWorktreeItem {
  id: string;
  kind: PlatformManagedWorktreeKind;
  projectPath: string;
  projectName: string;
  branch: string;
  path: string;
  sourceSessionId: string;
  sourceTitle: string;
  sourceExists: boolean;
  childSessionId?: string | undefined;
  state: PlatformManagedWorktreeState;
  aheadCount: number;
  dirty: boolean;
  ownsBranch: boolean;
  pinned: boolean;
  autoDeleteCandidate: boolean;
  createdAt: number;
  lastUsedAt: number;
}

export interface PlatformManagedWorktreesDescription {
  defaultSubagentRoot: string;
  effectiveSubagentRoot: string;
  worktrees: PlatformManagedWorktreeItem[];
  snapshots: PlatformWorktreeRecoverySnapshot[];
}

export interface PlatformWorktreeDeleteOutcome {
  id: string;
  branch: string;
  path: string;
  status: "deleted" | "skipped_protected" | "skipped_snapshot_failed" | "not_found" | "failed";
  removedBranch?: boolean | undefined;
  snapshot?: PlatformWorktreeRecoverySnapshot | undefined;
  error?: string | undefined;
}

export interface PlatformWorktreeCleanupResult {
  deleted: PlatformWorktreeDeleteOutcome[];
  skipped: PlatformWorktreeDeleteOutcome[];
  failed: PlatformWorktreeDeleteOutcome[];
}

export interface PlatformWorktreeRestoreResult {
  snapshotId: string;
  worktreeId: string;
  worktreePath: string;
  branch: string;
  headSha: string;
  appliedPatch: boolean;
  appliedStagedPatch?: boolean | undefined;
  appliedWorkingPatch?: boolean | undefined;
  restoredUntrackedCount: number;
}

export interface ManagedWorktreeSessionInfo {
  title: string;
  exists: boolean;
  lastActivityAt?: number | undefined;
}

export interface ManagedWorktreeInspector {
  isActive(entry: {
    id: string;
    kind: PlatformManagedWorktreeKind;
    worktreePath: string;
    sessionId: string;
    childSessionId?: string | undefined;
  }): Promise<boolean> | boolean;
  sessionInfo(sessionId: string): Promise<ManagedWorktreeSessionInfo> | ManagedWorktreeSessionInfo;
  worktreeConfig(): {
    subagentRoot: string;
    autoDelete: boolean;
    keepCount: number;
  };
}

interface LegacySubagentRecord {
  childSessionId: string;
  parentSessionId: string;
  repository: string;
  worktree: string;
  branch: string;
  base?: string | undefined;
  applied?: boolean | undefined;
  changes?: { head?: string | undefined } | undefined;
  createdAt?: number | undefined;
}

const registryWriteQueues = new Map<string, Promise<void>>();
const worktreeLocks = new Map<string, Promise<void>>();

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function canonicalPath(value: string): Promise<string> {
  return realpath(value).catch(() => path.resolve(value));
}

async function canonicalPathPreservingMissingLeaf(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    const resolved = path.resolve(value);
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    const realParent = await realpath(parent).catch(() => parent);
    return path.join(realParent, path.basename(resolved));
  }
}

function registryPath(sessionsDir: string): string {
  return path.join(sessionsDir, "worktrees", "managed.json");
}

function snapshotsRoot(sessionsDir: string): string {
  return path.join(sessionsDir, "worktrees", "snapshots");
}

export function managedSessionWorktreeId(worktreePath: string): string {
  const digest = createHash("sha256").update(pathKey(worktreePath)).digest("hex").slice(0, 12);
  return `session:${digest}`;
}

export function managedSubagentWorktreeId(childSessionId: string): string {
  return `subagent:${childSessionId}`;
}

async function gitExec(
  cwd: string,
  args: readonly string[],
  timeout = 30_000,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await runFile("git", [...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        ...extraEnv,
      },
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      stderr !== undefined && stderr !== ""
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

async function gitExecBuffer(
  cwd: string,
  args: readonly string[],
  timeout = 30_000,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  try {
    const { stdout } = await runFile("git", [...args], {
      cwd,
      encoding: "buffer",
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        ...extraEnv,
      },
    });
    return stdout;
  } catch (error) {
    const rawStderr = (error as { stderr?: Buffer | string }).stderr;
    const stderr = Buffer.isBuffer(rawStderr)
      ? rawStderr.toString("utf8").trim()
      : rawStderr?.trim();
    throw new Error(
      stderr !== undefined && stderr !== ""
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

async function withRegistryQueue<T>(sessionsDir: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(sessionsDir);
  const previous = registryWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  registryWriteQueues.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (registryWriteQueues.get(key) === chained) {
      registryWriteQueues.delete(key);
    }
  }
}

async function withWorktreeLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  worktreeLocks.set(lockKey, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (worktreeLocks.get(lockKey) === chained) {
      worktreeLocks.delete(lockKey);
    }
  }
}

async function readRegistryFile(sessionsDir: string): Promise<ManagedWorktreeRegistryEntry[]> {
  const filePath = registryPath(sessionsDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const obj = parsed as { version?: unknown; entries?: unknown };
    if (obj.version !== 1 || !Array.isArray(obj.entries)) return [];
    return obj.entries.filter((entry: unknown): entry is ManagedWorktreeRegistryEntry => {
      if (typeof entry !== "object" || entry === null) return false;
      const rec = entry as Record<string, unknown>;
      return (
        typeof rec.id === "string" &&
        (rec.kind === "session" || rec.kind === "subagent") &&
        typeof rec.repository === "string" &&
        typeof rec.worktreePath === "string" &&
        typeof rec.branch === "string" &&
        typeof rec.ownsBranch === "boolean" &&
        typeof rec.sessionId === "string" &&
        typeof rec.pinned === "boolean" &&
        typeof rec.createdAt === "number" &&
        typeof rec.lastUsedAt === "number"
      );
    });
  } catch {
    return [];
  }
}

async function writeRegistryFileAtomic(
  sessionsDir: string,
  entries: readonly ManagedWorktreeRegistryEntry[],
): Promise<void> {
  const filePath = registryPath(sessionsDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const payload: ManagedWorktreeRegistryFile = { version: 1, entries: [...entries] };
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

async function readLegacySubagentRecords(
  sessionsDir: string,
): Promise<Map<string, LegacySubagentRecord>> {
  const dir = path.join(sessionsDir, "worktrees");
  const files = await readdir(dir).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  const map = new Map<string, LegacySubagentRecord>();
  for (const file of files) {
    if (!file.endsWith(".json") || file === "managed.json") continue;
    const metaPath = path.join(dir, file);
    const st = await lstat(metaPath).catch(() => undefined);
    if (st === undefined || st.isSymbolicLink() || !st.isFile()) continue;
    let parsed: LegacySubagentRecord;
    try {
      parsed = JSON.parse(await readFile(metaPath, "utf8")) as LegacySubagentRecord;
    } catch {
      continue;
    }
    if (
      typeof parsed.childSessionId !== "string" ||
      typeof parsed.parentSessionId !== "string" ||
      typeof parsed.repository !== "string" ||
      typeof parsed.worktree !== "string" ||
      typeof parsed.branch !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(parsed.childSessionId) ||
      file !== `${parsed.childSessionId}.json`
    ) {
      continue;
    }
    map.set(parsed.childSessionId, {
      childSessionId: parsed.childSessionId,
      parentSessionId: parsed.parentSessionId,
      repository: parsed.repository,
      worktree: parsed.worktree,
      branch: parsed.branch,
      ...(typeof parsed.base === "string" ? { base: parsed.base } : {}),
      ...(typeof parsed.applied === "boolean" ? { applied: parsed.applied } : {}),
      ...(parsed.changes !== undefined ? { changes: parsed.changes } : {}),
      ...(typeof parsed.createdAt === "number" ? { createdAt: parsed.createdAt } : {}),
    });
  }
  return map;
}

/**
 * 严格核验并清理子代理受管元数据 JSON：
 * - 仅针对 kind === "subagent" 且含合法 childSessionId 的条目，新会话工作树绝不删除任何旁边 JSON；
 * - 唯一允许路径为 `<sessionsDir>/worktrees/<childSessionId>.json`，绝不信任磁盘 JSON 自声明的 metadataPath，也不盲删 `${wtReal}.json`；
 * - 必须是普通文件（拒绝符号链接），且 JSON 内部身份字段（childSessionId/parentSessionId/worktree/repository/branch 与结构特征）与本条登记完全匹配才删除。
 */
async function removeVerifiedSubagentMetadata(
  sessionsDir: string,
  entry: Pick<ManagedWorktreeRegistryEntry, "kind" | "childSessionId" | "sessionId" | "branch">,
  wtReal: string,
  mainRepoReal: string,
): Promise<boolean> {
  if (entry.kind !== "subagent") return false;
  if (entry.childSessionId === undefined || !/^[A-Za-z0-9_-]+$/.test(entry.childSessionId)) {
    return false;
  }
  const managedDir = path.resolve(sessionsDir, "worktrees");
  const metaPath = path.resolve(managedDir, `${entry.childSessionId}.json`);
  if (pathKey(path.dirname(metaPath)) !== pathKey(managedDir)) {
    return false;
  }
  const st = await lstat(metaPath).catch(() => undefined);
  if (st === undefined || st.isSymbolicLink() || !st.isFile()) {
    return false;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null) return false;
  const rec = raw as Record<string, unknown>;
  if (
    rec.childSessionId !== entry.childSessionId ||
    rec.parentSessionId !== entry.sessionId ||
    rec.branch !== entry.branch ||
    typeof rec.worktree !== "string" ||
    typeof rec.repository !== "string" ||
    typeof rec.base !== "string" ||
    typeof rec.cwd !== "string" ||
    typeof rec.workspaceRoot !== "string" ||
    typeof rec.snapshot !== "boolean"
  ) {
    return false;
  }
  const metaWorktreeReal = await canonicalPathPreservingMissingLeaf(rec.worktree);
  const metaRepoReal = await canonicalPathPreservingMissingLeaf(rec.repository);
  if (pathKey(metaWorktreeReal) !== pathKey(wtReal)) return false;
  if (pathKey(metaRepoReal) !== pathKey(mainRepoReal)) return false;

  await rm(metaPath, { force: true });
  return true;
}

/** 登记托管工作树（幂等更新，保留既有 pinned 标记）。 */
export async function registerManagedWorktree(
  sessionsDir: string,
  input: Omit<ManagedWorktreeRegistryEntry, "id" | "pinned" | "createdAt" | "lastUsedAt"> & {
    id?: string | undefined;
    pinned?: boolean | undefined;
    createdAt?: number | undefined;
    lastUsedAt?: number | undefined;
  },
): Promise<ManagedWorktreeRegistryEntry> {
  const realRepo = await canonicalPath(input.repository);
  const realWorktree = await canonicalPath(input.worktreePath);
  if (pathKey(realRepo) === pathKey(realWorktree)) {
    throw new Error("Refusing to register main repository checkout as a managed worktree");
  }
  const id =
    input.id ??
    (input.kind === "subagent" && input.childSessionId
      ? managedSubagentWorktreeId(input.childSessionId)
      : managedSessionWorktreeId(realWorktree));
  const now = Date.now();
  return withRegistryQueue(sessionsDir, async () => {
    const entries = await readRegistryFile(sessionsDir);
    const existingIdx = entries.findIndex(
      (entry) => entry.id === id || pathKey(entry.worktreePath) === pathKey(realWorktree),
    );
    const existing = existingIdx >= 0 ? entries[existingIdx] : undefined;
    const nextEntry: ManagedWorktreeRegistryEntry = {
      id: existing?.id ?? id,
      kind: input.kind,
      repository: realRepo,
      worktreePath: realWorktree,
      branch: input.branch,
      ownsBranch: input.ownsBranch,
      sessionId: input.sessionId,
      ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
      pinned: input.pinned ?? existing?.pinned ?? false,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      lastUsedAt: input.lastUsedAt ?? now,
    };
    if (existingIdx >= 0) entries[existingIdx] = nextEntry;
    else entries.push(nextEntry);
    await writeRegistryFileAtomic(sessionsDir, entries);
    return nextEntry;
  });
}

/** 刷新托管工作树的最近使用时间（会话打开或切入该工作树时调用）。 */
export async function touchManagedWorktree(
  sessionsDir: string,
  worktreePath: string,
  sessionId?: string,
): Promise<void> {
  const key = pathKey(await canonicalPath(worktreePath));
  await withRegistryQueue(sessionsDir, async () => {
    const entries = await readRegistryFile(sessionsDir);
    const idx = entries.findIndex((entry) => pathKey(entry.worktreePath) === key);
    const current = idx >= 0 ? entries[idx] : undefined;
    if (current === undefined) return;
    entries[idx] = {
      ...current,
      ...(sessionId !== undefined && current.kind === "session" ? { sessionId } : {}),
      lastUsedAt: Date.now(),
    };
    await writeRegistryFileAtomic(sessionsDir, entries);
  });
}

/** 从注册表移除托管工作树条目（如子代理无改动自动移除后同步清理）。 */
export async function unregisterManagedWorktree(
  sessionsDir: string,
  idOrPath: string,
): Promise<void> {
  const targetKey = pathKey(idOrPath);
  await withRegistryQueue(sessionsDir, async () => {
    const entries = await readRegistryFile(sessionsDir);
    const next = entries.filter(
      (entry) => entry.id !== idOrPath && pathKey(entry.worktreePath) !== targetKey,
    );
    if (next.length !== entries.length) {
      await writeRegistryFileAtomic(sessionsDir, next);
    }
  });
}

/** 置顶 / 取消置顶托管工作树（带并发锁，同时兼容尚未写进 managed.json 的旧子代理记录）。 */
export async function setManagedWorktreePinned(
  sessionsDir: string,
  id: string,
  pinned: boolean,
): Promise<{ id: string; pinned: boolean }> {
  return withWorktreeLock(`${pathKey(sessionsDir)}::${id}`, async () =>
    withRegistryQueue(sessionsDir, async () => {
      const entries = await readRegistryFile(sessionsDir);
      const idx = entries.findIndex((entry) => entry.id === id);
      const existing = idx >= 0 ? entries[idx] : undefined;
      if (existing !== undefined) {
        entries[idx] = { ...existing, pinned };
        await writeRegistryFileAtomic(sessionsDir, entries);
        return { id, pinned };
      }
      const legacyMap = await readLegacySubagentRecords(sessionsDir);
      for (const legacy of legacyMap.values()) {
        if (managedSubagentWorktreeId(legacy.childSessionId) !== id) continue;
        const now = legacy.createdAt ?? Date.now();
        entries.push({
          id,
          kind: "subagent",
          repository: await canonicalPath(legacy.repository),
          worktreePath: await canonicalPath(legacy.worktree),
          branch: legacy.branch,
          ownsBranch: true,
          sessionId: legacy.parentSessionId,
          childSessionId: legacy.childSessionId,
          pinned,
          createdAt: now,
          lastUsedAt: now,
        });
        await writeRegistryFileAtomic(sessionsDir, entries);
        return { id, pinned };
      }
      throw new Error(`找不到托管工作树：${id}`);
    }),
  );
}

interface GitWorktreeListEntry {
  path: string;
  head?: string | undefined;
  branch?: string | undefined;
  locked?: boolean | undefined;
  lockReason?: string | undefined;
  prunable?: boolean | undefined;
}

function formatGitLockedMessage(lockReason?: string): string {
  const suffix = lockReason !== undefined && lockReason !== "" ? `（${lockReason}）` : "";
  return `工作树已被 Git 锁定${suffix}，已跳过删除并保留目录、引用与托管登记；如需清理请先执行 git worktree unlock`;
}

async function parseRepoWorktreeList(
  repository: string,
): Promise<Map<string, GitWorktreeListEntry>> {
  const out = await gitExec(repository, ["worktree", "list", "--porcelain", "-z"]);
  const map = new Map<string, GitWorktreeListEntry>();
  let current: GitWorktreeListEntry | undefined;
  for (const token of out.split("\0")) {
    if (token === "") {
      if (current !== undefined) {
        const real = await canonicalPath(current.path);
        map.set(pathKey(real), { ...current, path: real });
        current = undefined;
      }
      continue;
    }
    if (token.startsWith("worktree ")) {
      if (current !== undefined) {
        const real = await canonicalPath(current.path);
        map.set(pathKey(real), { ...current, path: real });
      }
      current = { path: token.slice("worktree ".length) };
    } else if (token.startsWith("HEAD ") && current !== undefined) {
      current.head = token.slice("HEAD ".length);
    } else if (token.startsWith("branch refs/heads/") && current !== undefined) {
      current.branch = token.slice("branch refs/heads/".length);
    } else if (token === "locked" && current !== undefined) {
      current.locked = true;
    } else if (token.startsWith("locked ") && current !== undefined) {
      current.locked = true;
      current.lockReason = token.slice("locked ".length);
    } else if ((token === "prunable" || token.startsWith("prunable ")) && current !== undefined) {
      current.prunable = true;
    }
  }
  if (current !== undefined) {
    const real = await canonicalPath(current.path);
    map.set(pathKey(real), { ...current, path: real });
  }
  return map;
}

async function resolveCompareRef(repository: string): Promise<string> {
  // 优先检查主检出 HEAD，再回退常见主干分支，确保判断独有提交准确
  const candidates = ["HEAD", "refs/heads/main", "refs/heads/master"];
  for (const ref of candidates) {
    try {
      const sha = (await gitExec(repository, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
      if (sha) return sha;
    } catch {
      /* continue */
    }
  }
  return "HEAD";
}

interface LiveGitStatus {
  branch: string;
  detached: boolean;
  headSha: string;
  baseSha?: string | undefined;
  aheadCount: number;
  dirty: boolean;
}

async function inspectWorktreeLiveGit(
  repository: string,
  worktreePath: string,
  fallbackBranch: string,
  legacy?: LegacySubagentRecord,
): Promise<LiveGitStatus> {
  const headSha = (await gitExec(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const abbrev = (
    await gitExec(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
  ).trim();
  const detached = abbrev === "" || abbrev === "HEAD";
  const branch = !detached ? abbrev : fallbackBranch;
  const statusPorcelain = await gitExec(worktreePath, [
    "status",
    "--porcelain=v1",
    "--ignore-submodules=none",
  ]);
  const dirty = statusPorcelain.trim().length > 0;

  const compareSha = await resolveCompareRef(repository);
  const baseSha =
    (await gitExec(repository, ["merge-base", compareSha, headSha]).catch(() => "")).trim() ||
    undefined;

  let aheadCount = 0;
  if (
    legacy?.applied === true &&
    !dirty &&
    (!legacy.changes?.head || legacy.changes.head === headSha)
  ) {
    aheadCount = 0;
  } else {
    let isAncestor = false;
    try {
      await gitExec(repository, ["merge-base", "--is-ancestor", headSha, compareSha]);
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) {
      // 也检查是否已并入主干（main/master）
      for (const trunk of ["refs/heads/main", "refs/heads/master"]) {
        try {
          await gitExec(repository, ["merge-base", "--is-ancestor", headSha, trunk]);
          isAncestor = true;
          break;
        } catch {
          /* continue */
        }
      }
    }
    if (!isAncestor) {
      const range =
        legacy?.base && legacy.base !== headSha
          ? `${legacy.base}..${headSha}`
          : `${compareSha}..${headSha}`;
      const countRaw = (
        await gitExec(repository, ["rev-list", "--count", range]).catch(() => "1")
      ).trim();
      const parsed = Number.parseInt(countRaw, 10);
      aheadCount = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    }
  }
  return { branch, detached, headSha, baseSha, aheadCount, dirty };
}

function sha256Buffer(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function formatSamplePaths(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max);
  return paths.length > max ? `${shown.join("、")} 等 ${paths.length} 项` : shown.join("、");
}

function assertSafeRelativePath(rel: string, kind: string): void {
  if (
    rel === "" ||
    path.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    rel.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`不安全的${kind}路径：${rel}`);
  }
}

interface ParsedPorcelainStatus {
  ignoredPaths: string[];
  conflictPaths: string[];
  untrackedPaths: string[];
  intentToAddPaths: string[];
}

function parseStatusPorcelainZ(raw: string): ParsedPorcelainStatus {
  const ignoredPaths: string[] = [];
  const conflictPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const intentToAddPaths: string[] = [];
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.length < 4 || token[2] !== " ") {
      throw new Error(`无法解析的工作树 Git 状态条目：${token}`);
    }
    const x = token.charAt(0);
    const y = token.charAt(1);
    const filePath = token.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      // --porcelain=v1 -z 重命名/复制后紧跟源路径
      i += 1;
    }
    if (x === "!" && y === "!") {
      ignoredPaths.push(filePath);
    } else if (x === "?" && y === "?") {
      untrackedPaths.push(filePath);
    } else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflictPaths.push(filePath);
    } else if (x === " " && y === "A") {
      intentToAddPaths.push(filePath);
    }
  }
  return { ignoredPaths, conflictPaths, untrackedPaths, intentToAddPaths };
}

async function detectInProgressGitOps(worktreePath: string): Promise<string[]> {
  const rawGitDir = (await gitExec(worktreePath, ["rev-parse", "--git-dir"])).trim();
  const gitDir = path.resolve(worktreePath, rawGitDir);
  const checks: readonly [string, string][] = [
    ["MERGE_HEAD", "merge"],
    ["REBASE_HEAD", "rebase"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase/am"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
    ["BISECT_START", "bisect"],
    ["sequencer", "sequencer"],
  ];
  const active = new Set<string>();
  for (const [marker, label] of checks) {
    if (existsSync(path.join(gitDir, marker))) {
      active.add(label);
    }
  }
  return [...active];
}

function parseStageEntries(raw: string): {
  gitlinks: Map<string, string>;
  unmergedPaths: string[];
} {
  const gitlinks = new Map<string, string>();
  const unmergedPaths: string[] = [];
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(" ");
    const filePath = entry.slice(tab + 1);
    const mode = meta[0];
    const sha = meta[1];
    const stage = meta[2];
    if (stage !== "0") unmergedPaths.push(filePath);
    if (mode === "160000" && sha) gitlinks.set(filePath, sha);
  }
  return { gitlinks, unmergedPaths };
}

function parseTreeGitlinks(raw: string): Map<string, string> {
  const gitlinks = new Map<string, string>();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(" ");
    const filePath = entry.slice(tab + 1);
    if (meta[0] === "160000" && meta[2]) {
      gitlinks.set(filePath, meta[2]);
    }
  }
  return gitlinks;
}

function detectSpecialIndexFlagPaths(lsFilesVOut: string): string[] {
  const flagged: string[] = [];
  for (const entry of lsFilesVOut.split("\0")) {
    if (entry.length < 3 || entry[1] !== " ") continue;
    const tag = entry.charAt(0);
    const filePath = entry.slice(2);
    // S = skip-worktree；小写字母 = assume-unchanged，会导致 git diff 隐藏本地修改
    if (tag === "S" || (tag >= "a" && tag <= "z")) {
      flagged.push(filePath);
    }
  }
  return flagged;
}

function normalizeStageWithoutIntentToAdd(
  rawStage: string,
  intentToAddSet: ReadonlySet<string>,
): string {
  const kept: string[] = [];
  for (const entry of rawStage.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const filePath = entry.slice(tab + 1);
    if (intentToAddSet.has(filePath)) continue;
    kept.push(entry);
  }
  return kept.join("\0");
}

async function inspectSubmodulesSafety(worktreePath: string, prefix = ""): Promise<string[]> {
  const [stageRaw, treeRaw] = await Promise.all([
    gitExec(worktreePath, ["ls-files", "--stage", "-z"]),
    gitExec(worktreePath, ["ls-tree", "-r", "-z", "HEAD"]),
  ]);
  const indexGitlinks = parseStageEntries(stageRaw).gitlinks;
  const headGitlinks = parseTreeGitlinks(treeRaw);
  const allPaths = [...new Set([...indexGitlinks.keys(), ...headGitlinks.keys()])].sort();
  const summaries: string[] = [];

  for (const subPath of allPaths) {
    assertSafeRelativePath(subPath, "子模块");
    const displayPath = prefix ? `${prefix}/${subPath}` : subPath;
    const headSha = headGitlinks.get(subPath);
    const indexSha = indexGitlinks.get(subPath);
    if (headSha !== indexSha) {
      throw new Error(
        `子模块 ${displayPath} 的暂存索引与父工作树 HEAD 不一致，恢复快照无法捕获子模块变更，请先提交或还原后再清理`,
      );
    }

    const subDir = path.resolve(worktreePath, subPath);
    const subStat = await lstat(subDir).catch(() => undefined);
    if (subStat === undefined) {
      summaries.push(`${displayPath}:absent`);
      continue;
    }
    if (!subStat.isDirectory()) {
      throw new Error(
        `子模块路径 ${displayPath} 不是目录，无法确认其本地状态，请先手动检查后再清理`,
      );
    }
    const dirEntries = await readdir(subDir);
    if (dirEntries.length === 0) {
      summaries.push(`${displayPath}:uninitialized`);
      continue;
    }

    // 目录非空：必须是有效的子模块 Git 仓库且完全干净、无额外本地提交/分支/stash/进行中操作
    let subTop: string;
    try {
      const inside = (await gitExec(subDir, ["rev-parse", "--is-inside-work-tree"])).trim();
      if (inside !== "true") {
        throw new Error("not inside work tree");
      }
      subTop = await canonicalPath(
        (await gitExec(subDir, ["rev-parse", "--show-toplevel"])).trim(),
      );
    } catch {
      throw new Error(
        `子模块目录 ${displayPath} 非空但不是有效 Git 工作区，可能包含未保存的本地文件，请先检查或移走后再清理`,
      );
    }
    const expectedSubReal = await canonicalPath(subDir);
    if (pathKey(subTop) !== pathKey(expectedSubReal)) {
      throw new Error(
        `子模块目录 ${displayPath} 含未初始化的本地文件，恢复快照不会捕获，请先移走或处理后再清理`,
      );
    }

    const subOps = await detectInProgressGitOps(subDir);
    if (subOps.length > 0) {
      throw new Error(
        `子模块 ${displayPath} 存在未完成的 Git 操作（${subOps.join("、")}），请先完成或中止后再清理`,
      );
    }

    const [subUnmerged, subLsV, subStatusRaw] = await Promise.all([
      gitExec(subDir, ["ls-files", "--unmerged", "-z"]),
      gitExec(subDir, ["ls-files", "-v", "-z"]),
      gitExec(subDir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
      ]),
    ]);
    if (subUnmerged.length > 0) {
      throw new Error(`子模块 ${displayPath} 存在未解决的合并冲突，请先处理后再清理`);
    }
    const subFlagged = detectSpecialIndexFlagPaths(subLsV);
    if (subFlagged.length > 0) {
      throw new Error(
        `子模块 ${displayPath} 包含 skip-worktree 或 assume-unchanged 标记的文件，请先取消标记后再清理`,
      );
    }
    if (subStatusRaw.length > 0) {
      throw new Error(
        `子模块 ${displayPath} 存在未保存的本地改动、未跟踪文件或被忽略文件，恢复快照不会捕获子模块内部工作，请先提交/推送或移走后再清理`,
      );
    }

    let subHead: string;
    try {
      subHead = (await gitExec(subDir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    } catch {
      throw new Error(`子模块 ${displayPath} 的 HEAD 无有效提交，无法安全清理`);
    }
    if (headSha === undefined || subHead !== headSha) {
      throw new Error(
        `子模块 ${displayPath} 指向的提交与父工作树 HEAD 不一致，恢复快照不包含子模块独立提交，请先推送或还原后再清理`,
      );
    }

    const [extraBranchCommits, subStashes] = await Promise.all([
      gitExec(subDir, ["rev-list", "--branches", "--not", "HEAD"]),
      gitExec(subDir, ["stash", "list"]),
    ]);
    if (extraBranchCommits.trim().length > 0 || subStashes.trim().length > 0) {
      throw new Error(
        `子模块 ${displayPath} 存在未同步的本地分支提交或 stash，恢复快照不会捕获子模块独立历史，请先处理后再清理`,
      );
    }

    summaries.push(`${displayPath}:clean:${subHead}`);
    const nested = await inspectSubmodulesSafety(subDir, displayPath);
    summaries.push(...nested);
  }

  return summaries;
}

interface CapturableWorktreeState {
  headSha: string;
  branch: string;
  detached: boolean;
  indexStageRaw: string;
  stagedPatch: Buffer;
  workingPatch: Buffer;
  intentToAddPaths: string[];
  untrackedFiles: { path: string; sha256: string; size: number }[];
  untrackedSymlinks: { path: string; target: string }[];
  fingerprint: string;
}

/**
 * 清理/快照前对工作树执行全面安全性与可捕获性检查，并生成确定性状态指纹：
 * - 拒绝 unborn/损坏 HEAD、进行中的 Git 操作、未解决冲突、skip-worktree/assume-unchanged；
 * - 拒绝包含被 .gitignore 忽略文件或目录的工作树（快照绝不偷偷复制敏感/被忽略文件）；
 * - 拒绝嵌套 Git 仓库、非常规未跟踪条目、以及存在本地改动/未跟踪/被忽略/独立提交或进行中操作的子模块；
 * - 分别捕获暂存区补丁（HEAD -> index）与工作区补丁（index -> worktree），不丢暂存区独有数据。
 */
async function inspectWorktreeCapturableState(
  worktreePath: string,
  fallbackBranch: string,
): Promise<CapturableWorktreeState> {
  let headSha: string;
  try {
    headSha = (await gitExec(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } catch {
    throw new Error(
      "工作树 HEAD 无有效提交（可能是空分支或仓库状态异常），无法安全保存恢复快照，请先提交或手动处理后再清理",
    );
  }
  const abbrev = (
    await gitExec(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
  ).trim();
  const detached = abbrev === "" || abbrev === "HEAD";
  const branch = !detached ? abbrev : fallbackBranch;

  const activeOps = await detectInProgressGitOps(worktreePath);
  if (activeOps.length > 0) {
    throw new Error(
      `工作树存在未完成的 Git 操作（${activeOps.join("、")}），无法生成完整恢复快照，请先完成或中止该操作后再清理`,
    );
  }

  const [unmergedRaw, lsFilesVRaw, statusRaw, indexStageRaw] = await Promise.all([
    gitExec(worktreePath, ["ls-files", "--unmerged", "-z"]),
    gitExec(worktreePath, ["ls-files", "-v", "-z"]),
    gitExec(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ]),
    gitExec(worktreePath, ["ls-files", "--stage", "-z"]),
  ]);

  const parsedStatus = parseStatusPorcelainZ(statusRaw);
  const stageParsed = parseStageEntries(indexStageRaw);
  const allConflicts = [...new Set([...parsedStatus.conflictPaths, ...stageParsed.unmergedPaths])];
  if (unmergedRaw.length > 0 || allConflicts.length > 0) {
    throw new Error(
      `工作树存在未解决的合并冲突（${formatSamplePaths(allConflicts.length > 0 ? allConflicts : ["索引冲突"])}），无法完整保存冲突状态，请先解决冲突后再清理`,
    );
  }

  const flaggedPaths = detectSpecialIndexFlagPaths(lsFilesVRaw);
  if (flaggedPaths.length > 0) {
    throw new Error(
      `工作树包含 skip-worktree 或 assume-unchanged 标记的文件（${formatSamplePaths(flaggedPaths)}），Git 无法保证差异捕获完整，请先取消标记后再清理`,
    );
  }

  // 绝不偷偷复制被忽略文件/目录：一旦检测到即保守拒绝自动与手动清理并保留工作树
  if (parsedStatus.ignoredPaths.length > 0) {
    throw new Error(
      `工作树包含被 .gitignore 忽略的本地文件或目录（${formatSamplePaths(parsedStatus.ignoredPaths)}），恢复快照不会复制被忽略文件，已跳过删除并保留工作树；请先备份、移走或清理后再重试`,
    );
  }

  // 递归核验所有子模块内部无未保存改动、未跟踪/被忽略文件、独立提交或未完成操作
  const submoduleSummaries = await inspectSubmodulesSafety(worktreePath);

  // 检查未跟踪条目（包含嵌套 Git 仓库检测，只接受常规文件与符号链接）
  const lsOthersRaw = await gitExec(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untrackedCandidates = [
    ...new Set([...parsedStatus.untrackedPaths, ...lsOthersRaw.split("\0").filter(Boolean)]),
  ].sort();
  const nestedOrDirUntracked = untrackedCandidates.filter(
    (rel) => rel.endsWith("/") || rel.endsWith("\\"),
  );
  if (nestedOrDirUntracked.length > 0) {
    throw new Error(
      `工作树包含嵌套的 Git 仓库或未跟踪目录（${formatSamplePaths(nestedOrDirUntracked)}），恢复快照无法安全捕获其内部数据，请先移走或处理后再清理`,
    );
  }

  const untrackedFiles: { path: string; sha256: string; size: number }[] = [];
  const untrackedSymlinks: { path: string; target: string }[] = [];
  for (const rel of untrackedCandidates) {
    assertSafeRelativePath(rel, "未跟踪文件");
    const src = path.resolve(worktreePath, rel);
    const srcStat = await lstat(src);
    if (srcStat.isSymbolicLink()) {
      const target = await readlink(src);
      untrackedSymlinks.push({ path: rel, target });
      continue;
    }
    if (srcStat.isDirectory()) {
      throw new Error(
        `工作树包含嵌套的 Git 仓库或未跟踪目录（${rel}），恢复快照无法安全捕获其内部数据，请先移走或处理后再清理`,
      );
    }
    if (!srcStat.isFile()) {
      throw new Error(`无法为非常规未跟踪条目创建恢复快照：${rel}`);
    }
    const srcBuf = await readFile(src);
    untrackedFiles.push({ path: rel, sha256: sha256Buffer(srcBuf), size: srcBuf.length });
  }

  // 分离捕获暂存区补丁（HEAD -> index）与工作区补丁（index -> worktree）
  const [stagedNameStatus, workingNameStatus] = await Promise.all([
    gitExec(worktreePath, ["diff", "--cached", "--name-status", "--no-renames", "HEAD"]),
    gitExec(worktreePath, ["diff", "--name-status", "--no-renames"]),
  ]);
  const stagedPatch =
    stagedNameStatus.trim().length > 0
      ? await gitExecBuffer(worktreePath, [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-renames",
          "HEAD",
        ])
      : Buffer.alloc(0);
  if (stagedNameStatus.trim().length > 0 && stagedPatch.length === 0) {
    throw new Error("检测到暂存区改动但无法生成完整 staged.patch，已跳过删除并保留工作树");
  }
  const workingPatch =
    workingNameStatus.trim().length > 0
      ? await gitExecBuffer(worktreePath, ["diff", "--binary", "--full-index", "--no-renames"])
      : Buffer.alloc(0);
  if (workingNameStatus.trim().length > 0 && workingPatch.length === 0) {
    throw new Error("检测到工作区改动但无法生成完整 working.patch，已跳过删除并保留工作树");
  }

  const intentToAddPaths = [...new Set(parsedStatus.intentToAddPaths)].sort();
  const fingerprint = sha256Buffer(
    JSON.stringify({
      headSha,
      branch,
      detached,
      statusSha: sha256Buffer(statusRaw),
      indexStageSha: sha256Buffer(indexStageRaw),
      stagedPatchSha: sha256Buffer(stagedPatch),
      workingPatchSha: sha256Buffer(workingPatch),
      intentToAddPaths,
      untrackedFiles,
      untrackedSymlinks,
      submoduleSummaries,
    }),
  );

  return {
    headSha,
    branch,
    detached,
    indexStageRaw,
    stagedPatch,
    workingPatch,
    intentToAddPaths,
    untrackedFiles,
    untrackedSymlinks,
    fingerprint,
  };
}

function buildRestoreSteps(snapshot: {
  repository: string;
  originalPath: string;
  branch: string;
  headSha: string;
  hasBundle: boolean;
  bundlePath?: string | undefined;
  hasStagedPatch?: boolean | undefined;
  stagedPatchPath?: string | undefined;
  hasWorkingPatch: boolean;
  workingPatchPath?: string | undefined;
  intentToAddPaths?: readonly string[] | undefined;
  untrackedFiles: readonly { path: string }[];
  untrackedSymlinks?: readonly { path: string; target: string }[] | undefined;
  snapshotDir: string;
}): string[] {
  const steps: string[] = [];
  if (snapshot.hasBundle && snapshot.bundlePath) {
    steps.push(`git -C "${snapshot.repository}" fetch "${snapshot.bundlePath}" HEAD`);
  }
  steps.push(
    `git -C "${snapshot.repository}" worktree add -b "${snapshot.branch}" "${snapshot.originalPath}" ${snapshot.headSha}`,
  );
  if (snapshot.hasStagedPatch && snapshot.stagedPatchPath) {
    steps.push(
      `git -C "${snapshot.originalPath}" apply --index --binary --whitespace=nowarn "${snapshot.stagedPatchPath}"`,
    );
  }
  if (snapshot.hasWorkingPatch && snapshot.workingPatchPath) {
    steps.push(
      `git -C "${snapshot.originalPath}" apply --binary --whitespace=nowarn "${snapshot.workingPatchPath}"`,
    );
  }
  if (snapshot.intentToAddPaths && snapshot.intentToAddPaths.length > 0) {
    const quoted = snapshot.intentToAddPaths.map((p) => `"${p}"`).join(" ");
    steps.push(`git -C "${snapshot.originalPath}" add -N -- ${quoted}`);
  }
  if (snapshot.untrackedFiles.length > 0 || (snapshot.untrackedSymlinks?.length ?? 0) > 0) {
    steps.push(
      `Copy untracked files from "${path.join(snapshot.snapshotDir, "untracked")}" into "${snapshot.originalPath}"`,
    );
  }
  return steps;
}

/**
 * 删除前保存并机械校验可恢复快照：
 * - 独有提交通过 git bundle 保存并用 `git bundle verify` 核验可完整取回；
 * - 暂存区改动通过 `staged.patch`（HEAD -> index）保存，工作区改动通过 `working.patch`（index -> worktree）保存；
 * - 用临时 GIT_INDEX_FILE 机械验证两份补丁在 HEAD 上顺序可应用且暂存索引逐条目匹配；
 * - 未跟踪文件逐个复制并双向校验大小与 SHA-256（符号链接记录目标，绝不复制被忽略文件）；
 * - 任一步失败即清理临时目录并抛错，调用方必须跳过删除并保留原工作树。
 */
async function createVerifiedRecoverySnapshot(input: {
  sessionsDir: string;
  reason: "auto" | "manual";
  entry: ManagedWorktreeRegistryEntry;
  live: LiveGitStatus;
  captured: CapturableWorktreeState;
  sourceTitle?: string | undefined;
}): Promise<PlatformWorktreeRecoverySnapshot> {
  const { sessionsDir, reason, entry, live, captured } = input;
  const root = snapshotsRoot(sessionsDir);
  await mkdir(root, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const snapshotId = `${stamp}-${randomBytes(4).toString("hex")}`;
  const tmpDir = path.join(root, `${snapshotId}.tmp-${randomBytes(3).toString("hex")}`);
  const finalDir = path.join(root, snapshotId);

  await mkdir(tmpDir, { recursive: true });
  try {
    let hasBundle = false;
    let bundlePathFinal: string | undefined;
    const bundleTmp = path.join(tmpDir, "commits.bundle");

    // 当存在独有提交或 HEAD 尚未进入主仓库 HEAD 时，必须打包并校验 git bundle
    let needBundle = live.aheadCount > 0;
    if (!needBundle) {
      try {
        await gitExec(entry.repository, ["merge-base", "--is-ancestor", captured.headSha, "HEAD"]);
      } catch {
        needBundle = true;
      }
    }
    if (needBundle) {
      const bundleArgs =
        live.baseSha && live.baseSha !== captured.headSha
          ? ["bundle", "create", bundleTmp, `${live.baseSha}..HEAD`]
          : ["bundle", "create", bundleTmp, "HEAD"];
      try {
        await gitExec(entry.worktreePath, bundleArgs);
      } catch {
        await gitExec(entry.worktreePath, ["bundle", "create", bundleTmp, "HEAD"]);
      }
      // 机械校验：bundle 必须在主仓库通过 git bundle verify
      await gitExec(entry.repository, ["bundle", "verify", bundleTmp]);
      const bundleStat = await stat(bundleTmp);
      if (!bundleStat.isFile() || bundleStat.size === 0) {
        throw new Error("恢复快照 commits.bundle 校验失败：文件为空");
      }
      hasBundle = true;
      bundlePathFinal = path.join(finalDir, "commits.bundle");
    }

    // 1. 写入并校验暂存区补丁 staged.patch（HEAD -> index）
    let hasStagedPatch = false;
    let stagedPatchPathFinal: string | undefined;
    let stagedPatchSha256: string | undefined;
    const stagedTmp = path.join(tmpDir, "staged.patch");
    if (captured.stagedPatch.length > 0) {
      await writeFile(stagedTmp, captured.stagedPatch);
      const written = await readFile(stagedTmp);
      const expectedHash = sha256Buffer(captured.stagedPatch);
      const actualHash = sha256Buffer(written);
      if (actualHash !== expectedHash || written.length !== captured.stagedPatch.length) {
        throw new Error("恢复快照 staged.patch 写入校验不一致");
      }
      hasStagedPatch = true;
      stagedPatchPathFinal = path.join(finalDir, "staged.patch");
      stagedPatchSha256 = expectedHash;
    }

    // 2. 写入并校验工作区补丁 working.patch（index -> worktree）
    let hasWorkingPatch = false;
    let workingPatchPathFinal: string | undefined;
    let workingPatchSha256: string | undefined;
    const workingTmp = path.join(tmpDir, "working.patch");
    if (captured.workingPatch.length > 0) {
      await writeFile(workingTmp, captured.workingPatch);
      const written = await readFile(workingTmp);
      const expectedHash = sha256Buffer(captured.workingPatch);
      const actualHash = sha256Buffer(written);
      if (actualHash !== expectedHash || written.length !== captured.workingPatch.length) {
        throw new Error("恢复快照 working.patch 写入校验不一致");
      }
      hasWorkingPatch = true;
      workingPatchPathFinal = path.join(finalDir, "working.patch");
      workingPatchSha256 = expectedHash;
    }

    // 3. 机械验证：用独立临时 GIT_INDEX_FILE 证明 staged.patch 还原出完全一致的索引，且 working.patch 可顺序叠加
    if (hasStagedPatch || hasWorkingPatch) {
      const verifyIndex = path.join(tmpDir, ".verify-index");
      const verifyEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: verifyIndex };
      try {
        await gitExec(entry.worktreePath, ["read-tree", captured.headSha], 30_000, verifyEnv);
        if (hasStagedPatch) {
          await gitExec(
            entry.worktreePath,
            ["apply", "--cached", "--binary", "--whitespace=nowarn", stagedTmp],
            30_000,
            verifyEnv,
          );
        }
        const verifiedStageRaw = await gitExec(
          entry.worktreePath,
          ["ls-files", "--stage", "-z"],
          30_000,
          verifyEnv,
        );
        const itaSet = new Set(captured.intentToAddPaths);
        if (
          normalizeStageWithoutIntentToAdd(verifiedStageRaw, itaSet) !==
          normalizeStageWithoutIntentToAdd(captured.indexStageRaw, itaSet)
        ) {
          throw new Error("恢复快照暂存区索引机械核验不一致，无法保证完整恢复");
        }
        if (hasWorkingPatch) {
          await gitExec(
            entry.worktreePath,
            ["apply", "--cached", "--binary", "--whitespace=nowarn", workingTmp],
            30_000,
            verifyEnv,
          );
        }
      } finally {
        await rm(verifyIndex, { force: true }).catch(() => undefined);
      }
    }

    // 4. 复制已核验的未跟踪文件（绝不含被忽略文件），双向校验大小与 SHA-256
    const untrackedFiles: { path: string; sha256: string; size: number }[] = [];
    const untrackedSymlinks = [...captured.untrackedSymlinks];
    const untrackedTmpRoot = path.join(tmpDir, "untracked");

    for (const fileMeta of captured.untrackedFiles) {
      assertSafeRelativePath(fileMeta.path, "未跟踪文件");
      const src = path.resolve(entry.worktreePath, fileMeta.path);
      const dst = path.resolve(untrackedTmpRoot, fileMeta.path);
      await mkdir(path.dirname(dst), { recursive: true });
      const srcBuf = await readFile(src);
      const srcHash = sha256Buffer(srcBuf);
      if (srcHash !== fileMeta.sha256 || srcBuf.length !== fileMeta.size) {
        throw new Error(`未跟踪文件在快照期间发生变化：${fileMeta.path}`);
      }
      await copyFile(src, dst);
      const dstBuf = await readFile(dst);
      const dstHash = sha256Buffer(dstBuf);
      if (dstHash !== srcHash || dstBuf.length !== srcBuf.length) {
        throw new Error(`未跟踪文件快照校验失败：${fileMeta.path}`);
      }
      untrackedFiles.push({ path: fileMeta.path, sha256: srcHash, size: srcBuf.length });
    }

    const projectName = path.basename(entry.repository);
    const manifest: PlatformWorktreeRecoverySnapshot = {
      version: 1,
      id: snapshotId,
      createdAt: new Date().toISOString(),
      reason,
      kind: entry.kind,
      repository: entry.repository,
      projectName,
      originalPath: entry.worktreePath,
      branch: captured.branch,
      ownsBranch: entry.ownsBranch,
      headSha: captured.headSha,
      ...(live.baseSha ? { baseSha: live.baseSha } : {}),
      sessionId: entry.sessionId,
      ...(entry.childSessionId !== undefined ? { childSessionId: entry.childSessionId } : {}),
      ...(input.sourceTitle !== undefined ? { sourceTitle: input.sourceTitle } : {}),
      aheadCount: live.aheadCount,
      dirty: live.dirty,
      hasBundle,
      ...(bundlePathFinal !== undefined ? { bundlePath: bundlePathFinal } : {}),
      hasStagedPatch,
      ...(stagedPatchPathFinal !== undefined ? { stagedPatchPath: stagedPatchPathFinal } : {}),
      ...(stagedPatchSha256 !== undefined ? { stagedPatchSha256 } : {}),
      hasWorkingPatch,
      ...(workingPatchPathFinal !== undefined ? { workingPatchPath: workingPatchPathFinal } : {}),
      ...(workingPatchSha256 !== undefined ? { workingPatchSha256 } : {}),
      ...(captured.intentToAddPaths.length > 0
        ? { intentToAddPaths: captured.intentToAddPaths }
        : {}),
      stateFingerprint: captured.fingerprint,
      untrackedFiles,
      untrackedSymlinks,
      snapshotDir: finalDir,
      restoreSteps: buildRestoreSteps({
        repository: entry.repository,
        originalPath: entry.worktreePath,
        branch: captured.branch,
        headSha: captured.headSha,
        hasBundle,
        bundlePath: bundlePathFinal,
        hasStagedPatch,
        stagedPatchPath: stagedPatchPathFinal,
        hasWorkingPatch,
        workingPatchPath: workingPatchPathFinal,
        intentToAddPaths: captured.intentToAddPaths,
        untrackedFiles,
        untrackedSymlinks,
        snapshotDir: finalDir,
      }),
    };

    const manifestTmp = path.join(tmpDir, "manifest.json");
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    // 二次读回核验 manifest JSON 完整可解析
    const verifyManifest = JSON.parse(
      await readFile(manifestTmp, "utf8"),
    ) as PlatformWorktreeRecoverySnapshot;
    if (
      verifyManifest.id !== snapshotId ||
      verifyManifest.headSha !== captured.headSha ||
      verifyManifest.stateFingerprint !== captured.fingerprint
    ) {
      throw new Error("恢复快照 manifest 核验失败");
    }

    await rename(tmpDir, finalDir);
    return manifest;
  } catch (cause) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

export async function listWorktreeRecoverySnapshots(
  sessionsDir: string,
): Promise<PlatformWorktreeRecoverySnapshot[]> {
  const root = snapshotsRoot(sessionsDir);
  const dirs = await readdir(root, { withFileTypes: true }).catch((cause: unknown) => {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw cause;
  });
  const list: PlatformWorktreeRecoverySnapshot[] = [];
  for (const dirent of dirs) {
    if (!dirent.isDirectory() || dirent.name.includes(".tmp-")) continue;
    const manifestPath = path.join(root, dirent.name, "manifest.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>).version === 1 &&
        typeof (parsed as Record<string, unknown>).id === "string" &&
        typeof (parsed as Record<string, unknown>).headSha === "string"
      ) {
        list.push(parsed as PlatformWorktreeRecoverySnapshot);
      }
    } catch {
      /* 忽略不完整快照 */
    }
  }
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function computeAutoDeleteIds(
  items: readonly Pick<
    PlatformManagedWorktreeItem,
    "id" | "state" | "pinned" | "lastUsedAt" | "createdAt"
  >[],
  autoDelete: boolean,
  keepCount: number,
): Set<string> {
  if (!autoDelete || !Number.isSafeInteger(keepCount) || keepCount < 1) return new Set();
  const eligible = items
    .filter((item) => item.state !== "active" && !item.pinned)
    .sort(
      (a, b) =>
        a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  const excess = Math.max(0, eligible.length - keepCount);
  return new Set(eligible.slice(0, excess).map((item) => item.id));
}

async function mergedManagedEntries(sessionsDir: string): Promise<{
  entries: ManagedWorktreeRegistryEntry[];
  legacyByChildId: Map<string, LegacySubagentRecord>;
}> {
  const [registryEntries, legacyByChildId] = await Promise.all([
    readRegistryFile(sessionsDir),
    readLegacySubagentRecords(sessionsDir),
  ]);
  const byId = new Map<string, ManagedWorktreeRegistryEntry>();
  const byPath = new Set<string>();
  for (const entry of registryEntries) {
    byId.set(entry.id, entry);
    byPath.add(pathKey(entry.worktreePath));
  }
  for (const legacy of legacyByChildId.values()) {
    const id = managedSubagentWorktreeId(legacy.childSessionId);
    if (byId.has(id) || byPath.has(pathKey(legacy.worktree))) continue;
    const now = legacy.createdAt ?? Date.now();
    byId.set(id, {
      id,
      kind: "subagent",
      repository: legacy.repository,
      worktreePath: legacy.worktree,
      branch: legacy.branch,
      ownsBranch: true,
      sessionId: legacy.parentSessionId,
      childSessionId: legacy.childSessionId,
      pinned: false,
      createdAt: now,
      lastUsedAt: now,
    });
    byPath.add(pathKey(legacy.worktree));
  }
  return { entries: [...byId.values()], legacyByChildId };
}

/** 聚合本机全部 Nocturne 托管工作树（会话与子代理两类），并附带可恢复快照清单。 */
export async function describeManagedWorktrees(
  sessionsDir: string,
  inspector: ManagedWorktreeInspector,
): Promise<PlatformManagedWorktreesDescription> {
  const defaultSubagentRoot = path.resolve(sessionsDir, "worktrees");
  const cfg = inspector.worktreeConfig();
  const effectiveSubagentRoot =
    resolveWorktreeRootPath(cfg.subagentRoot, os.homedir()) ?? defaultSubagentRoot;

  const { entries, legacyByChildId } = await mergedManagedEntries(sessionsDir);
  const repoListCache = new Map<string, Map<string, GitWorktreeListEntry> | null>();
  const rawItems: PlatformManagedWorktreeItem[] = [];

  for (const entry of entries) {
    const mainRepo = await gitMainRepository(entry.repository).catch(() => null);
    if (mainRepo === null) continue;
    const mainRepoReal = await canonicalPath(mainRepo);
    const wtReal = await canonicalPath(entry.worktreePath);
    // 硬性保护：永不把主检出列为可管理/可清理工作树
    if (pathKey(mainRepoReal) === pathKey(wtReal)) continue;

    const repoCacheKey = pathKey(mainRepoReal);
    let wtMap = repoListCache.get(repoCacheKey);
    if (wtMap === undefined) {
      wtMap = await parseRepoWorktreeList(mainRepoReal).catch(() => null);
      repoListCache.set(repoCacheKey, wtMap);
    }
    const wtListed = wtMap?.get(pathKey(wtReal));
    if (wtListed === undefined || !existsSync(wtReal)) continue;

    const legacy = entry.childSessionId ? legacyByChildId.get(entry.childSessionId) : undefined;
    let live: LiveGitStatus;
    try {
      live = await inspectWorktreeLiveGit(
        mainRepoReal,
        wtReal,
        wtListed.branch ?? entry.branch,
        legacy,
      );
    } catch {
      continue;
    }

    const active = await inspector.isActive({
      id: entry.id,
      kind: entry.kind,
      worktreePath: wtReal,
      sessionId: entry.sessionId,
      childSessionId: entry.childSessionId,
    });
    const session = await inspector.sessionInfo(entry.sessionId);
    const dirStat = await stat(wtReal).catch(() => undefined);
    const lastUsedAt = Math.max(
      entry.lastUsedAt,
      session.lastActivityAt ?? 0,
      dirStat?.mtimeMs ? Math.floor(dirStat.mtimeMs) : 0,
    );
    const state: PlatformManagedWorktreeState = active
      ? "active"
      : live.aheadCount > 0 || live.dirty
        ? "ahead"
        : "merged";

    rawItems.push({
      id: entry.id,
      kind: entry.kind,
      projectPath: mainRepoReal,
      projectName: path.basename(mainRepoReal),
      branch: live.branch,
      path: wtReal,
      sourceSessionId: entry.sessionId,
      sourceTitle: session.title,
      sourceExists: session.exists,
      ...(entry.childSessionId !== undefined ? { childSessionId: entry.childSessionId } : {}),
      state,
      aheadCount: active ? 0 : live.aheadCount,
      dirty: live.dirty,
      ownsBranch: entry.ownsBranch,
      pinned: entry.pinned,
      autoDeleteCandidate: false,
      createdAt: entry.createdAt,
      lastUsedAt,
    });
  }

  const doomed = computeAutoDeleteIds(rawItems, cfg.autoDelete, cfg.keepCount);
  const worktrees = rawItems
    .map((item) => ({ ...item, autoDeleteCandidate: doomed.has(item.id) }))
    .sort((a, b) => {
      if (a.projectPath !== b.projectPath) return b.lastUsedAt - a.lastUsedAt;
      if (a.state === "active" && b.state !== "active") return -1;
      if (a.state !== "active" && b.state === "active") return 1;
      return b.lastUsedAt - a.lastUsedAt || a.branch.localeCompare(b.branch);
    });

  const snapshots = await listWorktreeRecoverySnapshots(sessionsDir);
  return {
    defaultSubagentRoot,
    effectiveSubagentRoot,
    worktrees,
    snapshots,
  };
}

/**
 * 安全删除指定托管工作树集合（手动删除、批量清理与自动清理共用）：
 * 1. 按 id 加并发锁；
 * 2. 复查归属（拒绝非托管副本与主检出）；
 * 3. 复查实时状态（使用中跳过；自动删除时置顶跳过）；
 * 4. 无论自动还是手动，执行全量安全与可捕获性检查（拒绝被忽略文件/目录、脏子模块或未捕获 Git 状态）；
 * 5. 删除前保存并核验恢复快照（自动删除恒保存，手动删除在有独有提交/本地改动或显式要求时保存）；
 *    快照不能完整保存时跳过删除并保留原件；
 * 6. 真正删除前重新核对保护条件、归属与工作树状态指纹，与快照不一致时中止删除并保留原工作树。
 */
export async function deleteManagedWorktrees(
  sessionsDir: string,
  inspector: ManagedWorktreeInspector,
  input: {
    ids: readonly string[];
    reason: "auto" | "manual";
    saveSnapshot?: boolean | undefined;
    /** 仅用于确定性竞争测试：在最终删除前复核之前触发回调 */
    beforeFinalRemoveCheck?:
      | ((ctx: {
          id: string;
          worktreePath: string;
          snapshot?: PlatformWorktreeRecoverySnapshot | undefined;
        }) => Promise<void> | void)
      | undefined;
    /** 仅用于确定性竞争测试：在工作树移除后、原子删除自有分支引用前触发回调 */
    beforeBranchDelete?:
      ((ctx: { id: string; branch: string; headSha: string }) => Promise<void> | void) | undefined;
  },
): Promise<PlatformWorktreeCleanupResult> {
  const result: PlatformWorktreeCleanupResult = { deleted: [], skipped: [], failed: [] };
  const uniqueIds = [...new Set(input.ids)];

  for (const id of uniqueIds) {
    const outcome = await withWorktreeLock(
      `${pathKey(sessionsDir)}::${id}`,
      async (): Promise<PlatformWorktreeDeleteOutcome> => {
        const { entries, legacyByChildId } = await mergedManagedEntries(sessionsDir);
        const entry = entries.find((item) => item.id === id);
        if (entry === undefined) {
          return {
            id,
            branch: "",
            path: "",
            status: "not_found",
            error: "工作树不在托管清单中或已被删除",
          };
        }

        const mainRepo = await gitMainRepository(entry.repository).catch(() => null);
        if (mainRepo === null) {
          return {
            id,
            branch: entry.branch,
            path: entry.worktreePath,
            status: "failed",
            error: "主仓库不可用，拒绝清理",
          };
        }
        const mainRepoReal = await canonicalPath(mainRepo);
        const wtReal = await canonicalPath(entry.worktreePath);
        if (pathKey(mainRepoReal) === pathKey(wtReal)) {
          return {
            id,
            branch: entry.branch,
            path: wtReal,
            status: "failed",
            error: "禁止清理仓库主检出目录",
          };
        }

        const wtMap = await parseRepoWorktreeList(mainRepoReal).catch(() => null);
        const wtListed = wtMap?.get(pathKey(wtReal));
        if (wtListed?.locked === true) {
          return {
            id,
            branch: wtListed.branch ?? entry.branch,
            path: wtReal,
            status: "skipped_protected",
            error: formatGitLockedMessage(wtListed.lockReason),
          };
        }
        if (wtListed === undefined || !existsSync(wtReal)) {
          // 目录与 git 登记均已不存在：同步清理陈旧注册项
          await unregisterManagedWorktree(sessionsDir, id);
          return {
            id,
            branch: entry.branch,
            path: wtReal,
            status: "not_found",
            error: "工作树目录已不存在",
          };
        }

        // 删除前复查实时使用中状态
        const active = await inspector.isActive({
          id: entry.id,
          kind: entry.kind,
          worktreePath: wtReal,
          sessionId: entry.sessionId,
          childSessionId: entry.childSessionId,
        });
        if (active) {
          return {
            id,
            branch: wtListed.branch ?? entry.branch,
            path: wtReal,
            status: "skipped_protected",
            error: "工作树使用中，不能删除",
          };
        }
        // 自动删除时复查实时置顶状态（防止并发置顶竞争）
        if (input.reason === "auto" && entry.pinned) {
          return {
            id,
            branch: wtListed.branch ?? entry.branch,
            path: wtReal,
            status: "skipped_protected",
            error: "工作树已置顶，跳过自动删除",
          };
        }

        // 无条件执行安全与可捕获性检查（覆盖自动与手动清理，绝不误删被忽略文件、脏子模块或未支持 Git 状态）
        const fallbackBranch = wtListed.branch ?? entry.branch;
        let captured: CapturableWorktreeState;
        try {
          captured = await inspectWorktreeCapturableState(wtReal, fallbackBranch);
        } catch (cause) {
          return {
            id,
            branch: fallbackBranch,
            path: wtReal,
            status: "skipped_snapshot_failed",
            error: `无法安全保存工作树本地状态，已跳过删除并保留原工作树：${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }

        const legacy = entry.childSessionId ? legacyByChildId.get(entry.childSessionId) : undefined;
        let live: LiveGitStatus;
        try {
          live = await inspectWorktreeLiveGit(mainRepoReal, wtReal, fallbackBranch, legacy);
        } catch (cause) {
          return {
            id,
            branch: captured.branch,
            path: wtReal,
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }

        const session = await inspector.sessionInfo(entry.sessionId);
        const shouldSnapshot =
          input.reason === "auto" ||
          input.saveSnapshot === true ||
          live.aheadCount > 0 ||
          live.dirty;

        let snapshot: PlatformWorktreeRecoverySnapshot | undefined;
        if (shouldSnapshot) {
          try {
            snapshot = await createVerifiedRecoverySnapshot({
              sessionsDir,
              reason: input.reason,
              entry: { ...entry, repository: mainRepoReal, worktreePath: wtReal },
              live,
              captured,
              sourceTitle: session.title,
            });
          } catch (cause) {
            return {
              id,
              branch: live.branch,
              path: wtReal,
              status: "skipped_snapshot_failed",
              error: `保存恢复快照失败，已跳过删除并保留原工作树：${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
        }

        const discardPendingSnapshot = async () => {
          if (snapshot !== undefined) {
            await rm(snapshot.snapshotDir, { recursive: true, force: true }).catch(() => undefined);
          }
        };

        // 允许确定性测试在快照后、最终复核前注入并发变更或状态切换
        if (input.beforeFinalRemoveCheck !== undefined) {
          await input.beforeFinalRemoveCheck({ id, worktreePath: wtReal, snapshot });
        }

        // 删除前最终复核：重新核对托管归属、保护条件与工作树状态指纹，确认与快照完全一致
        const recheckManaged = await mergedManagedEntries(sessionsDir);
        const latestEntry = recheckManaged.entries.find((item) => item.id === id);
        if (latestEntry === undefined) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "not_found",
            error: "删除前复核发现工作树已不在托管清单中",
          };
        }
        const recheckWtReal = await canonicalPath(latestEntry.worktreePath);
        if (
          pathKey(recheckWtReal) !== pathKey(wtReal) ||
          pathKey(mainRepoReal) === pathKey(recheckWtReal)
        ) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "failed",
            error: "删除前复核发现工作树归属路径已变化，已取消删除",
          };
        }
        const recheckWtMap = await parseRepoWorktreeList(mainRepoReal).catch(() => null);
        const recheckListed = recheckWtMap?.get(pathKey(wtReal));
        if (recheckListed?.locked === true) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "skipped_protected",
            error: formatGitLockedMessage(recheckListed.lockReason),
          };
        }
        if (recheckListed === undefined || !existsSync(wtReal)) {
          await discardPendingSnapshot();
          await unregisterManagedWorktree(sessionsDir, id);
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "not_found",
            error: "删除前复核发现工作树目录已不存在",
          };
        }

        const recheckActive = await inspector.isActive({
          id: latestEntry.id,
          kind: latestEntry.kind,
          worktreePath: wtReal,
          sessionId: latestEntry.sessionId,
          childSessionId: latestEntry.childSessionId,
        });
        if (recheckActive) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "skipped_protected",
            error: "删除前复核发现工作树已进入使用中状态，已取消删除并保留原工作树",
          };
        }
        if (input.reason === "auto" && latestEntry.pinned) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "skipped_protected",
            error: "删除前复核发现工作树已被置顶，已取消自动删除并保留原工作树",
          };
        }

        let recheckedState: CapturableWorktreeState;
        try {
          recheckedState = await inspectWorktreeCapturableState(
            wtReal,
            recheckListed.branch ?? latestEntry.branch,
          );
        } catch (cause) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "skipped_snapshot_failed",
            error: `删除前复核发现无法安全捕获的本地状态，已取消删除并保留原工作树：${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        if (recheckedState.fingerprint !== captured.fingerprint) {
          await discardPendingSnapshot();
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "skipped_snapshot_failed",
            error:
              "删除前复核发现工作树状态在快照后发生变化，为避免丢失最新本地改动已取消删除并保留原工作树，请重试",
          };
        }

        // 执行移除：仅通过 Git 自身移除工作树，绝不回退到 rm(wtReal) + prune 绕过 Git 保护
        try {
          await gitExec(mainRepoReal, ["worktree", "remove", "--force", wtReal]);
        } catch (removeCause) {
          const gitErr = removeCause instanceof Error ? removeCause.message : String(removeCause);
          const dirStillExists = existsSync(wtReal);
          const afterList = await parseRepoWorktreeList(mainRepoReal).catch(() => null);
          const afterEntry = afterList?.get(pathKey(wtReal));

          if (afterEntry?.locked === true) {
            if (dirStillExists) await discardPendingSnapshot();
            return {
              id,
              branch: live.branch,
              path: wtReal,
              status: "skipped_protected",
              error: formatGitLockedMessage(afterEntry.lockReason),
            };
          }

          if (dirStillExists) {
            // Git 拒绝移除且目录仍在：完整保留目录、分支引用、元数据与托管登记
            await discardPendingSnapshot();
            return {
              id,
              branch: live.branch,
              path: wtReal,
              status: "failed",
              error: `Git 拒绝移除工作树，已保留目录、分支引用与托管登记：${gitErr}`,
            };
          }

          // 目录已被 Git 自身移除：仅按实况协调记录，绝不执行破坏性递归删除或强删分支
          if (afterEntry === undefined || afterEntry.prunable === true) {
            await removeVerifiedSubagentMetadata(
              sessionsDir,
              latestEntry,
              wtReal,
              mainRepoReal,
            ).catch(() => undefined);
            await unregisterManagedWorktree(sessionsDir, id);
            return {
              id,
              branch: live.branch,
              path: wtReal,
              status: "failed",
              ...(snapshot !== undefined ? { snapshot } : {}),
              error: `工作树目录已被 Git 移除，已同步清理托管登记并保留分支引用，但 Git 返回错误：${gitErr}`,
            };
          }

          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "failed",
            ...(snapshot !== undefined ? { snapshot } : {}),
            error: `移除工作树未完全完成，已保留托管登记与分支引用：${gitErr}`,
          };
        }

        try {
          // 仅当当前检出的分支确为 Nocturne 创建登记的自有分支、未被其他工作树检出、且 SHA 未移动时原子删除
          let removedBranch = false;
          const ownedBranch = latestEntry.branch;
          if (
            latestEntry.ownsBranch &&
            ownedBranch !== "" &&
            !captured.detached &&
            captured.branch === ownedBranch
          ) {
            if (input.beforeBranchDelete !== undefined) {
              await input.beforeBranchDelete({
                id,
                branch: ownedBranch,
                headSha: captured.headSha,
              });
            }
            const branchRef = `refs/heads/${ownedBranch}`;
            const remainingWorktrees = await parseRepoWorktreeList(mainRepoReal).catch(() => null);
            const checkedOutElsewhere =
              remainingWorktrees === null ||
              [...remainingWorktrees.values()].some((wt) => wt.branch === ownedBranch);
            const mainHeadSym = (
              await gitExec(mainRepoReal, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")
            ).trim();
            if (!checkedOutElsewhere && mainHeadSym !== branchRef) {
              try {
                // 使用 git update-ref -d <ref> <oldSha> 原子 CAS 删除，彻底消除检查后引用移动竞态
                await gitExec(mainRepoReal, ["update-ref", "-d", branchRef, captured.headSha]);
                removedBranch = true;
              } catch {
                // 引用已移动（含新提交）或已被外部删除：绝不回退 branch -D，安全保留
                removedBranch = false;
              }
            }
          }

          // 仅清理严格核验归属的子代理受管元数据，绝不盲删 `${wtReal}.json` 或信任磁盘 metadataPath
          await removeVerifiedSubagentMetadata(
            sessionsDir,
            latestEntry,
            wtReal,
            mainRepoReal,
          ).catch(() => undefined);
          await unregisterManagedWorktree(sessionsDir, id);
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "deleted",
            removedBranch,
            ...(snapshot !== undefined ? { snapshot } : {}),
          };
        } catch (cause) {
          return {
            id,
            branch: live.branch,
            path: wtReal,
            status: "failed",
            ...(snapshot !== undefined ? { snapshot } : {}),
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }
      },
    );

    if (outcome.status === "deleted") result.deleted.push(outcome);
    else if (
      outcome.status === "skipped_protected" ||
      outcome.status === "skipped_snapshot_failed" ||
      outcome.status === "not_found"
    ) {
      result.skipped.push(outcome);
    } else {
      result.failed.push(outcome);
    }
  }

  return result;
}

/** 按当前保留数量策略执行自动删除：跳过置顶与使用中，删除前必存可验证恢复快照。 */
export async function pruneExcessManagedWorktrees(
  sessionsDir: string,
  inspector: ManagedWorktreeInspector,
): Promise<PlatformWorktreeCleanupResult> {
  const cfg = inspector.worktreeConfig();
  if (!cfg.autoDelete || !Number.isSafeInteger(cfg.keepCount) || cfg.keepCount < 1) {
    return { deleted: [], skipped: [], failed: [] };
  }
  // 快速路径：未置顶候选条目总数不超过 keepCount 时，无需启动 git 子进程检查
  const [registryEntries, legacyRecords] = await Promise.all([
    readRegistryFile(sessionsDir),
    readLegacySubagentRecords(sessionsDir),
  ]);
  const seenIds = new Set(registryEntries.map((entry) => entry.id));
  let unpinnedCount = registryEntries.filter((entry) => !entry.pinned).length;
  for (const legacy of legacyRecords.values()) {
    const id = managedSubagentWorktreeId(legacy.childSessionId);
    if (!seenIds.has(id)) unpinnedCount += 1;
  }
  if (unpinnedCount <= cfg.keepCount) {
    return { deleted: [], skipped: [], failed: [] };
  }
  const desc = await describeManagedWorktrees(sessionsDir, inspector);
  const candidateIds = desc.worktrees
    .filter((item) => item.autoDeleteCandidate)
    .map((item) => item.id);
  if (candidateIds.length === 0) return { deleted: [], skipped: [], failed: [] };
  return deleteManagedWorktrees(sessionsDir, inspector, {
    ids: candidateIds,
    reason: "auto",
    saveSnapshot: true,
  });
}

async function pickAvailableBranchName(
  repository: string,
  preferred: string,
  shortId: string,
): Promise<string> {
  const exists = async (name: string): Promise<boolean> => {
    const out = await gitExec(repository, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${name}`,
    ]);
    return out.trim() !== "";
  };
  if (!(await exists(preferred))) return preferred;
  const candidate = `${preferred}-restored-${shortId}`;
  if (!(await exists(candidate))) return candidate;
  return `${preferred}-restored-${shortId}-${randomBytes(2).toString("hex")}`;
}

function pickAvailableWorktreePath(preferred: string, shortId: string): string {
  if (!existsSync(preferred)) return preferred;
  const candidate = `${preferred}-restored-${shortId}`;
  if (!existsSync(candidate)) return candidate;
  return `${preferred}-restored-${shortId}-${randomBytes(2).toString("hex")}`;
}

/** 从已校验的恢复快照还原工作树、独有提交、未提交改动与未跟踪文件。 */
export async function restoreWorktreeRecoverySnapshot(
  sessionsDir: string,
  input: {
    snapshotId: string;
    targetPath?: string | undefined;
    branch?: string | undefined;
  },
): Promise<PlatformWorktreeRestoreResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(input.snapshotId)) {
    throw new Error(`无效的快照 id：${input.snapshotId}`);
  }
  const snapDir = path.join(snapshotsRoot(sessionsDir), input.snapshotId);
  const manifestPath = path.join(snapDir, "manifest.json");
  let manifest: PlatformWorktreeRecoverySnapshot;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PlatformWorktreeRecoverySnapshot;
  } catch {
    throw new Error(`找不到恢复快照：${input.snapshotId}`);
  }

  const mainRepo = await gitMainRepository(manifest.repository);
  if (mainRepo === null) {
    throw new Error(`原仓库已不可用，无法恢复快照：${manifest.repository}`);
  }
  const mainRepoReal = await canonicalPath(mainRepo);

  // 1. 恢复独有提交到主仓库对象库
  if (manifest.hasBundle) {
    const bundleFile = path.join(snapDir, "commits.bundle");
    await gitExec(mainRepoReal, ["bundle", "verify", bundleFile]);
    await gitExec(mainRepoReal, ["fetch", bundleFile, "HEAD"]);
  }
  await gitExec(mainRepoReal, ["rev-parse", "--verify", `${manifest.headSha}^{commit}`]);

  // 2. 校验 staged.patch、working.patch 与 untracked 文件完整性
  let stagedPatchBuf: Buffer | undefined;
  if (manifest.hasStagedPatch === true) {
    const stagedFile = path.join(snapDir, "staged.patch");
    stagedPatchBuf = await readFile(stagedFile);
    if (manifest.stagedPatchSha256 && sha256Buffer(stagedPatchBuf) !== manifest.stagedPatchSha256) {
      throw new Error("恢复快照暂存区补丁校验失败，文件已损坏");
    }
  }
  let patchBuf: Buffer | undefined;
  if (manifest.hasWorkingPatch) {
    const patchFile = path.join(snapDir, "working.patch");
    patchBuf = await readFile(patchFile);
    if (manifest.workingPatchSha256 && sha256Buffer(patchBuf) !== manifest.workingPatchSha256) {
      throw new Error("恢复快照补丁校验失败，文件已损坏");
    }
  }
  for (const file of manifest.untrackedFiles) {
    assertSafeRelativePath(file.path, "未跟踪文件");
    const stored = path.join(snapDir, "untracked", file.path);
    const data = await readFile(stored);
    if (sha256Buffer(data) !== file.sha256) {
      throw new Error(`恢复快照未跟踪文件校验失败：${file.path}`);
    }
  }
  for (const link of manifest.untrackedSymlinks) {
    assertSafeRelativePath(link.path, "未跟踪符号链接");
  }
  for (const ita of manifest.intentToAddPaths ?? []) {
    assertSafeRelativePath(ita, "intent-to-add 文件");
  }

  // 3. 创建还原工作树
  const shortId = input.snapshotId.slice(-6);
  const preferredBranch = input.branch?.trim();
  const restoredBranch = await pickAvailableBranchName(
    mainRepoReal,
    preferredBranch !== undefined && preferredBranch !== "" ? preferredBranch : manifest.branch,
    shortId,
  );
  const targetPath = pickAvailableWorktreePath(
    input.targetPath?.trim() ? path.resolve(input.targetPath) : manifest.originalPath,
    shortId,
  );
  await mkdir(path.dirname(targetPath), { recursive: true });
  await gitExec(mainRepoReal, [
    "worktree",
    "add",
    "-b",
    restoredBranch,
    targetPath,
    manifest.headSha,
  ]);

  const realTarget = await canonicalPath(targetPath);
  let appliedStagedPatch = false;
  let appliedWorkingPatch = false;
  try {
    // 4a. 先应用暂存区补丁到索引与工作区（HEAD -> index）
    if (manifest.hasStagedPatch === true && stagedPatchBuf !== undefined) {
      const stagedFile = path.join(snapDir, "staged.patch");
      await gitExec(realTarget, [
        "apply",
        "--index",
        "--binary",
        "--whitespace=nowarn",
        stagedFile,
      ]);
      appliedStagedPatch = true;
    }

    // 4b. 再仅对工作区应用未暂存补丁（index -> worktree），保持索引版本不变
    if (manifest.hasWorkingPatch && patchBuf !== undefined) {
      const patchFile = path.join(snapDir, "working.patch");
      await gitExec(realTarget, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
      appliedWorkingPatch = true;
    }

    // 4c. 还原 intent-to-add 标记（git add -N）
    if (manifest.intentToAddPaths !== undefined && manifest.intentToAddPaths.length > 0) {
      await gitExec(realTarget, ["add", "-N", "--", ...manifest.intentToAddPaths]);
    }

    // 5. 还原未跟踪文件与符号链接
    for (const file of manifest.untrackedFiles) {
      const src = path.join(snapDir, "untracked", file.path);
      const dst = path.resolve(realTarget, file.path);
      await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
    for (const link of manifest.untrackedSymlinks) {
      const dst = path.resolve(realTarget, link.path);
      await mkdir(path.dirname(dst), { recursive: true });
      await symlink(link.target, dst);
    }

    const registered = await registerManagedWorktree(sessionsDir, {
      kind: manifest.kind,
      repository: mainRepoReal,
      worktreePath: realTarget,
      branch: restoredBranch,
      ownsBranch: true,
      sessionId: manifest.sessionId,
      childSessionId: manifest.childSessionId,
    });

    return {
      snapshotId: manifest.id,
      worktreeId: registered.id,
      worktreePath: realTarget,
      branch: restoredBranch,
      headSha: manifest.headSha,
      appliedPatch: appliedStagedPatch || appliedWorkingPatch,
      appliedStagedPatch,
      appliedWorkingPatch,
      restoredUntrackedCount: manifest.untrackedFiles.length + manifest.untrackedSymlinks.length,
    };
  } catch (cause) {
    // 还原中途失败时清理刚建出的半成品，快照保持完好以便重试
    await gitExec(mainRepoReal, ["worktree", "remove", "--force", realTarget]).catch(
      () => undefined,
    );
    await gitExec(mainRepoReal, ["branch", "-D", restoredBranch]).catch(() => undefined);
    throw cause;
  }
}
