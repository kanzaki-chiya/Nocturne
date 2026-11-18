/**
 * `<NOCTURNE_HOME>/suites/<suiteId>/suite.json` 存储（ADR-0097 §3.2）。
 * 共用 config 写入队列与原子替换。
 */
import { randomBytes } from "node:crypto";
import { enqueueConfigWrite, writeJsonAtomic } from "../config/files.js";
import { fsErrorCode, type Platform } from "../platform/index.js";
import {
  isReasoningEffort,
  type SuiteRecord,
  type SuiteThreadDefaults,
  type UpdateSuiteInput,
} from "../protocol/index.js";

const SUITE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$(?![\s\S])/;

export function isValidSuiteId(id: unknown): id is string {
  return typeof id === "string" && SUITE_ID_RE.test(id) && id !== "." && id !== "..";
}

/** 生成时间有序且合法作为目录名和记忆键的 suiteId */
export function newSuiteId(now = new Date()): string {
  const t = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `suite-${t}-${randomBytes(4).toString("hex")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThreadDefaults(raw: unknown): SuiteThreadDefaults | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: SuiteThreadDefaults = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string") return undefined;
    out.model = raw.model;
  }
  if (raw.reasoningEffort !== undefined) {
    if (typeof raw.reasoningEffort !== "string" || !isReasoningEffort(raw.reasoningEffort)) {
      return undefined;
    }
    out.reasoningEffort = raw.reasoningEffort;
  }
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== "string") return undefined;
    out.preset = raw.preset;
  }
  if (raw.isolated !== undefined) {
    if (typeof raw.isolated !== "boolean") return undefined;
    out.isolated = raw.isolated;
  }
  return out;
}

function parseSuiteRecord(raw: unknown): SuiteRecord | undefined {
  if (!isPlainObject(raw) || raw.version !== 1) return undefined;
  if (!isValidSuiteId(raw.id)) return undefined;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return undefined;
  if (raw.goal !== undefined && typeof raw.goal !== "string") return undefined;
  if (
    !Array.isArray(raw.workspaces) ||
    !raw.workspaces.every((w): w is string => typeof w === "string" && w.length > 0)
  ) {
    return undefined;
  }
  if (typeof raw.instructions !== "string") return undefined;
  if (typeof raw.coordinatorSessionId !== "string" || raw.coordinatorSessionId === "") {
    return undefined;
  }
  const threadDefaults =
    raw.threadDefaults === undefined ? {} : parseThreadDefaults(raw.threadDefaults);
  if (threadDefaults === undefined) return undefined;
  if (typeof raw.createdAt !== "string" || raw.createdAt === "") return undefined;
  if (raw.archivedAt !== undefined && typeof raw.archivedAt !== "string") return undefined;
  return {
    version: 1,
    id: raw.id,
    name: raw.name,
    ...(raw.goal !== undefined ? { goal: raw.goal } : {}),
    workspaces: [...raw.workspaces],
    instructions: raw.instructions,
    coordinatorSessionId: raw.coordinatorSessionId,
    threadDefaults,
    createdAt: raw.createdAt,
    ...(raw.archivedAt !== undefined ? { archivedAt: raw.archivedAt } : {}),
  };
}

export interface SuiteStore {
  suitesRoot(): string;
  filePath(id: string): string;
  get(id: string): Promise<SuiteRecord | undefined>;
  list(filter?: { includeArchived?: boolean | undefined }): Promise<SuiteRecord[]>;
  save(record: SuiteRecord): Promise<void>;
  update(
    id: string,
    patch: Omit<UpdateSuiteInput, "id"> & { archivedAt?: string | undefined },
  ): Promise<SuiteRecord | undefined>;
}

export function createSuiteStore(platform: Platform, nocturneHome: string): SuiteStore {
  const { fs, paths } = platform;
  const rootDir = paths.join(nocturneHome, "suites");

  function filePath(id: string): string {
    if (!isValidSuiteId(id)) {
      throw new Error(`Invalid suite ID: ${String(id)}`);
    }
    return paths.join(rootDir, id, "suite.json");
  }

  async function readFile(targetPath: string): Promise<SuiteRecord | undefined> {
    if (!(await fs.exists(targetPath))) return undefined;
    try {
      const raw: unknown = JSON.parse(await fs.readTextFile(targetPath));
      return parseSuiteRecord(raw);
    } catch {
      return undefined;
    }
  }

  return {
    suitesRoot: () => rootDir,
    filePath,
    async get(id) {
      if (!isValidSuiteId(id)) return undefined;
      return readFile(filePath(id));
    },
    async list(filter = {}) {
      let entries;
      try {
        entries = await fs.readdir(rootDir);
      } catch (e) {
        if (fsErrorCode(e) === "ENOENT") return [];
        throw e;
      }
      const records: SuiteRecord[] = [];
      for (const entry of entries) {
        if (entry.type !== "directory" || !isValidSuiteId(entry.name)) continue;
        const parsed = await readFile(paths.join(entry.path, "suite.json"));
        if (parsed === undefined) continue;
        if (filter.includeArchived !== true && parsed.archivedAt !== undefined) continue;
        records.push(parsed);
      }
      records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return records;
    },
    async save(record) {
      const target = filePath(record.id);
      await enqueueConfigWrite(fs, async () => {
        await writeJsonAtomic(fs, paths, target, record, { dirMode: 0o700 });
      });
    },
    async update(id, patch) {
      const target = filePath(id);
      return enqueueConfigWrite(fs, async () => {
        const existing = await readFile(target);
        if (existing === undefined) return undefined;
        const next: SuiteRecord = {
          ...existing,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.workspaces !== undefined ? { workspaces: [...patch.workspaces] } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          ...(patch.threadDefaults !== undefined
            ? { threadDefaults: { ...existing.threadDefaults, ...patch.threadDefaults } }
            : {}),
          ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
        };
        if (patch.goal === null) {
          delete next.goal;
        } else if (patch.goal !== undefined) {
          next.goal = patch.goal;
        }
        await writeJsonAtomic(fs, paths, target, next, { dirMode: 0o700 });
        return next;
      });
    },
  };
}
