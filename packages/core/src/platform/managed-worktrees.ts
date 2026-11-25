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
  hasWorkingPatch: boolean;
  workingPatchPath?: string | undefined;
  workingPatchSha256?: string | undefined;
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
  metadataPath?: string | undefined;
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

async function gitExec(cwd: string, args: readonly string[], timeout = 30_000): Promise<string> {
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
    map.set(parsed.childSessionId, { ...parsed, metadataPath: parsed.metadataPath ?? metaPath });
  }
  return map;
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
  const headSha = (await gitExec(worktreePath, ["rev-parse", "--verify", "HEAD"])).trim();
  const abbrev = (
    await gitExec(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
  ).trim();
  const branch = abbrev && abbrev !== "HEAD" ? abbrev : fallbackBranch;
  const statusPorcelain = await gitExec(worktreePath, ["status", "--porcelain"]);
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
  return { branch, headSha, baseSha, aheadCount, dirty };
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildRestoreSteps(snapshot: {
  repository: string;
  originalPath: string;
  branch: string;
  headSha: string;
  hasBundle: boolean;
  bundlePath?: string | undefined;
  hasWorkingPatch: boolean;
  workingPatchPath?: string | undefined;
  untrackedFiles: readonly { path: string }[];
  snapshotDir: string;
}): string[] {
  const steps: string[] = [];
  if (snapshot.hasBundle && snapshot.bundlePath) {
    steps.push(`git -C "${snapshot.repository}" fetch "${snapshot.bundlePath}" HEAD`);
  }
  steps.push(
    `git -C "${snapshot.repository}" worktree add -b "${snapshot.branch}" "${snapshot.originalPath}" ${snapshot.headSha}`,
  );
  if (snapshot.hasWorkingPatch && snapshot.workingPatchPath) {
    steps.push(`git -C "${snapshot.originalPath}" apply --binary "${snapshot.workingPatchPath}"`);
  }
  if (snapshot.untrackedFiles.length > 0) {
    steps.push(
      `Copy untracked files from "${path.join(snapshot.snapshotDir, "untracked")}" into "${snapshot.originalPath}"`,
    );
  }
  return steps;
}

/**
 * 删除前保存并机械校验可恢复快照：
 * - 独有提交通过 git bundle 保存并用 `git bundle verify` 核验可完整取回；
 * - 未提交已跟踪改动通过 `git diff --binary HEAD` 保存并校验 SHA-256；
 * - 未跟踪文件逐个复制并双向校验大小与 SHA-256（符号链接记录目标）；
 * - 任一步失败即清理临时目录并抛错，调用方必须跳过删除并保留原工作树。
 */
async function createVerifiedRecoverySnapshot(input: {
  sessionsDir: string;
  reason: "auto" | "manual";
  entry: ManagedWorktreeRegistryEntry;
  live: LiveGitStatus;
  sourceTitle?: string | undefined;
}): Promise<PlatformWorktreeRecoverySnapshot> {
  const { sessionsDir, reason, entry, live } = input;
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
        await gitExec(entry.repository, ["merge-base", "--is-ancestor", live.headSha, "HEAD"]);
      } catch {
        needBundle = true;
      }
    }
    if (needBundle) {
      const bundleArgs =
        live.baseSha && live.baseSha !== live.headSha
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

    // 捕获所有已跟踪的未提交改动（含暂存区与工作区、含二进制改动）
    let hasWorkingPatch = false;
    let workingPatchPathFinal: string | undefined;
    let workingPatchSha256: string | undefined;
    const trackedDirtyNames = (
      await gitExec(entry.worktreePath, ["diff", "--name-only", "HEAD"])
    ).trim();
    if (trackedDirtyNames.length > 0) {
      const patchBuf = await gitExecBuffer(entry.worktreePath, ["diff", "--binary", "HEAD"]);
      if (patchBuf.length === 0) {
        throw new Error("恢复快照 working.patch 校验失败：检测到已跟踪改动但补丁为空");
      }
      const patchTmp = path.join(tmpDir, "working.patch");
      await writeFile(patchTmp, patchBuf);
      const written = await readFile(patchTmp);
      const expectedHash = sha256Buffer(patchBuf);
      const actualHash = sha256Buffer(written);
      if (actualHash !== expectedHash || written.length !== patchBuf.length) {
        throw new Error("恢复快照 working.patch 写入校验不一致");
      }
      hasWorkingPatch = true;
      workingPatchPathFinal = path.join(finalDir, "working.patch");
      workingPatchSha256 = expectedHash;
    }

    // 捕获所有未跟踪且未被忽略的文件，逐个做大小与 SHA-256 校验
    const untrackedRaw = await gitExec(entry.worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const untrackedList = untrackedRaw.split("\0").filter(Boolean);
    const untrackedFiles: { path: string; sha256: string; size: number }[] = [];
    const untrackedSymlinks: { path: string; target: string }[] = [];
    const untrackedTmpRoot = path.join(tmpDir, "untracked");

    for (const rel of untrackedList) {
      if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
        throw new Error(`不安全的未跟踪文件路径：${rel}`);
      }
      const src = path.resolve(entry.worktreePath, rel);
      const srcStat = await lstat(src);
      if (srcStat.isSymbolicLink()) {
        const target = await readlink(src);
        untrackedSymlinks.push({ path: rel, target });
        continue;
      }
      if (!srcStat.isFile()) {
        throw new Error(`无法为非常规未跟踪条目创建恢复快照：${rel}`);
      }
      const dst = path.resolve(untrackedTmpRoot, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      const srcBuf = await readFile(src);
      await copyFile(src, dst);
      const dstBuf = await readFile(dst);
      const srcHash = sha256Buffer(srcBuf);
      const dstHash = sha256Buffer(dstBuf);
      if (srcHash !== dstHash || srcBuf.length !== dstBuf.length) {
        throw new Error(`未跟踪文件快照校验失败：${rel}`);
      }
      untrackedFiles.push({ path: rel, sha256: srcHash, size: srcBuf.length });
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
      branch: live.branch,
      ownsBranch: entry.ownsBranch,
      headSha: live.headSha,
      ...(live.baseSha ? { baseSha: live.baseSha } : {}),
      sessionId: entry.sessionId,
      ...(entry.childSessionId !== undefined ? { childSessionId: entry.childSessionId } : {}),
      ...(input.sourceTitle !== undefined ? { sourceTitle: input.sourceTitle } : {}),
      aheadCount: live.aheadCount,
      dirty: live.dirty,
      hasBundle,
      ...(bundlePathFinal !== undefined ? { bundlePath: bundlePathFinal } : {}),
      hasWorkingPatch,
      ...(workingPatchPathFinal !== undefined ? { workingPatchPath: workingPatchPathFinal } : {}),
      ...(workingPatchSha256 !== undefined ? { workingPatchSha256 } : {}),
      untrackedFiles,
      untrackedSymlinks,
      snapshotDir: finalDir,
      restoreSteps: buildRestoreSteps({
        repository: entry.repository,
        originalPath: entry.worktreePath,
        branch: live.branch,
        headSha: live.headSha,
        hasBundle,
        bundlePath: bundlePathFinal,
        hasWorkingPatch,
        workingPatchPath: workingPatchPathFinal,
        untrackedFiles,
        snapshotDir: finalDir,
      }),
    };

    const manifestTmp = path.join(tmpDir, "manifest.json");
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    // 二次读回核验 manifest JSON 完整可解析
    const verifyManifest = JSON.parse(
      await readFile(manifestTmp, "utf8"),
    ) as PlatformWorktreeRecoverySnapshot;
    if (verifyManifest.id !== snapshotId || verifyManifest.headSha !== live.headSha) {
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
 * 4. 删除前保存并核验恢复快照（自动删除恒保存，手动删除在有独有提交/本地改动或显式要求时保存）；
 *    快照不能完整保存时跳过删除并保留原件。
 */
export async function deleteManagedWorktrees(
  sessionsDir: string,
  inspector: ManagedWorktreeInspector,
  input: {
    ids: readonly string[];
    reason: "auto" | "manual";
    saveSnapshot?: boolean | undefined;
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

        const legacy = entry.childSessionId ? legacyByChildId.get(entry.childSessionId) : undefined;
        let live: LiveGitStatus;
        try {
          live = await inspectWorktreeLiveGit(
            mainRepoReal,
            wtReal,
            wtListed.branch ?? entry.branch,
            legacy,
          );
        } catch (cause) {
          return {
            id,
            branch: entry.branch,
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

        try {
          try {
            await gitExec(mainRepoReal, ["worktree", "remove", "--force", wtReal]);
          } catch {
            await rm(wtReal, { recursive: true, force: true });
            await gitExec(mainRepoReal, ["worktree", "prune"]);
          }
          let removedBranch = false;
          if (entry.ownsBranch && live.branch) {
            try {
              await gitExec(mainRepoReal, ["branch", "-D", live.branch]);
              removedBranch = true;
            } catch (cause) {
              const refOut = await gitExec(mainRepoReal, [
                "for-each-ref",
                "--format=%(refname)",
                `refs/heads/${live.branch}`,
              ]).catch(() => {
                throw cause;
              });
              if (refOut.trim() !== "") throw cause;
            }
          }
          if (legacy?.metadataPath) {
            await rm(legacy.metadataPath, { force: true }).catch(() => undefined);
          }
          await rm(`${wtReal}.json`, { force: true }).catch(() => undefined);
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

  // 2. 校验 patch 与 untracked 文件完整性
  let patchBuf: Buffer | undefined;
  if (manifest.hasWorkingPatch) {
    const patchFile = path.join(snapDir, "working.patch");
    patchBuf = await readFile(patchFile);
    if (manifest.workingPatchSha256 && sha256Buffer(patchBuf) !== manifest.workingPatchSha256) {
      throw new Error("恢复快照补丁校验失败，文件已损坏");
    }
  }
  for (const file of manifest.untrackedFiles) {
    const stored = path.join(snapDir, "untracked", file.path);
    const data = await readFile(stored);
    if (sha256Buffer(data) !== file.sha256) {
      throw new Error(`恢复快照未跟踪文件校验失败：${file.path}`);
    }
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
  let appliedPatch = false;
  try {
    // 4. 应用未提交已跟踪改动
    if (manifest.hasWorkingPatch && patchBuf !== undefined) {
      const patchFile = path.join(snapDir, "working.patch");
      await gitExec(realTarget, ["apply", "--binary", patchFile]);
      appliedPatch = true;
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
      appliedPatch,
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
