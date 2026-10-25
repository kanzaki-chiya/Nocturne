/**
 * 定时任务的持久化（ADR-0064 第 2、3 节，schedule.md 第 2 节）。
 * - `<NOCTURNE_HOME>/schedules.json`：与 `mcp.json` 同类的程序维护文件——逐条校验、
 *   临时文件 + rename、同进程写入串行、损坏的条目忽略并警告；
 * - `<NOCTURNE_HOME>/schedules/history/<taskId>.jsonl`：每任务一份运行历史，保留最近 200 条。
 */
import { randomUUID } from "node:crypto";

import type { Platform } from "../platform/index.js";
import {
  isReasoningEffort,
  normalizePermissionPreset,
  PERMISSION_PRESET_NAMES,
  SCHEDULE_DEFAULT_MAX_DURATION_MINUTES,
  SCHEDULE_HISTORY_LIMIT,
  type ScheduleHistoryEntry,
  type SchedulePlan,
  type ScheduleSaveInput,
  type ScheduledTask,
} from "../protocol/index.js";
import { enqueueConfigWrite, writeJsonAtomic } from "../config/files.js";
import { ScheduleError, validatePlan } from "./plan.js";
import { createZone, type Zone } from "./zone.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_TASKS = 100;
const MAX_NAME_CHARS = 80;
const MAX_PROMPT_CHARS = 20_000;
const MAX_DURATION_MINUTES = 1440;
/** 历史文件超过这么多行就压实一次（折叠同一次触发的多行并丢弃最旧的） */
const COMPACT_AFTER_LINES = SCHEDULE_HISTORY_LIMIT * 2;

/** 文件里的条目：任务字段 + 两个内部记账时刻 */
export interface StoredTask extends ScheduledTask {
  createdAt: string;
  /**
   * 计划的起算时刻：创建、改计划、从暂停恢复时重置。`interval` 以它为起点按间隔推算，
   * 其他计划把它当作「在此之前的计划时间不算错过」。
   */
  anchorAt: string;
}

export interface ScheduleStoreDeps {
  platform: Platform;
  /** NOCTURNE_HOME */
  home: string;
  /** 时区；缺省取系统时区（cron 校验用） */
  zone?: Zone | undefined;
  now?: (() => number) | undefined;
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePlan(a: SchedulePlan, b: SchedulePlan): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createScheduleStore(deps: ScheduleStoreDeps) {
  const { platform, home } = deps;
  const { fs, paths } = platform;
  const zone = deps.zone ?? createZone();
  const clock = deps.now ?? Date.now;
  const filePath = paths.join(home, "schedules.json");
  const historyDir = paths.join(home, "schedules", "history");
  const historyFile = (taskId: string): string => paths.join(historyDir, `${taskId}.jsonl`);

  let tasks: StoredTask[] = [];
  const warnings: string[] = [];
  let corrupt = false;
  let loading: Promise<void> | undefined;

  let pending: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = pending.then(() => enqueueConfigWrite(fs, task));
    pending = run.catch(() => undefined);
    return run;
  }

  /** 校验任务字段（新建、编辑与读文件共用）；返回规范化后的任务 */
  async function normalize(
    raw: Record<string, unknown>,
    id: string,
    options: { checkWorkspace: boolean },
  ): Promise<ScheduledTask> {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name === "" || Array.from(name).length > MAX_NAME_CHARS || /[\u0000-\u001f]/.test(name))
      throw new ScheduleError("name", `名称必填，不超过 ${MAX_NAME_CHARS} 个字符，不含换行`);
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (prompt === "") throw new ScheduleError("prompt", "指令必填");
    if (Array.from(prompt).length > MAX_PROMPT_CHARS)
      throw new ScheduleError("prompt", `指令不超过 ${MAX_PROMPT_CHARS} 个字符`);

    let workspace: string | null = null;
    if (raw.workspace !== undefined && raw.workspace !== null) {
      if (
        typeof raw.workspace !== "string" ||
        raw.workspace === "" ||
        raw.workspace.length > 1024 ||
        !paths.isAbsolute(raw.workspace)
      )
        throw new ScheduleError("workspace", "工作区必须是绝对路径，或留空使用普通对话");
      workspace = paths.resolve(raw.workspace, ".");
      if (options.checkWorkspace) {
        const stat = await fs.stat(workspace).catch(() => undefined);
        if (stat?.type !== "directory")
          throw new ScheduleError("workspace", `工作区不存在或不是目录：${workspace}`);
      }
    }

    let model: string | undefined;
    if (raw.model !== undefined) {
      if (typeof raw.model !== "string" || !/^[^/\s]+\/\S+$/.test(raw.model))
        throw new ScheduleError("model", '模型必须是 "provider/model" 形式');
      model = raw.model;
    }
    let reasoningEffort: ScheduledTask["reasoningEffort"];
    if (raw.reasoningEffort !== undefined) {
      if (typeof raw.reasoningEffort !== "string" || !isReasoningEffort(raw.reasoningEffort))
        throw new ScheduleError("reasoningEffort", "思考档位无效");
      reasoningEffort = raw.reasoningEffort;
    }
    let permissionPreset: string | undefined;
    if (raw.permissionPreset !== undefined) {
      const preset =
        typeof raw.permissionPreset === "string"
          ? normalizePermissionPreset(raw.permissionPreset)
          : "";
      if (!(PERMISSION_PRESET_NAMES as readonly string[]).includes(preset))
        throw new ScheduleError(
          "permissionPreset",
          `权限预设必须是 ${PERMISSION_PRESET_NAMES.join(" | ")} 之一`,
        );
      permissionPreset = preset;
    }

    let enabled = true;
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean")
        throw new ScheduleError("enabled", "启用状态必须是布尔值");
      enabled = raw.enabled;
    }
    let maxDurationMinutes = SCHEDULE_DEFAULT_MAX_DURATION_MINUTES;
    if (raw.maxDurationMinutes !== undefined) {
      const m = raw.maxDurationMinutes;
      if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > MAX_DURATION_MINUTES)
        throw new ScheduleError(
          "maxDurationMinutes",
          `时长上限必须是 1–${MAX_DURATION_MINUTES} 的整数分钟`,
        );
      maxDurationMinutes = m;
    }
    const schedule = validatePlan(raw.schedule, { zone, now: clock() });
    return {
      id,
      name,
      prompt,
      workspace,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(permissionPreset !== undefined ? { permissionPreset } : {}),
      schedule,
      enabled,
      maxDurationMinutes,
    };
  }

  async function writeTasks(next: StoredTask[]): Promise<void> {
    if (corrupt) {
      // 损坏的旧文件先留一份副本，免得这次写入把它覆盖掉
      const backup = `${filePath}.corrupt-${new Date(clock()).toISOString().replace(/[:.]/g, "-")}`;
      await fs.rename(filePath, backup).catch(() => undefined);
      corrupt = false;
    }
    await writeJsonAtomic(fs, paths, filePath, { version: 1, tasks: next }, { dirMode: 0o700 });
    tasks = next;
  }

  async function readFromDisk(): Promise<void> {
    tasks = [];
    warnings.length = 0;
    corrupt = false;
    if (!(await fs.exists(filePath))) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readTextFile(filePath));
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      corrupt = true;
      warnings.push(`schedules_config_invalid：${filePath} 损坏或版本不符，已忽略`);
      return;
    }
    const seen = new Set<string>();
    for (const entry of parsed.tasks as unknown[]) {
      const label = isPlainObject(entry) && typeof entry.id === "string" ? entry.id : "?";
      try {
        if (!isPlainObject(entry) || typeof entry.id !== "string" || !TASK_ID.test(entry.id))
          throw new Error("id");
        if (seen.has(entry.id)) throw new Error("duplicate");
        const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : undefined;
        const anchorAt = typeof entry.anchorAt === "string" ? entry.anchorAt : undefined;
        if (
          createdAt === undefined ||
          anchorAt === undefined ||
          Number.isNaN(Date.parse(createdAt)) ||
          Number.isNaN(Date.parse(anchorAt))
        )
          throw new Error("time");
        // 读文件不检查工作区是否存在：目录可能暂时不在，运行时再报错
        const task = await normalize(entry, entry.id, { checkWorkspace: false });
        seen.add(task.id);
        tasks.push({ ...task, createdAt, anchorAt });
      } catch {
        warnings.push(`schedules_task_invalid：${filePath} 中任务 ${label} 无效，已忽略`);
      }
    }
  }

  function load(): Promise<void> {
    loading = readFromDisk();
    return loading;
  }

  function ensureLoaded(): Promise<void> {
    return (loading ??= readFromDisk());
  }

  // ── 历史 ──

  function parseHistory(text: string): ScheduleHistoryEntry[] {
    const byId = new Map<string, ScheduleHistoryEntry>();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row: unknown = JSON.parse(line);
        if (
          !isPlainObject(row) ||
          typeof row.id !== "string" ||
          typeof row.taskId !== "string" ||
          typeof row.scheduledAt !== "string" ||
          typeof row.result !== "string"
        )
          continue;
        const merged = { ...byId.get(row.id), ...row } as unknown as ScheduleHistoryEntry;
        byId.set(row.id, merged);
      } catch {
        // 半行或坏行：丢弃
      }
    }
    return [...byId.values()];
  }

  async function readRaw(
    taskId: string,
  ): Promise<{ entries: ScheduleHistoryEntry[]; lines: number }> {
    let text: string;
    try {
      text = await fs.readTextFile(historyFile(taskId));
    } catch {
      return { entries: [], lines: 0 };
    }
    return { entries: parseHistory(text), lines: text.split("\n").filter(Boolean).length };
  }

  /** 历史，最新的在前（按原计划时间，同时刻按写入先后） */
  async function history(taskId: string): Promise<ScheduleHistoryEntry[]> {
    const { entries } = await readRaw(taskId);
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          Date.parse(b.entry.scheduledAt) - Date.parse(a.entry.scheduledAt) || b.index - a.index,
      )
      .slice(0, SCHEDULE_HISTORY_LIMIT)
      .map(({ entry }) => entry);
  }

  /**
   * 追加一行。同一次触发可以写多行（开始、拿到会话、结束），读取时按 `id` 合并，
   * 后写的字段覆盖先写的。文件过长时顺带压实。
   */
  function appendHistory(
    taskId: string,
    row: Partial<ScheduleHistoryEntry> & Pick<ScheduleHistoryEntry, "id" | "scheduledAt">,
    options: { requireTask?: boolean } = {},
  ): Promise<void> {
    if (!TASK_ID.test(taskId)) return Promise.reject(new ScheduleError("id", "任务 id 无效"));
    return enqueue(async () => {
      // 任务已被删除就不写：与 remove 在同一个队列里，不会把刚删掉的历史文件又建出来
      if (options.requireTask === true) {
        await ensureLoaded();
        if (!tasks.some((t) => t.id === taskId)) return;
      }
      await fs.mkdir(historyDir, { mode: 0o700 });
      await fs.appendFile(historyFile(taskId), `${JSON.stringify({ ...row, taskId })}\n`);
      const { entries, lines } = await readRaw(taskId);
      if (lines <= COMPACT_AFTER_LINES) return;
      const kept = entries.slice(-SCHEDULE_HISTORY_LIMIT);
      const tmp = `${historyFile(taskId)}.tmp-${randomUUID().slice(0, 8)}`;
      try {
        await fs.writeFile(tmp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
        await fs.rename(tmp, historyFile(taskId));
      } catch {
        await fs.unlink(tmp).catch(() => undefined);
      }
    });
  }

  return {
    warnings,
    path: filePath,
    load,

    async list(): Promise<StoredTask[]> {
      await ensureLoaded();
      return tasks.map((task) => ({ ...task }));
    },

    async get(id: string): Promise<StoredTask | undefined> {
      await ensureLoaded();
      const task = tasks.find((t) => t.id === id);
      return task === undefined ? undefined : { ...task };
    },

    /** 新建（不带 id）或整体替换（带 id）；返回保存后的任务 */
    save(input: ScheduleSaveInput): Promise<StoredTask> {
      return enqueue(async () => {
        await ensureLoaded();
        if (!isPlainObject(input)) throw new ScheduleError("config", "任务必须是对象");
        const now = new Date(clock()).toISOString();
        const existing = input.id === undefined ? undefined : tasks.find((t) => t.id === input.id);
        if (input.id !== undefined && existing === undefined)
          throw new ScheduleError("id", `任务不存在：${input.id}`);
        if (existing === undefined && tasks.length >= MAX_TASKS)
          throw new ScheduleError("config", `最多 ${MAX_TASKS} 个任务`);
        const id = existing?.id ?? `t${randomUUID().replace(/-/g, "").slice(0, 10)}`;
        const task = await normalize(input, id, {
          checkWorkspace: true,
        });
        const restarted =
          existing === undefined ||
          !samePlan(existing.schedule, task.schedule) ||
          (!existing.enabled && task.enabled);
        const stored: StoredTask = {
          ...task,
          createdAt: existing?.createdAt ?? now,
          anchorAt: restarted ? now : existing.anchorAt,
        };
        await writeTasks(
          existing === undefined
            ? [...tasks, stored]
            : tasks.map((t) => (t.id === existing.id ? stored : t)),
        );
        return { ...stored };
      });
    },

    /** 删除任务及其历史；返回是否真的删除了。已有会话不动 */
    remove(id: string): Promise<boolean> {
      return enqueue(async () => {
        await ensureLoaded();
        if (!tasks.some((t) => t.id === id)) return false;
        await writeTasks(tasks.filter((t) => t.id !== id));
        await fs.unlink(historyFile(id)).catch(() => undefined);
        return true;
      });
    },

    history,
    appendHistory,
  };
}
