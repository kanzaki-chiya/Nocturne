/**
 * `schedule` 工具（ADR-0064 第 7 节）：让用户在对话里说「每天 9 点做 X」即可创建定时任务。
 * 读写经 ToolContext.schedule 注入的能力完成，tools 不依赖 schedule 模块；
 * 声明 mutatesSchedule，定时任务发起的会话与子代理按该特性排除它。
 */
import {
  describeSchedulePlan,
  SCHEDULE_DAYS,
  SCHEDULE_MIN_INTERVAL_MINUTES,
  type ReasoningEffort,
  type ScheduledTask,
  type ScheduleSaveInput,
  type SchedulePlan,
  type ScheduleTaskOverview,
  type SubjectRequest,
} from "../../protocol/index.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const ACTIONS = ["list", "create", "update", "pause", "delete"] as const;
type ScheduleAction = (typeof ACTIONS)[number];

const OFFLINE_NOTE = "定时任务只在桌面端打开时运行；当前进程没有运行调度器，任务不会自动触发。";
const MAX_NAME_CHARS = 80;

export interface ScheduleToolInput {
  action: ScheduleAction;
  id?: string | undefined;
  name?: string | undefined;
  prompt?: string | undefined;
  workspace?: string | null | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  permissionPreset?: string | undefined;
  schedule?: SchedulePlan | undefined;
  enabled?: boolean | undefined;
  maxDurationMinutes?: number | undefined;
}

/** create/update 才有意义的任务字段（pause、delete、list 不接受） */
const TASK_FIELDS = [
  "name",
  "prompt",
  "workspace",
  "model",
  "reasoningEffort",
  "permissionPreset",
  "schedule",
  "enabled",
  "maxDurationMinutes",
] as const satisfies readonly (keyof ScheduleToolInput)[];

type ScheduleToolOutput =
  | { action: "list"; tasks: ScheduleTaskOverview[]; schedulerRunning: boolean }
  | { action: "create" | "update" | "pause"; task: ScheduleTaskOverview; schedulerRunning: boolean }
  | { action: "delete"; id: string };

function present(input: ScheduleToolInput, key: keyof ScheduleToolInput): boolean {
  return input[key] !== undefined;
}

function nameProblem(name: unknown): string | undefined {
  if (typeof name !== "string") return "name 必须是字符串";
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    Array.from(trimmed).length > MAX_NAME_CHARS ||
    /[\u0000-\u001f]/.test(trimmed)
  )
    return `name 必填，不超过 ${MAX_NAME_CHARS} 个字符，不含换行`;
  return undefined;
}

function validate(input: ScheduleToolInput): string | undefined {
  switch (input.action) {
    case "list": {
      if (input.id !== undefined || TASK_FIELDS.some((k) => present(input, k)))
        return "list 不接受其他参数";
      return undefined;
    }
    case "create": {
      if (input.id !== undefined) return "create 不带 id（id 由系统分配）；要修改已有任务用 update";
      const problem = nameProblem(input.name);
      if (problem !== undefined) return problem;
      if (typeof input.prompt !== "string" || input.prompt.trim() === "")
        return "create 必须提供 prompt（每次运行的完整指令）";
      if (input.schedule === undefined) return "create 必须提供 schedule（运行计划）";
      return undefined;
    }
    case "update": {
      if (input.id === undefined || input.id.trim() === "")
        return "update 必须提供 id（先用 list 查到任务 id）";
      if (!TASK_FIELDS.some((k) => present(input, k))) return "update 至少要提供一个要修改的字段";
      if (input.name !== undefined) return nameProblem(input.name);
      return undefined;
    }
    case "pause":
    case "delete": {
      if (input.id === undefined || input.id.trim() === "")
        return `${input.action} 必须提供 id（先用 list 查到任务 id）`;
      if (TASK_FIELDS.some((k) => present(input, k))) return `${input.action} 只需要 id`;
      return undefined;
    }
  }
}

function fieldLines(input: ScheduleToolInput, defaults: boolean): string[] {
  const lines: string[] = [];
  if (input.name !== undefined) lines.push(`名称：${input.name.trim()}`);
  if (input.schedule !== undefined) lines.push(`计划：${describeSchedulePlan(input.schedule)}`);
  if (defaults || input.workspace !== undefined)
    lines.push(`工作区：${input.workspace ?? "普通对话"}`);
  if (
    defaults ||
    input.model !== undefined ||
    input.reasoningEffort !== undefined ||
    input.permissionPreset !== undefined
  ) {
    lines.push(
      `模型 · 档位 · 权限：${[input.model, input.reasoningEffort, input.permissionPreset]
        .map((v) => v ?? "默认")
        .join(" · ")}`,
    );
  }
  if (defaults || input.maxDurationMinutes !== undefined)
    lines.push(`时长上限：${input.maxDurationMinutes ?? 60} 分钟`);
  if (input.enabled === false) lines.push("状态：已暂停");
  else if (input.enabled === true && !defaults) lines.push("状态：启用");
  if (input.prompt !== undefined) lines.push("指令：", input.prompt.trim());
  return lines;
}

/**
 * 确认卡片展示的多行纯文本（PermissionSubject.detail，仅供阅读，不参与规则或授权）：
 * 创建时列出任务的全部字段与完整指令；修改只列出要改的字段。
 */
export function scheduleSubjectDetail(input: ScheduleToolInput): string {
  switch (input.action) {
    case "create":
      return ["新建定时任务", ...fieldLines(input, true)].join("\n");
    case "update":
      return [
        `修改定时任务 ${input.id ?? ""}（以下字段将被改写）`,
        ...fieldLines(input, false),
      ].join("\n");
    case "pause":
      return `暂停定时任务 ${input.id ?? ""}`;
    case "delete":
      return `删除定时任务 ${input.id ?? ""}（运行历史一并删除，已产生的会话保留）`;
    case "list":
      return "";
  }
}

function fail(code: string, message: string): ToolResult<ScheduleToolOutput> {
  return { status: "error", modelContent: message, error: { code, message } };
}

/** ScheduleError（带 field）按鸭子类型识别：tools 不依赖 schedule 模块 */
function fieldError(e: unknown): { field: string; message: string } | undefined {
  if (!(e instanceof Error)) return undefined;
  const field = (e as { field?: unknown }).field;
  return typeof field === "string" ? { field, message: e.message } : undefined;
}

function summarize(task: ScheduleTaskOverview): string {
  const parts = [
    `${task.id}｜${task.name}｜${describeSchedulePlan(task.schedule)}`,
    task.enabled ? "启用" : "已暂停",
    task.workspace ?? "普通对话",
  ];
  if (task.nextRunAt !== undefined) parts.push(`下次 ${task.nextRunAt}`);
  if (task.lastRun !== undefined) parts.push(`上次 ${task.lastRun.result}`);
  if (task.running) parts.push("运行中");
  return parts.join("｜");
}

function toSaveInput(task: ScheduledTask): ScheduleSaveInput {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    workspace: task.workspace,
    ...(task.model !== undefined ? { model: task.model } : {}),
    ...(task.reasoningEffort !== undefined ? { reasoningEffort: task.reasoningEffort } : {}),
    ...(task.permissionPreset !== undefined ? { permissionPreset: task.permissionPreset } : {}),
    schedule: task.schedule,
    enabled: task.enabled,
    maxDurationMinutes: task.maxDurationMinutes,
  };
}

function patchOf(input: ScheduleToolInput): Partial<ScheduleSaveInput> {
  const patch: Partial<ScheduleSaveInput> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.workspace !== undefined) patch.workspace = input.workspace;
  if (input.model !== undefined) patch.model = input.model;
  if (input.reasoningEffort !== undefined) patch.reasoningEffort = input.reasoningEffort;
  if (input.permissionPreset !== undefined) patch.permissionPreset = input.permissionPreset;
  if (input.schedule !== undefined) patch.schedule = input.schedule;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.maxDurationMinutes !== undefined) patch.maxDurationMinutes = input.maxDurationMinutes;
  return patch;
}

export const scheduleTool: ToolDefinition<ScheduleToolInput, ScheduleToolOutput> = {
  name: "schedule",
  description: [
    "管理定时任务：按计划自动运行一段指令。动作：list（列出全部任务及 id）、create（新建）、update（按 id 修改，只传要改的字段；用 enabled: true 恢复）、pause（按 id 暂停）、delete（按 id 删除，运行历史一并删除）。update、pause、delete 前先 list 取得 id。",
    "重要：每次运行都在一个全新的会话里进行，看不到当前这段对话。运行所需的全部背景（关注的目录或仓库、输出格式、判断标准、写到哪里）都必须写进 prompt，不要写「按刚才说的做」。",
    "运行时无人值守：需要用户确认的操作会被直接拒绝，不会等待。要让任务能完成，选择合适的 permissionPreset（例如只读汇总用 read-only，需要写工作区文件用 auto-edit），并让 prompt 只做该预设允许的事。",
    `schedule 是对象：{type:"interval",minutes}（不少于 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟）、{type:"hourly"}、{type:"daily",time:"09:00"}、{type:"weekdays",time}、{type:"weekly",day:"mon"…"sun",time}、{type:"manual"}（只手动运行）或 {type:"cron",expr}（五段、本地时区，相邻两次触发不少于 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟）。time 是本地时间 HH:MM。workspace 缺省或 null 为普通对话；model 用 provider/model 形式，缺省用当前默认。`,
    "定时任务只在 Nocturne 桌面端打开时运行；错过的只补最近一次。create、update、pause、delete 需要用户确认。",
  ].join("\n"),
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      id: { type: "string" },
      name: { type: "string" },
      prompt: { type: "string" },
      workspace: { type: ["string", "null"] },
      model: { type: "string" },
      reasoningEffort: { type: "string" },
      permissionPreset: { type: "string" },
      schedule: {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["interval", "hourly", "daily", "weekdays", "weekly", "manual", "cron"],
          },
          minutes: { type: "integer" },
          time: { type: "string" },
          day: { type: "string", enum: [...SCHEDULE_DAYS] },
          expr: { type: "string" },
        },
        additionalProperties: false,
      },
      enabled: { type: "boolean" },
      maxDurationMinutes: { type: "integer" },
    },
    additionalProperties: false,
  },
  // 不改工作区文件（写的是 Nocturne 自己的 schedules.json），回退与未追踪统计不计入
  traits: {
    mutates: true,
    fileEffects: "none",
    concurrencySafe: false,
    timeoutMs: 15_000,
    mutatesSchedule: true,
  },
  validateInput: validate,
  permissionSubjects(input): SubjectRequest[] {
    if (input.action === "list") return [];
    // update/pause/delete 的入参只有 id（权限主体是纯函数，读不到任务名）
    const label = input.action === "create" ? (input.name ?? "").trim() : (input.id ?? "").trim();
    return [
      {
        kind: "schedule",
        target: `${input.action}:${label}`,
        detail: scheduleSubjectDetail(input),
      },
    ];
  },
  async execute(input, ctx) {
    const access = ctx.schedule;
    if (access === undefined) {
      return fail("schedule_unavailable", "当前环境没有提供定时任务能力，无法管理定时任务");
    }
    try {
      const listed = await access.list();
      const note = listed.scheduler.running ? "" : `\n${OFFLINE_NOTE}`;
      if (input.action === "list") {
        const lines =
          listed.tasks.length === 0 ? ["（没有定时任务）"] : listed.tasks.map(summarize);
        return {
          status: "ok",
          modelContent: `${lines.join("\n")}${note}`,
          output: {
            action: "list",
            tasks: listed.tasks,
            schedulerRunning: listed.scheduler.running,
          },
        };
      }
      if (input.action === "create") {
        // validateInput 已保证 name、prompt、schedule 齐全
        const saved = await access.save(patchOf(input) as ScheduleSaveInput);
        return changed("create", saved, listed.scheduler.running, `已创建定时任务`, note);
      }
      const id = (input.id ?? "").trim();
      const existing = listed.tasks.find((t) => t.id === id);
      if (existing === undefined) {
        return fail("not_found", `没有 id 为 ${id} 的定时任务；先用 list 查看现有任务`);
      }
      if (input.action === "delete") {
        await access.remove(id);
        return {
          status: "ok",
          modelContent: `已删除定时任务「${existing.name}」（${id}）及其运行历史；已产生的会话保留。`,
          output: { action: "delete", id },
        };
      }
      const patch = input.action === "pause" ? { enabled: false } : patchOf(input);
      const saved = await access.save({ ...toSaveInput(existing), ...patch, id });
      return changed(
        input.action,
        saved,
        listed.scheduler.running,
        input.action === "pause" ? "已暂停定时任务" : "已修改定时任务",
        note,
      );
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const field = fieldError(e);
      if (field !== undefined) return fail("invalid_input", `${field.field}：${field.message}`);
      throw e;
    }
  },
};

function changed(
  action: "create" | "update" | "pause",
  task: ScheduleTaskOverview,
  schedulerRunning: boolean,
  prefix: string,
  note: string,
): ToolResult<ScheduleToolOutput> {
  return {
    status: "ok",
    modelContent: `${prefix}：${summarize(task)}${note}`,
    output: { action, task, schedulerRunning },
  };
}
