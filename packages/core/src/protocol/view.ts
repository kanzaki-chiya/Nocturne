import type { SkillSnapshot } from "./skills.js";
/**
 * 派生视图（docs/protocols/view.md）：把事件流折叠成 SessionView 的纯函数
 * reducer，供 TUI 与后续客户端共享（ADR-0002 第 5 条）。
 * 无 I/O、无 Node 内置依赖；entries 只由持久事件创建，live/notices 只由
 * 临时事件创建，收敛点上除 revision/notices 外重放等价（V1）。
 */
import type {
  AttachmentDescribedPayload,
  ContextCompactedPayload,
  DurableEvent,
  EphemeralEvent,
  PermissionResolvedPayload,
  PermissionReviewedPayload,
  ProviderRetryPayload,
  RuntimeEvent,
  RuntimeStatus,
  TurnEndReason,
} from "./events.js";
import { isDurableEvent, isDurableEventType, isEphemeralEventType } from "./events.js";
import { todoItemsFromCompletion, type TodoItem } from "./todo.js";
import { effectiveEvents, rewindNotification, firstUserText } from "./rewind.js";
export { firstUserText } from "./rewind.js";
import type {
  AgentDelegation,
  AssistantTiming,
  ContentBlock,
  FileRef,
  FinishReason,
  ImageAttachment,
  FileAttachment,
  ModelRef,
  PermissionAction,
  PermissionOption,
  PermissionSource,
  PermissionSubject,
  QuestionItem,
  ReasoningEffort,
  ToolCallRef,
  ToolCallStatus,
  Usage,
} from "./types.js";

// ── 视图类型 ────────────────────────────────────────────────

/** 会话标题与恢复列表：首条用户消息的第一个文本块的原文首行。 */

export interface SessionView {
  title: string | undefined;
  firstTitle: string | undefined;
  generatedTitle: string | undefined;
  userTitle: string | undefined;
  /** 当前任务清单；全部完成后由下一条持久化 message.user 归档 */
  todos: TodoItem[];
  /** 每次归约 +1；不参与重放等价 */
  revision: number;
  meta:
    | { cwd: string; workspaceRoot: string; formatVersion: number; nocturneVersion: string }
    | undefined;
  config: {
    model: ModelRef | undefined;
    permissionPreset: string | undefined;
    /** 思考档位（ADR-0018）；缺省按 off 处理 */
    reasoningEffort: ReasoningEffort | undefined;
  };
  status: RuntimeStatus;
  retry: ProviderRetryPayload | undefined;
  currentTurn: { turnId: string; turnIndex: number } | undefined;
  lastTurn:
    | {
        turnIndex: number;
        reason: TurnEndReason;
        steps: number;
        usage: Usage;
        recovered: boolean;
      }
    | undefined;
  turnCount: number;
  usage: Usage;
  pendingPermission: PendingPermission | undefined;
  /**
   * 待回答的提问（ADR-0032 §3）：只由临时事件 question.requested 产生；
   * 对应 callId 的 tool.completed 或 turn.completed 到达时清除。
   */
  pendingQuestion: PendingQuestion | undefined;
  /** 只由持久事件创建（可重放） */
  entries: ViewEntry[];
  /** 只由临时事件创建；对应持久事件到达时晋升入 entries */
  live: { assistants: LiveAssistant[]; tools: LiveTool[] };
  /** 只由临时事件产生（不可重放） */
  notices: SessionNotice[];
  /**
   * MCP 服务器连接状态：由临时事件 mcp.server 归约，键为服务器名，
   * 同名以最新事件为准；stopped 表示已移除或停用，删除该键（不可重放）
   */
  mcpServers: Record<string, McpServerViewState>;
  lastSeq: number;
}

function visibleTitle(view: SessionView): string | undefined {
  return (
    (view.userTitle?.length ? view.userTitle : undefined) ??
    (view.generatedTitle?.length ? view.generatedTitle : undefined) ??
    view.firstTitle
  );
}

export interface McpServerViewState {
  state: "starting" | "ready" | "failed" | "crashed";
  toolCount?: number;
  error?: string;
}

export type ViewEntry = UserEntry | AssistantEntry | ToolEntry | NoticeEntry;

export interface UserEntry {
  kind: "user";
  key: string;
  seq: number;
  turnId: string;
  content: ContentBlock[];
  /** 随消息附带的图片引用（ADR-0023）；无附件时字段不出现 */
  attachments?: ImageAttachment[] | undefined;
  files?: FileAttachment[] | undefined;
  fileRefs?: FileRef[] | undefined;
  /** 技能调用的正文快照（skills.md 第 2 节）；普通消息字段不出现 */
  skill?: SkillSnapshot | undefined;
  delegate?: AgentDelegation | undefined;
  /** 运行中插话（ADR-0070）：界面加「插话」标签，不是新 Turn 的开始 */
  steer?: true | undefined;
  descriptions?: AttachmentDescribedPayload[] | undefined;
}

/**
 * 用户消息里用户亲自输入的正文（客户端显示、复制、重发用）。
 *
 * 提交时 Core 在 `content` 末尾按顺序追加给模型看的快照块（`src/index.ts`
 * 的 submit 路径，经 `runTurn` 落盘）：每个非图片 `@` 引用一块（`resolveFileRefs`）、
 * 技能正文一块、委派指令一块。这里按条数从末尾切掉，再拼接剩下的 text 块。
 * 以后新增快照种类或改变追加数量，必须同步改这里。
 */
export function userEntryText(entry: UserEntry): string {
  const snapshots =
    (entry.fileRefs?.filter((ref) => ref.kind !== "image").length ?? 0) +
    (entry.skill ? 1 : 0) +
    (entry.delegate ? 1 : 0) +
    (entry.files?.length ? 1 : 0);
  const content = snapshots === 0 ? entry.content : entry.content.slice(0, -snapshots);
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface AssistantEntry {
  kind: "assistant";
  key: string;
  turnId: string;
  messageId: string;
  seq: number;
  time: string;
  text: string;
  reasoning: string;
  toolCalls: ToolCallRef[];
  model: ModelRef;
  usage: Usage | undefined;
  /** 请求计时；旧日志没有 */
  timing?: AssistantTiming | undefined;
  finishReason: FinishReason | "aborted";
}

export type ToolEntryStatus = "awaiting_permission" | "running" | ToolCallStatus;

export interface ToolEntry {
  descriptions?: AttachmentDescribedPayload[] | undefined;
  kind: "tool";
  key: string;
  turnId: string;
  callId: string;
  name: string | undefined;
  seq: number;
  status: ToolEntryStatus;
  input: unknown;
  /** 经 ToolTraits.dispatch 代理调用时解析后的目标工具与输入（ADR-0067 §3） */
  target?: { name: string; input: unknown } | undefined;
  subjects: PermissionSubject[];
  permission:
    | {
        action: PermissionAction;
        source: PermissionSource;
        rule: string | undefined;
        grant?: { scope: "session" | "project"; createdAt: string } | undefined;
      }
    | undefined;
  resolution: PermissionResolvedPayload | undefined;
  review?: PermissionReviewedPayload | undefined;
  /** tool.progress 累计；completed 时清空，收敛点上必为空 */
  liveOutput: string;
  result:
    | {
        status: ToolCallStatus;
        modelContent: string;
        output: unknown;
        error: { code: string; message: string } | undefined;
        truncated: boolean;
        spillPath: string | undefined;
        /** 工具结果附带的图片引用（ADR-0023）；无附件时字段不出现 */
        attachments?: ImageAttachment[] | undefined;
        files?: FileAttachment[] | undefined;
        durationMs: number | undefined;
      }
    | undefined;
}

export interface NoticeEntry {
  kind: "notice";
  key: string;
  seq: number;
  subtype: "permission" | "turn_end" | "compacted" | "config" | "rewound";
  /** 已格式化的单行摘要（与 CLI 同文案口径） */
  message: string;
  payload: unknown;
}

export interface LiveAssistant {
  kind: "assistant";
  messageId: string;
  turnId: string | undefined;
  text: string;
  reasoning: string;
}

export interface LiveTool {
  kind: "tool";
  callId: string;
  name: string;
  turnId: string | undefined;
  inputText: string;
}

export interface PendingPermission {
  requestId: string;
  callId: string;
  toolName: string | undefined;
  subjects: PermissionSubject[];
  reason: string;
  options: PermissionOption[];
  review?: PermissionReviewedPayload | undefined;
}

/** 待回答的提问（ADR-0032）：客户端据此渲染提问面板并 respondQuestion */
export interface PendingQuestion {
  requestId: string;
  callId: string;
  questions: QuestionItem[];
}

export interface SessionNotice {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  /** 产生时 view.entries.length，供客户端把提示固定在当时的位置 */
  afterEntry?: number | undefined;
}

// ── 归约器内部簿记（不进 JSON；符号键 + 不可枚举） ──────────

interface Bookkeeping {
  events: DurableEvent[];
  attachments: Map<number, UserEntry | ToolEntry>;
  /** callId → entries 中的工具条目（O(1) 查找） */
  tools: Map<string, ToolEntry>;
  /** callId → 最近的 permission.resolved payload（供晚到的 started/completed 回填） */
  resolved: Map<string, PermissionResolvedPayload>;
}

const BOOKKEEPING = Symbol("nocturne.view.bookkeeping");

type InternalView = SessionView & { [BOOKKEEPING]?: Bookkeeping };

function book(view: SessionView): Bookkeeping {
  const iv = view as InternalView;
  let b = iv[BOOKKEEPING];
  if (b === undefined) {
    b = { events: [], tools: new Map(), resolved: new Map(), attachments: new Map() };
    Object.defineProperty(iv, BOOKKEEPING, { value: b, enumerable: false });
  }
  return b;
}

// ── API ────────────────────────────────────────────────────

export function createSessionView(): SessionView {
  return {
    title: undefined,
    firstTitle: undefined,
    generatedTitle: undefined,
    userTitle: undefined,
    todos: [],
    revision: 0,
    meta: undefined,
    config: { model: undefined, permissionPreset: undefined, reasoningEffort: undefined },
    status: "idle",
    retry: undefined,
    currentTurn: undefined,
    lastTurn: undefined,
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    pendingPermission: undefined,
    pendingQuestion: undefined,
    entries: [],
    live: { assistants: [], tools: [] },
    notices: [],
    mcpServers: {},
    lastSeq: 0,
  };
}

export function reduceSessionView(view: SessionView, event: RuntimeEvent): void {
  view.revision += 1;
  if (isDurableEvent(event)) {
    book(view).events.push(event);
    view.lastSeq = event.seq;
    if (isDurableEventType(event.type)) reduceDurable(view, event);
  } else if (isEphemeralEventType(event.type)) {
    reduceEphemeral(view, event);
  }
  // 未知类型：忽略（events.md §8）
}

export function replaySessionView(events: readonly DurableEvent[]): SessionView {
  const view = createSessionView();
  for (const ev of events) reduceSessionView(view, ev);
  return view;
}

// ── 持久事件 ────────────────────────────────────────────────

function reduceDurable(view: SessionView, event: DurableEvent, rebuilding = false): void {
  const b = book(view);
  const turnId = event.turnId;
  switch (event.type) {
    case "session.rewound": {
      if (!rebuilding && event.payload.mode !== "files") {
        // ponytail: rebuild only on explicit rewind; normal event delivery stays O(1).
        const rebuilt = createSessionView();
        book(rebuilt).events = b.events;
        for (const ev of effectiveEvents(b.events)) reduceDurable(rebuilt, ev, true);
        view.entries = rebuilt.entries;
        view.firstTitle = rebuilt.firstTitle;
        // 标题是会话元数据，不随对话回退；保留当前两个显式来源。
        view.title = visibleTitle(view);
        view.todos = rebuilt.todos;
        view.lastTurn = rebuilt.lastTurn;
        view.currentTurn = undefined;
        view.pendingPermission = undefined;
        view.pendingQuestion = undefined;
        view.live = { assistants: [], tools: [] };
        view.status = "idle";
        view.retry = undefined;
        b.attachments = book(rebuilt).attachments;
        b.tools = book(rebuilt).tools;
        b.resolved = book(rebuilt).resolved;
      } else {
        pushNotice(
          view,
          event.seq,
          "rewound",
          rewindNotification(event.payload, b.events),
          event.payload,
        );
      }
      break;
    }
    case "session.created": {
      const p = event.payload;
      view.meta = {
        cwd: p.cwd,
        workspaceRoot: p.workspaceRoot,
        formatVersion: p.formatVersion,
        nocturneVersion: p.nocturneVersion,
      };
      view.config = {
        model: p.model,
        permissionPreset: p.permissionPreset,
        reasoningEffort: p.reasoningEffort,
      };
      break;
    }
    case "session.config_changed": {
      const p = event.payload;
      if (p.model !== undefined) view.config.model = p.model;
      if (p.permissionPreset !== undefined) view.config.permissionPreset = p.permissionPreset;
      if (p.reasoningEffort !== undefined) view.config.reasoningEffort = p.reasoningEffort;
      const lines: string[] = [];
      if (p.model !== undefined) lines.push(`模型已切换为 ${p.model.provider}/${p.model.model}`);
      if (p.permissionPreset !== undefined) lines.push(`权限预设已切换为 ${p.permissionPreset}`);
      // ADR-0018 §3：Turn 进行中切档只改持久化意图，下一 Turn 才生效——
      // 回放重建时 status=idle，该标注只出现在实时的 Turn 内切换场景
      if (p.reasoningEffort !== undefined)
        lines.push(
          `思考档位已切换为 ${p.reasoningEffort}` +
            (view.status !== "idle" ? "（下一 Turn 生效）" : ""),
        );
      // ADR-0022：shell 切换立即生效（下一次 shell 调用起）
      if (p.shell !== undefined) lines.push(`shell 已切换为 ${p.shell.kind}（${p.shell.path}）`);
      if (lines.length > 0) pushNotice(view, event.seq, "config", lines.join("\n"), p);
      break;
    }
    case "turn.started": {
      view.currentTurn = { turnId: turnId ?? "", turnIndex: event.payload.turnIndex };
      view.turnCount = Math.max(view.turnCount, event.payload.turnIndex);
      break;
    }
    case "message.user": {
      // ADR-0070 §7：任务清单归档只由非插话的用户消息触发
      if (
        event.payload.steer !== true &&
        view.todos.length > 0 &&
        view.todos.every((item) => item.status === "completed")
      )
        view.todos = [];
      if (view.firstTitle === undefined && !view.entries.some((entry) => entry.kind === "user"))
        view.firstTitle = firstUserText(event.payload);
      view.title = visibleTitle(view);
      view.entries.push({
        kind: "user",
        key: `u:${event.payload.messageId}`,
        seq: event.seq,
        turnId: turnId ?? "",
        content: event.payload.content,
        ...(event.payload.files !== undefined ? { files: event.payload.files } : {}),
        ...(event.payload.fileRefs !== undefined ? { fileRefs: event.payload.fileRefs } : {}),
        ...(event.payload.skill !== undefined ? { skill: event.payload.skill } : {}),
        ...(event.payload.delegate !== undefined ? { delegate: event.payload.delegate } : {}),
        ...(event.payload.steer === true ? { steer: true as const } : {}),
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
      });
      const entry = view.entries.at(-1);
      if (entry?.kind === "user") b.attachments.set(event.seq, entry);
      break;
    }
    case "attachment.described": {
      const entry = b.attachments.get(event.payload.attachmentRef.seq);
      if (entry !== undefined && event.payload.text !== "")
        (entry.descriptions ??= []).push(event.payload);
      break;
    }
    case "session.titled": {
      if (event.payload.source === "user") view.userTitle = event.payload.title;
      else view.generatedTitle = event.payload.title;
      view.title = visibleTitle(view);
      break;
    }
    case "message.assistant": {
      const p = event.payload;
      view.live.assistants = view.live.assistants.filter((a) => a.messageId !== p.messageId);
      view.entries.push({
        kind: "assistant",
        key: `a:${p.messageId}`,
        turnId: turnId ?? "",
        messageId: p.messageId,
        seq: event.seq,
        time: event.time,
        text: p.content
          .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join(""),
        reasoning: p.content
          .filter((c): c is Extract<ContentBlock, { type: "reasoning" }> => c.type === "reasoning")
          .map((c) => c.text)
          .join(""),
        toolCalls: p.toolCalls,
        model: p.model,
        usage: p.usage,
        ...(p.timing !== undefined ? { timing: p.timing } : {}),
        finishReason: p.finishReason,
      });
      break;
    }
    case "permission.reviewed": {
      const entry = promoteTool(view, b, event.payload.callId, turnId ?? "", event.seq);
      entry.review = event.payload;
      break;
    }
    case "permission.requested": {
      const p = event.payload;
      const liveTool = view.live.tools.find((t) => t.callId === p.callId);
      const entry = promoteTool(view, b, p.callId, turnId ?? "", event.seq);
      entry.status = "awaiting_permission";
      entry.subjects = p.subjects;
      if (entry.target === undefined && liveTool !== undefined) {
        const parsedTarget = parseDispatchedLiveTarget(liveTool.inputText);
        if (parsedTarget !== undefined) entry.target = parsedTarget;
      }
      const mcpTarget = p.subjects.find((s) => s.kind === "mcp")?.target;
      const resolvedToolName =
        entry.target?.name ??
        (mcpTarget !== undefined ? `mcp__${mcpTarget.replace("/", "__")}` : undefined) ??
        entry.name ??
        liveTool?.name;
      view.pendingPermission = {
        requestId: p.requestId,
        callId: p.callId,
        toolName: resolvedToolName,
        subjects: p.subjects,
        reason: p.reason,
        options: p.options,
        review: entry.review,
      };
      break;
    }
    case "permission.resolved": {
      const p = event.payload;
      b.resolved.set(p.callId, p);
      const entry = b.tools.get(p.callId);
      if (entry !== undefined) entry.resolution = p;
      if (
        view.pendingPermission !== undefined &&
        ((p.requestId !== undefined && view.pendingPermission.requestId === p.requestId) ||
          view.pendingPermission.callId === p.callId)
      ) {
        view.pendingPermission = undefined;
      }
      const detail = p.rule !== undefined ? `${p.source}：${p.rule}` : p.source;
      const remembered =
        p.remember === "project"
          ? "，已写入项目授权"
          : p.remember === "session"
            ? "，本会话内有效"
            : "";
      const fb = p.feedback !== undefined && p.feedback !== "" ? `（反馈：${p.feedback}）` : "";
      // 审查器结算时，permission.reviewed 已给出结论、理由与用量，不再重复一条权限提示
      if (p.source !== "reviewer")
        pushNotice(
          view,
          event.seq,
          "permission",
          `权限：${p.action}（${detail}）${remembered}${fb}`,
          p,
        );
      break;
    }
    case "tool.started": {
      const p = event.payload;
      const entry = promoteTool(view, b, p.callId, turnId ?? "", event.seq);
      entry.status = "running";
      entry.name = p.name;
      entry.input = p.input;
      if (p.target !== undefined) entry.target = p.target;
      entry.subjects = p.subjects;
      entry.permission = {
        action: p.permission.action,
        source: p.permission.source,
        rule: p.permission.rule,
        grant: p.permission.grant,
      };
      break;
    }
    case "tool.completed": {
      const p = event.payload;
      view.todos = todoItemsFromCompletion(p) ?? view.todos;
      // 未执行即终态：丢弃 preparing 残片（inputText 不属于可重放视图）
      view.live.tools = view.live.tools.filter((t) => t.callId !== p.callId);
      const entry = promoteTool(view, b, p.callId, turnId ?? "", event.seq);
      entry.name = p.name;
      entry.status = p.status;
      entry.liveOutput = "";
      entry.result = {
        status: p.status,
        modelContent: p.modelContent,
        output: p.output,
        error: p.error,
        truncated: p.truncated === true,
        spillPath: p.spillPath,
        ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
        ...(p.files !== undefined ? { files: p.files } : {}),
        durationMs: p.durationMs,
      };
      b.attachments.set(event.seq, entry);
      // ADR-0032 §3：待回答的提问随对应调用的结算清除
      if (view.pendingQuestion?.callId === p.callId) view.pendingQuestion = undefined;
      break;
    }
    case "context.compacted": {
      const p = event.payload;
      pushNotice(view, event.seq, "compacted", compactedNoticeText(p.kind), p);
      break;
    }
    case "turn.completed": {
      const p = event.payload;
      const closing =
        view.currentTurn !== undefined && view.currentTurn.turnId === turnId
          ? view.currentTurn
          : undefined;
      if (closing !== undefined) view.currentTurn = undefined;
      view.turnCount = Math.max(view.turnCount, closing?.turnIndex ?? 0);
      view.lastTurn = {
        turnIndex: closing?.turnIndex ?? view.turnCount,
        reason: p.reason,
        steps: p.steps,
        usage: p.usage,
        recovered: p.recovered === true,
      };
      view.usage = addUsage(view.usage, p.usage);
      view.status = "idle";
      view.retry = undefined;
      view.pendingPermission = undefined;
      view.pendingQuestion = undefined;
      // 串行管线同一时刻至多一个 Turn；LiveTool.turnId 可空，
      // 按 turnId 筛会留下无持久落点的孤儿（view.md §3）
      view.live = { assistants: [], tools: [] };
      if (p.reason !== "done") {
        const detail = p.error !== undefined ? `${p.error.code} ${p.error.message}` : "";
        const message =
          p.recovered === true
            ? `上次进程退出，已按 ${p.error?.code ?? "error"} 收束：${p.error?.message ?? ""}`
            : `Turn 结束（${p.reason}）${detail !== "" ? `：${detail}` : ""}`;
        pushNotice(view, event.seq, "turn_end", message, p);
      }
      break;
    }
  }
}

/**
 * 压缩回执文案：自动压缩多数是修剪（较早的工具输出换成占位），不是摘要，
 * 两种分开写；kind 与 throughSeq 只留在 notice.payload 上，不进文案。
 * CLI 渲染行与 TUI/桌面端的 notice 都用这一份。
 */
export function compactedNoticeText(kind: ContextCompactedPayload["kind"]): string {
  return kind === "prune" ? "已省略较早的工具输出" : "上下文已压缩为摘要";
}

function parseDispatchedLiveTarget(
  inputText: string,
): { name: string; input: unknown } | undefined {
  if (inputText === "") return undefined;
  try {
    const parsed = JSON.parse(inputText) as { tool?: unknown; arguments?: unknown } | null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.tool === "string" &&
      parsed.tool !== ""
    ) {
      return { name: parsed.tool, input: parsed.arguments ?? {} };
    }
  } catch {
    // 流式半截 JSON 忽略
  }
  return undefined;
}

function promoteTool(
  view: SessionView,
  b: Bookkeeping,
  callId: string,
  turnId: string,
  seq: number,
): ToolEntry {
  const liveIdx = view.live.tools.findIndex((t) => t.callId === callId);
  const live = liveIdx >= 0 ? view.live.tools.splice(liveIdx, 1)[0] : undefined;
  let entry = b.tools.get(callId);
  if (entry === undefined) {
    entry = {
      kind: "tool",
      key: `t:${callId}`,
      turnId,
      callId,
      name: live?.name,
      seq,
      status: "running",
      input: undefined,
      subjects: [],
      permission: undefined,
      resolution: b.resolved.get(callId),
      liveOutput: "",
      result: undefined,
    };
    b.tools.set(callId, entry);
    view.entries.push(entry);
  }
  if (entry.name === undefined && live !== undefined) entry.name = live.name;
  return entry;
}

function pushNotice(
  view: SessionView,
  seq: number,
  subtype: NoticeEntry["subtype"],
  message: string,
  payload: unknown,
): void {
  view.entries.push({
    kind: "notice",
    key: `n:${seq}`,
    seq,
    subtype,
    message,
    payload,
  });
}

/**
 * 会话累计用量的即时值：已结束 Turn 的累计（`view.usage`，turn.completed 时累加）
 * 加上进行中 Turn 已写入的 assistant 消息用量，客户端不必等 Turn 结束才更新。
 * Turn 结束后以 turn.completed 的用量为准。
 */
export function sessionUsageSoFar(view: SessionView): Usage {
  const turnId = view.currentTurn?.turnId;
  if (turnId === undefined) return view.usage;
  let usage = view.usage;
  for (const entry of view.entries) {
    if (entry.kind === "assistant" && entry.turnId === turnId && entry.usage !== undefined)
      usage = addUsage(usage, entry.usage);
  }
  return usage;
}

function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cr = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cw = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  const rt = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  if (cr > 0) out.cacheReadTokens = cr;
  if (cw > 0) out.cacheWriteTokens = cw;
  if (rt > 0) out.reasoningTokens = rt;
  return out;
}

// ── 临时事件 ────────────────────────────────────────────────

function reduceEphemeral(view: SessionView, event: EphemeralEvent): void {
  switch (event.type) {
    case "runtime.status": {
      view.status = event.payload.status;
      if (view.status !== "retrying") view.retry = undefined;
      break;
    }
    case "provider.retry": {
      view.retry = event.payload;
      view.status = "retrying";
      const discarded = event.payload.discarded;
      if (discarded !== undefined) {
        view.live.assistants = view.live.assistants.filter(
          (a) => a.messageId !== discarded.messageId,
        );
        view.live.tools = view.live.tools.filter((t) => !discarded.callIds.includes(t.callId));
      }
      break;
    }
    case "runtime.warning": {
      view.notices.push({
        level: "warning",
        code: event.payload.code,
        message: event.payload.message,
        afterEntry: view.entries.length,
      });
      break;
    }
    case "runtime.error": {
      view.notices.push({
        level: "error",
        code: event.payload.code,
        message: event.payload.message,
        afterEntry: view.entries.length,
      });
      if (event.payload.code === "session_failed") view.status = "failed";
      break;
    }
    case "message.assistant.delta": {
      const p = event.payload;
      let a = view.live.assistants.find((x) => x.messageId === p.messageId);
      if (a === undefined) {
        a = {
          kind: "assistant",
          messageId: p.messageId,
          turnId: event.turnId,
          text: "",
          reasoning: "",
        };
        view.live.assistants.push(a);
      }
      if (p.kind === "text") a.text += p.delta;
      else a.reasoning += p.delta;
      break;
    }
    case "tool.input.delta": {
      const p = event.payload;
      let t = view.live.tools.find((x) => x.callId === p.callId);
      if (t === undefined) {
        t = { kind: "tool", callId: p.callId, name: p.name, turnId: event.turnId, inputText: "" };
        view.live.tools.push(t);
      }
      t.inputText += p.delta;
      break;
    }
    case "tool.progress": {
      const b = book(view);
      const entry = b.tools.get(event.payload.callId);
      if (entry !== undefined) {
        const { chunk, stream } = event.payload;
        if (stream === "info") {
          if (entry.liveOutput !== "" && !entry.liveOutput.endsWith("\n")) entry.liveOutput += "\n";
          entry.liveOutput += `${chunk}\n`;
        } else {
          entry.liveOutput += chunk;
        }
      }
      break;
    }
    case "mcp.server": {
      const { name, state, toolCount, error } = event.payload;
      if (state === "stopped") {
        // 重建对象而非 delete（no-dynamic-delete）
        view.mcpServers = Object.fromEntries(
          Object.entries(view.mcpServers).filter(([key]) => key !== name),
        );
        break;
      }
      view.mcpServers[name] = {
        state,
        ...(toolCount !== undefined ? { toolCount } : {}),
        ...(error !== undefined ? { error } : {}),
      };
      break;
    }
    case "question.requested": {
      // ADR-0032 §3：待回答的提问只来自此临时事件，不进持久化 entries
      const p = event.payload;
      view.pendingQuestion = {
        requestId: p.requestId,
        callId: p.callId,
        questions: p.questions,
      };
      break;
    }
  }
}
