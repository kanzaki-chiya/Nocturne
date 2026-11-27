/**
 * 外部 worker 持久化登记（ADR-0127 第五阶段）。
 *
 * 设计要点：
 * - 一个 worker 一份 JSON 文件 `<NOCTURNE_HOME>/external-workers/<workerId>.json`，
 *   原子写入（写临时文件 + rename）；文件损坏按不存在处理（返回 undefined 并记录诊断）。
 * - worker 记录什么：归属 agent 名、外部 ACP 会话 id、工作树（cwd 绝对路径）、
 *   provider 身份摘要（`providerDigest`，见下）、`loadSession` 能力（来自 initialize
 *   回报）、agent 自报名与版本（诊断用）、创建/最近使用时间。不记录任何凭据、
 *   env 实值、启动参数原值、configOptions 原值或宿主注入的工具列表——
 *   恢复与身份校验只需要摘要，最小化持久化（返工第 2 条）。
 * - provider 变更识别（返工）：`providerDigest` 是 command/args/env 键名/mode/
 *   configOptions 结构归一化后的 sha256 摘要。同名 agent 的启动目标（command/args）
 *   改变时摘要不匹配，续派在披露外部会话 ID 或注入 MCP 之前拒绝（worker_mismatch）。
 *   摘要按结构哈希、不含任何 env 值；启动参数与 configOptions 的原值不落盘——
 *   它们可能含路径或凭据片段，身份核对用单向摘要即可完成，落盘既不必要也泄露。
 *   缺失摘要的历史记录（formatVersion 1 早期）按"不可验证"处理：读取时
 *   `providerDigest` 为 undefined，续派拒绝并说明需重建，
 *   不以宽松匹配放行（文档 subagent.md 第 17 节与此行为一致）。
 * - 跨重启语义：进程 id 与存活状态不入档——每次续派调用方重新起进程，
 *   凭 `externalSessionId` 与 `loadSession` 能力决定走 `session/load` 还是
 *   视为不可恢复。只支持一次性运行的 agent 不创建 worker
 *   （`loadSessionCapable: false` 时仅本次调用返回结果，不持久化，续派按
 *   既有一次性语义重新启动）。
 * - 归属校验：worker 续派只匹配同一 agent 名（不区分大小写）与同一工作树
 *   （按平台路径语义比较）；二者不匹配即返回 `worker_mismatch` 错误，不静默重建。
 */
import { createHash, randomBytes } from "node:crypto";
import { fsErrorCode, type FileSystem, type PathOps } from "../platform/index.js";

export const EXTERNAL_WORKER_FORMAT_VERSION = 1;

/** worker 持久化记录（磁盘格式）。 */
export interface ExternalWorkerRecord {
  formatVersion: number;
  workerId: string;
  /** 创建时的 agent 名（配置名，不区分大小写匹配） */
  agentName: string;
  /** 外部 ACP 会话 id（session/new 的返回值） */
  externalSessionId: string;
  /** 创建时的工作树（绝对路径，按平台 canonicalize 前的原文） */
  cwd: string;
  /**
   * provider 身份摘要（sha256 hex）：创建时 command/args/envKeys/mode/configOptions
   * 结构归一化后的单向哈希，用于续派前识别同名 agent 的启动目标变更。
   * undefined = 历史记录（早期 formatVersion 1）缺失摘要，续派按不可验证拒绝。
   */
  providerDigest?: string | undefined;
  /**
   * provider 启动身份的最小化快照（返工第 2 条）：只保留 command 与 env 键名
   * （快照而非引用，配置改写后已登记的 worker 仍按创建时的命令恢复）。
   * args 与 configOptions 的原值不持久化——它们可能含敏感路径、token 或凭据片段，
   * 身份校验由 providerDigest 完成，恢复只需要 command 与外部会话 ID。
   * env 键名按创建时快照保留（值永不持久化）。
   */
  providerSnapshot: {
    command: string;
    envKeys: string[];
  };
  /** initialize 回报的 loadSession 能力 */
  loadSessionCapable: boolean;
  /** agent 自报名（initialize.agentInfo.name）与版本（诊断用） */
  agentReportedName?: string | undefined;
  agentVersion?: string | undefined;
  createdAt: string;
  lastUsedAt: string;
}

export interface ExternalWorkerStore {
  /** 按 id 读取；不存在/损坏/格式不符返回 undefined */
  read(workerId: string): Promise<ExternalWorkerRecord | undefined>;
  /** 写入新 worker；workerId 由调用方生成（createWorkerId） */
  write(record: ExternalWorkerRecord): Promise<void>;
  /** 更新 lastUsedAt（其他字段不允许改） */
  touch(workerId: string, at: string): Promise<void>;
  /** 删除 worker；不存在不报错 */
  remove(workerId: string): Promise<void>;
  /** 列出全部 worker id（诊断/调试用；损坏文件跳过） */
  list(): Promise<string[]>;
}

export function createWorkerId(): string {
  return `ew-${randomBytes(8).toString("hex")}`;
}

const WORKER_ID_RE = /^ew-[0-9a-f]{16}$/;

export function isWorkerId(value: string): boolean {
  return WORKER_ID_RE.test(value);
}

/**
 * provider 身份输入（计算摘要用的最小归一化结构）。
 * env 只取键名排序、不取值；configOptions 键排序后按序拼接。
 */
export interface ProviderIdentityInput {
  command: string;
  args: readonly string[];
  envKeys: readonly string[];
  mode?: string | undefined;
  configOptions?: Record<string, string> | undefined;
}

/**
 * 计算 provider 身份摘要。结构归一化（envKeys 与 configOptions 键排序、
 * 字段定界明确）后 sha256；单向、不含任何 env 值，可安全落盘与比对。
 */
export function computeProviderDigest(identity: ProviderIdentityInput): string {
  const normalized = {
    command: identity.command,
    args: [...identity.args],
    envKeys: [...identity.envKeys].sort(),
    mode: identity.mode ?? null,
    configOptions:
      identity.configOptions === undefined
        ? null
        : Object.keys(identity.configOptions)
            .sort()
            .map((key) => [key, identity.configOptions?.[key] ?? ""]),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

interface StoreDeps {
  fs: FileSystem;
  paths: PathOps;
  dir: string;
  onCorrupt?: ((workerId: string, reason: string) => void) | undefined;
}

function workerFilePath(paths: PathOps, dir: string, workerId: string): string {
  return paths.join(dir, `${workerId}.json`);
}

function isRecordShape(value: unknown): value is ExternalWorkerRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Partial<ExternalWorkerRecord>;
  if (rec.formatVersion !== EXTERNAL_WORKER_FORMAT_VERSION) return false;
  if (typeof rec.workerId !== "string" || !isWorkerId(rec.workerId)) return false;
  if (typeof rec.agentName !== "string" || rec.agentName.length === 0) return false;
  if (typeof rec.externalSessionId !== "string" || rec.externalSessionId.length === 0) return false;
  if (typeof rec.cwd !== "string" || rec.cwd.length === 0) return false;
  if (typeof rec.loadSessionCapable !== "boolean") return false;
  if (typeof rec.createdAt !== "string" || typeof rec.lastUsedAt !== "string") return false;
  const snap = rec.providerSnapshot as { command?: unknown; envKeys?: unknown } | null | undefined;
  if (typeof snap !== "object" || snap === null) return false;
  if (typeof snap.command !== "string") return false;
  if (!Array.isArray(snap.envKeys)) return false;
  // providerDigest 缺失（历史记录）不视为损坏——作为可识别的"不可验证"状态保留；
  // 但若存在必须是字符串形状。
  const digest = (rec as { providerDigest?: unknown }).providerDigest;
  if (digest !== undefined && typeof digest !== "string") return false;
  return true;
}

export function createExternalWorkerStore(deps: StoreDeps): ExternalWorkerStore {
  const { fs, paths, dir, onCorrupt } = deps;

  const writeAtomic = async (target: string, body: string): Promise<void> => {
    await fs.mkdir(dir, { mode: 0o700 });
    const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, target);
  };

  const readImpl = async (workerId: string): Promise<ExternalWorkerRecord | undefined> => {
    if (!isWorkerId(workerId)) return undefined;
    const file = workerFilePath(paths, dir, workerId);
    let text: string;
    try {
      text = await fs.readTextFile(file);
    } catch (e) {
      if (fsErrorCode(e) === "ENOENT") return undefined;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      onCorrupt?.(workerId, "json_parse_failed");
      return undefined;
    }
    if (!isRecordShape(parsed)) {
      onCorrupt?.(workerId, "shape_invalid");
      return undefined;
    }
    return parsed;
  };

  return {
    read: readImpl,
    async write(record) {
      if (!isRecordShape(record)) throw new Error("invalid worker record shape");
      await writeAtomic(
        workerFilePath(paths, dir, record.workerId),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    },
    async touch(workerId, at) {
      const existing = await readImpl(workerId);
      if (existing === undefined) return;
      await writeAtomic(
        workerFilePath(paths, dir, workerId),
        `${JSON.stringify({ ...existing, lastUsedAt: at }, null, 2)}\n`,
      );
    },
    async remove(workerId) {
      if (!isWorkerId(workerId)) return;
      try {
        await fs.unlink(workerFilePath(paths, dir, workerId));
      } catch (e) {
        if (fsErrorCode(e) === "ENOENT") return;
        throw e;
      }
    },
    async list() {
      let entries;
      try {
        entries = await fs.readdir(dir);
      } catch (e) {
        if (fsErrorCode(e) === "ENOENT") return [];
        throw e;
      }
      const ids: string[] = [];
      for (const entry of entries) {
        if (entry.type !== "file") continue;
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -".json".length);
        if (isWorkerId(id)) ids.push(id);
      }
      return ids;
    },
  };
}
