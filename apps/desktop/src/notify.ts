/**
 * 通知判定（[ADR-0056](../../../docs/decisions/ADR-0056-session-notifications.md)）：纯函数，
 * 输入事件、会话信息与生效设置，输出「不提醒」或一条通知的标题与正文；不碰
 * DOM、不调外壳，全部规则集中在这里便于测试（apps/desktop/test/notify.test.ts）。
 *
 * 三类提醒：
 * - 需要确认：`permission.requested`（含父会话启动 task 的审批）、`question.requested`；
 * - 出错停止：`turn.completed` 且 `reason === "error"`（不看用时）；
 * - 完成：`turn.completed` 的其他非中断结束，用时达到阈值才提醒。
 *
 * 用户自己按的中断（`aborted`，效果图里写「interrupted」）永不提醒；重放、
 * 恢复与打开历史会话读到的事件（`live: false`）永不提醒；「在看」（窗口有
 * 焦点且正显示该会话）时不提醒。
 */
import type {
  PermissionSubject,
  QuestionItem,
  RuntimeEvent,
  SubjectKind,
} from "@nocturne/core/protocol";

import type { SettingItem } from "./rpc-types";
import type { RemoteStatus, RpcClient } from "@nocturne/rpc/client";
import type { SessionMark } from "./session-tree";

export type NotifyKind = "attention" | "error" | "done";

/** 仅在已有桌面通知判定通过的分支调用，不另起提醒规则。 */
export async function pushRemoteNotification(
  client: RpcClient | undefined,
  status: RemoteStatus | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (
    !client ||
    !status?.registered ||
    !status.enabled ||
    status.connection !== "online" ||
    status.connections.length > 0
  )
    return;
  try {
    await client.call("remote.push", {});
  } catch {
    log("[remote] 手机推送失败");
  }
}

/** `settings.json` notifications 段的生效值（缺省见 Core 侧 schema） */
export interface NotifyPrefs {
  enabled: boolean;
  attention: boolean;
  error: boolean;
  done: boolean;
  doneAfterSeconds: number;
  sound: boolean;
}

/** Core 的缺省值：总开关与三类事件全开、阈值 60 秒、提示音开 */
export const NOTIFY_DEFAULTS: NotifyPrefs = {
  enabled: true,
  attention: true,
  error: true,
  done: true,
  doneAfterSeconds: 60,
  sound: true,
};

/** 外壳命令的返回（`notify_show` / 测试通知共用） */
export interface NotifyResult {
  /** 是否真的发出去（Windows 通知权限被关或非 Windows 时为 false） */
  shown: boolean;
  /** `disabled` = 系统关掉了本应用的通知；`unsupported` = 平台不支持；`error` = 调用失败 */
  reason?: "disabled" | "unsupported" | "error" | undefined;
  /** 失败细节（诊断用，不上界面） */
  detail?: string | undefined;
}

/** 会话标题的两个来源：会话视图里的生成标题、列表里的首条用户消息首行 */
export interface NotifySession {
  title?: string | undefined;
  firstText?: string | undefined;
}

export interface NotifyInput {
  event: RuntimeEvent;
  prefs: NotifyPrefs;
  /** 本次运行中实时到达的事件；重放、恢复、读历史都是 false */
  live: boolean;
  /** 在看 = 窗口有焦点且这个会话是当前显示的会话 */
  watching: boolean;
  session: NotifySession;
  /** 当前 Turn 的开始时间（epoch ms）；没有记录时为 undefined（不猜用时） */
  turnStartedAt?: number | undefined;
}

export interface NotifyDecision {
  kind: NotifyKind;
  title: string;
  body: string;
}

/** 单段文字上限：通知正文只有一两行，超出截断（Windows 侧还会再按系统规则截） */
const SEGMENT_LIMIT = 100;

/** 会话标题回退链：会话标题 → 首条用户消息第一行 → Nocturne */
export function sessionTitle(session: NotifySession): string {
  const title = session.title?.trim();
  if (title !== undefined && title !== "") return title;
  return firstLine(session.firstText) ?? "Nocturne";
}

function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
}

/** 超长截断：保留 limit − 1 个字符加一个省略号 */
export function ellipsize(text: string, limit = SEGMENT_LIMIT): string {
  const flat = text.trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * 用时格式：不到 1 分钟写秒，不到 1 小时写分钟（向下取整），
 * 超过 1 小时写「N 小时 M 分钟」（整小时不写分钟）。
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/**
 * subject kind → 中文操作文字（权限卡片与通知真的共用同一函数：
 * `Conversation.tsx` 的权限卡片调这里，通知正文也调这里）。
 * 没有 subject 时用工具名，再没有写「操作」。
 */
export function operationForSubjectKind(kind: SubjectKind | undefined, fallback = "操作"): string {
  switch (kind) {
    case "shell":
      return "执行命令";
    case "edit":
      return "修改文件";
    case "read":
      return "读取文件";
    case "network":
      return "访问网络";
    case "mcp":
      return "调用 MCP 工具";
    case "subagent":
      return "启动子代理";
    default:
      return fallback;
  }
}

/** 旧名别名（notify.test.ts 用）：与 operationForSubjectKind 同一函数 */
export const permissionOperation = operationForSubjectKind;

/** 首个 subject 的目标（权限卡片同款：shell 是命令、路径类是规范化后的路径） */
function subjectTarget(subject: PermissionSubject | undefined): string | undefined {
  if (subject === undefined) return undefined;
  const target = (subject.detail ?? subject.target).trim();
  return target === "" ? undefined : ellipsize(target);
}

/** 出错摘要：取错误信息第一行（Core 的 message 常带换行细节） */
function errorSummary(error: { code: string; message: string } | undefined): string {
  const message = firstLine(error?.message);
  if (message !== undefined) return ellipsize(message);
  const code = error?.code.trim() ?? "";
  return code === "" ? "未知错误" : code;
}

function attentionBody(event: RuntimeEvent): string | undefined {
  if (event.type === "permission.requested") {
    const payload = event.payload;
    const operation = operationForSubjectKind(payload.subjects[0]?.kind);
    const target = subjectTarget(payload.subjects[0]);
    return target === undefined ? `需要确认：${operation}` : `需要确认：${operation} ${target}`;
  }
  if (event.type === "question.requested") {
    const questions: QuestionItem[] = event.payload.questions;
    const first = questions[0];
    const head = first === undefined ? undefined : ellipsize(first.question);
    if (questions.length <= 1) return head === undefined ? "需要你回答" : `需要你回答：${head}`;
    return head === undefined
      ? `需要你回答 ${questions.length} 个问题`
      : `需要你回答 ${questions.length} 个问题：${head}`;
  }
  return undefined;
}

/**
 * 判定一条事件要不要提醒。返回 null 表示不提醒（关掉、在看、重放、非本次运行、
 * 用时不到阈值、用户中断等都在这里收敛）。
 */
export function decideNotification(input: NotifyInput): NotifyDecision | null {
  const { event, prefs } = input;
  if (!prefs.enabled || !input.live || input.watching) return null;

  if (event.type === "permission.requested" || event.type === "question.requested") {
    if (!prefs.attention) return null;
    const body = attentionBody(event);
    return body === undefined
      ? null
      : { kind: "attention", title: sessionTitle(input.session), body };
  }

  if (event.type !== "turn.completed") return null;
  const payload = event.payload;
  // 恢复修复补写的 turn.completed 不是本次运行的实时结果（recovered 只在补写时出现）
  if (payload.recovered === true) return null;
  // 用户自己按的中断（Core 的 reason 是 aborted，效果图里写 interrupted）永不提醒
  if (payload.reason === "aborted") return null;

  const startedAt = input.turnStartedAt;
  const durationMs =
    startedAt === undefined ? undefined : Math.max(0, Date.parse(event.time) - startedAt);

  if (payload.reason === "error") {
    if (!prefs.error) return null;
    const spent = durationMs === undefined ? "" : `，用时 ${formatDuration(durationMs)}`;
    return {
      kind: "error",
      title: sessionTitle(input.session),
      body: `出错停止${spent}：${errorSummary(payload.error)}`,
    };
  }

  if (!prefs.done) return null;
  if (durationMs === undefined || durationMs < prefs.doneAfterSeconds * 1000) return null;
  return {
    kind: "done",
    title: sessionTitle(input.session),
    body: `已完成，用时 ${formatDuration(durationMs)}，${payload.steps} 步`,
  };
}

/**
 * 侧栏留痕判定：实时事件里，非中断地出错或结束时给会话打标记（打开会话即清除）。
 * 与通知开关、完成阈值无关——留痕的意义正是「系统通知可能被吞掉」；
 * 恢复补写的 turn.completed 与用户中断不算。
 */
export function sessionMarkFor(event: RuntimeEvent): SessionMark | null {
  if (event.type !== "turn.completed") return null;
  if (event.payload.recovered === true || event.payload.reason === "aborted") return null;
  return event.payload.reason === "error" ? "error" : "done";
}

/**
 * 从 `describeSettings()` 的结果读出生效设置（Core 缺条目时按缺省补齐；
 * 字段无效时 Core 已逐个忽略并警告，这里只看 effective 字符串）。
 */
export function notifyPrefsFrom(items: readonly SettingItem[]): NotifyPrefs {
  const effective = (key: SettingItem["key"]): string | undefined =>
    items.find((item) => item.key === key)?.effective;
  const bool = (key: SettingItem["key"], fallback: boolean): boolean => {
    const value = effective(key);
    return value === undefined ? fallback : value === "true";
  };
  const seconds = Number(effective("notifications.doneAfterSeconds"));
  return {
    enabled: bool("notifications.enabled", NOTIFY_DEFAULTS.enabled),
    attention: bool("notifications.events.attention", NOTIFY_DEFAULTS.attention),
    error: bool("notifications.events.error", NOTIFY_DEFAULTS.error),
    done: bool("notifications.events.done", NOTIFY_DEFAULTS.done),
    doneAfterSeconds:
      Number.isFinite(seconds) && seconds >= 0 ? seconds : NOTIFY_DEFAULTS.doneAfterSeconds,
    sound: bool("notifications.sound", NOTIFY_DEFAULTS.sound),
  };
}

export const DONE_THRESHOLD_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 30, label: "30 秒" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 180, label: "3 分钟" },
  { seconds: 300, label: "5 分钟" },
  { seconds: 600, label: "10 分钟" },
];

/** 阈值的显示文字：命中档位用档位名，否则写「N 秒」（保存值不是档位时也照此显示） */
export function thresholdLabel(seconds: number): string {
  const hit = DONE_THRESHOLD_CHOICES.find((choice) => choice.seconds === seconds);
  return hit?.label ?? `${seconds} 秒`;
}
