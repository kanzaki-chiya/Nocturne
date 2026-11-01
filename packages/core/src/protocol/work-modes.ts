/**
 * 执行方式（ADR-0076）：提交时的 `workMode`、用户消息上的快照与客户端斜杠解析。
 * 纯函数，客户端与 Runtime 共用。
 */

export const WORK_MODE_NAMES = ["grill-me"] as const;

export type WorkModeName = (typeof WORK_MODE_NAMES)[number];

/**
 * `message.user.workMode`：说明块正文快照，回放与回退沿用，不重新生成。
 * name 按字符串读取：较新版本写入的未知名字不让整条日志解析失败。
 */
export interface WorkModeSnapshot {
  name: WorkModeName | (string & {});
  body: string;
}

export function isWorkModeName(value: unknown): value is WorkModeName {
  return typeof value === "string" && (WORK_MODE_NAMES as readonly string[]).includes(value);
}

/** 斜杠解析结果：带任务的提交，或整行只是命令名时的用法提示 */
export type WorkModeSlash =
  | { kind: "submit"; workMode: WorkModeName; text: string }
  | { kind: "usage"; name: WorkModeName; hint: string };

const USAGE: Record<WorkModeName, string> = {
  "grill-me": "用法：/grill-me 需求",
};

/**
 * 解析 `/<模式> …`；不是执行方式命令时返回 undefined。命令名不区分大小写，
 * 任务可以包含换行。
 */
export function parseWorkModeSlash(line: string): WorkModeSlash | undefined {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(line);
  const name = match?.[1]?.toLowerCase();
  if (!isWorkModeName(name)) return undefined;
  const text = (match?.[2] ?? "").trim();
  if (text === "") return { kind: "usage", name, hint: USAGE[name] };
  return { kind: "submit", workMode: name, text };
}

/** 用户消息的显示文本：执行方式消息在正文前加命令名（核对说明只有命令名） */
export function workModeDisplayText(text: string, workMode: { name: string } | undefined): string {
  if (workMode === undefined) return text;
  return text === "" ? `/${workMode.name}` : `/${workMode.name} ${text}`;
}

/** 客户端补全用的命令表（名称、一行摘要） */
export const WORK_MODE_COMMANDS: readonly { name: `/${WorkModeName}`; summary: string }[] = [
  { name: "/grill-me", summary: "追问需求" },
];
