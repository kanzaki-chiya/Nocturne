/**
 * Open Artifact 共享协议类型与纯函数（ADR-0125 第二批）。
 * 纯类型与纯函数，无 Node 依赖；事件日志仅持久化稳定 `open-artifact://` 标识，
 * 绝不持久化或向远程设备发送宿主的回环地址。
 */
import type { DurableEvent } from "./events.js";
import { effectiveEvents } from "./rewind.js";

export const OPEN_ARTIFACT_URL_PREFIX = "open-artifact://artifact/";

export function isOpenArtifactUrl(url: string): boolean {
  return typeof url === "string" && url.trim().startsWith(OPEN_ARTIFACT_URL_PREFIX);
}

export function openArtifactIdFromUrl(url: string): string | undefined {
  if (!isOpenArtifactUrl(url)) return undefined;
  const raw = url.trim().slice(OPEN_ARTIFACT_URL_PREFIX.length);
  const cut = raw.search(/[/?#]/);
  const id = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  return id.length > 0 ? id : undefined;
}

export function formatOpenArtifactOriginKey(id: string): string {
  return `artifact:${id}`;
}

const ARTIFACT_TYPE_LABELS: Readonly<Record<string, string>> = {
  design: "设计",
  page: "页面",
  slides: "演示文稿",
  whiteboard: "白板",
  docs: "文档",
  sheets: "表格",
  data: "数据",
  motion: "动效",
  "design-system": "设计系统",
};

export function artifactTypeLabel(type: string): string {
  const key = type.trim().toLowerCase();
  return ARTIFACT_TYPE_LABELS[key] ?? (type.trim() || "作品");
}

/** 持久化在 tool.completed.artifact 上的作品元数据（不含本机回环 URL） */
export interface ToolCompletedArtifact {
  /** 稳定作品标识：open-artifact://artifact/<id> */
  url: string;
  id: string;
  title: string;
  /** 上游原生作品类型，如 design / page / slides */
  type: string;
  /** 可选简短摘要（如画板数量） */
  summary?: string | undefined;
  /** 本次工具调用是否意图打开编辑器 */
  open?: boolean | undefined;
  /** 删除作品时标为 true */
  removed?: boolean | undefined;
}

/** 会话视图中派生的 Open Artifact 作品条目 */
export interface SessionArtifact {
  url: string;
  id: string;
  title: string;
  type: string;
  summary?: string | undefined;
  seq: number;
  updatedAt: string;
}

/** Open Artifact 评论/请求唤醒的线程摘要 */
export interface OpenArtifactWakeThread {
  id: string;
  where?: string | undefined;
  text: string;
}

/** 持久化在 message.user.openArtifactWake 上的评论来源快照（供界面展示面包屑与正文） */
export interface OpenArtifactWakeSnapshot {
  artifactUrl: string;
  artifactId: string;
  title: string;
  reason: "comment" | "request" | "task" | (string & {});
  fromKind: "owner" | "collaborator" | "system" | (string & {});
  fromName?: string | undefined;
  summary: string;
  threads?: OpenArtifactWakeThread[] | undefined;
  /** 稳定投递去重键（持久落盘以便跨 Runtime 重建防重复投递，不含回环端口） */
  dedupeKey?: string | undefined;
}

/** 本机编辑器视图打开结果（仅限本机客户端使用，绝不发往远程设备） */
export interface OpenArtifactViewTicket {
  url: string;
  id: string;
  title?: string | undefined;
  type?: string | undefined;
  /** 携带短期票据的本机编辑器 URL */
  embedUrl: string;
  /** 不含票据的本机 Shell URL */
  viewUrl: string;
  /** 短期视图票据 id */
  view?: string | undefined;
  /** daemon 明确声明的允许加载源列表 */
  allowedOrigins: string[];
}

export interface OpenArtifactTheme {
  scheme: "light" | "dark";
  accent?: string | undefined;
}

export type OpenArtifactShellEvent =
  | { type: "ready"; id: string; title: string; artifactType: string }
  | { type: "place"; hash: string }
  | { type: "saved"; state: string | null; leaveLosesWork: boolean }
  | { type: "open_session"; sessionId: string | null }
  | { type: "new_session"; prompt: string }
  | { type: "open_external"; url: string }
  | { type: "saved_file"; path: string }
  | { type: "close" };

export type OpenArtifactHostEvent =
  | { kind: "open"; sessionId: string | null; ticket: OpenArtifactViewTicket }
  | { kind: "origins"; allowedOrigins: string[] }
  | { kind: "shell"; view: string; artifactUrl: string; event: OpenArtifactShellEvent }
  | {
      kind: "notice";
      sessionId: string | null;
      artifactUrl: string;
      title: string;
      fromKind: string;
      fromName?: string | undefined;
      summary: string;
      text: string;
    }
  | {
      kind: "artifact_changed";
      sessionId: string | null;
      url: string;
      id: string;
      title: string;
      artifactType: string;
      change: "created" | "updated" | "removed";
    };

/** 将单条成功工具结果中的 artifact 归约进 SessionArtifact 列表（原地更新） */
export function appendSessionArtifactFromCompletion(
  artifacts: SessionArtifact[],
  artifact: ToolCompletedArtifact,
  seq: number,
  time: string,
): void {
  const id = artifact.id.trim() || openArtifactIdFromUrl(artifact.url);
  if (id === undefined || id === "") return;
  const idx = artifacts.findIndex((item) => item.id === id);
  if (artifact.removed === true) {
    if (idx >= 0) artifacts.splice(idx, 1);
    return;
  }
  const url = isOpenArtifactUrl(artifact.url)
    ? artifact.url.trim()
    : `${OPEN_ARTIFACT_URL_PREFIX}${id}`;
  const existing = idx >= 0 ? artifacts[idx] : undefined;
  const trimmedTitle = artifact.title.trim();
  const trimmedType = artifact.type.trim();
  const next: SessionArtifact = {
    url,
    id,
    title: trimmedTitle !== "" ? trimmedTitle : (existing?.title ?? id),
    type: trimmedType !== "" ? trimmedType : (existing?.type ?? "artifact"),
    ...(artifact.summary !== undefined
      ? { summary: artifact.summary }
      : existing?.summary !== undefined
        ? { summary: existing.summary }
        : {}),
    seq,
    updatedAt: time !== "" ? time : (existing?.updatedAt ?? ""),
  };
  if (idx >= 0) {
    artifacts[idx] = next;
  } else {
    artifacts.push(next);
  }
}

/** 从持久事件流按有效事件派生会话的 Open Artifact 作品列表（支持回退与删除） */
export function deriveSessionArtifacts(events: readonly DurableEvent[]): SessionArtifact[] {
  const artifacts: SessionArtifact[] = [];
  for (const event of effectiveEvents(events)) {
    if (event.type !== "tool.completed" || event.payload.status !== "ok") continue;
    const art = event.payload.artifact;
    if (art === undefined) continue;
    appendSessionArtifactFromCompletion(artifacts, art, event.seq, event.time);
  }
  return artifacts;
}
