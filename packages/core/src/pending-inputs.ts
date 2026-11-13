/**
 * 待发输入（ADR-0070）：运行中插话与排队。
 *
 * 待发输入是 Runtime 内存中的会话状态，**不写日志**——它在被消费前不属于
 * 对话事实。每次变化由调用方把完整快照发成临时事件 `input.pending`。
 * 消费（取出插话、取队首排队）是同步的：取出即从列表移除，此后编辑与撤回
 * 返回 `input_consumed`，保证"要么改成功且发出的是新内容，要么改不动"。
 */
import { randomUUID } from "node:crypto";

import type {
  ContentBlock,
  PendingInputItem,
  PendingInputMode,
  PendingInputsSnapshot,
  PreparedInput,
} from "./protocol/index.js";

interface Entry {
  id: string;
  mode: PendingInputMode;
  input: PreparedInput;
  paused: boolean;
  createdAt: string;
}

/** 编辑待发输入：只替换文本，附件、`@` 引用与技能快照随原提交保留 */
export interface PendingInputPatch {
  mode?: PendingInputMode | undefined;
  input?: { text?: string | undefined } | undefined;
}

export type PendingInputOutcome = "ok" | "consumed" | "readonly" | "work_mode" | "empty_task";

export class PendingInputs {
  private readonly entries: Entry[] = [];
  private paused = false;

  constructor(
    private readonly emit: (snapshot: PendingInputsSnapshot) => void,
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  get size(): number {
    return this.entries.length;
  }

  snapshot(): PendingInputsSnapshot {
    const items: PendingInputItem[] = this.entries.map((entry) => ({
      id: entry.id,
      mode: entry.mode,
      ...(entry.input.backgroundShell?.name !== undefined
        ? { shellName: entry.input.backgroundShell.name }
        : {}),
      text: entry.input.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      attachments: (entry.input.attachments?.length ?? 0) + (entry.input.files?.length ?? 0),
      ...(entry.input.files?.length
        ? { files: entry.input.files.map(({ label, bytes }) => ({ label, bytes })) }
        : {}),
      createdAt: entry.createdAt,
      paused: entry.paused,
      ...(entry.input.workMode !== undefined ? { workMode: entry.input.workMode.name } : {}),
    }));
    return { items, paused: items.length > 0 && items.every((item) => item.paused) };
  }

  /** 追加一条到队尾；调用方决定空闲时是否改走普通提交 */
  add(mode: PendingInputMode, input: PreparedInput, forcePaused = false): string {
    const entry: Entry = {
      id: this.newId(),
      mode,
      input,
      paused:
        forcePaused ||
        ((mode === "subagent" || mode === "shell" || mode === "ensemble") && this.paused),
      createdAt: new Date().toISOString(),
    };
    if (forcePaused) this.paused = true;
    this.entries.push(entry);
    this.publish();
    return entry.id;
  }

  /** 生成一个不与列表条目关联的 id（空闲时直接开始 Turn 的返回值用） */
  nextId(): string {
    return this.newId();
  }

  /**
   * 安全点取出全部插话（按提交顺序）：同步移除并发布快照，调用方随后写
   * `message.user(steer)`。没有插话时返回空数组，不发布快照。
   */
  takeSteers(): PreparedInput[] {
    const taken = this.entries.filter(
      (entry) =>
        (entry.mode === "steer" ||
          entry.mode === "subagent" ||
          entry.mode === "shell" ||
          entry.mode === "ensemble") &&
        !entry.paused,
    );
    if (taken.length === 0) return [];
    for (const entry of taken) this.remove(entry);
    this.publish();
    return taken.map((entry) => entry.input);
  }

  /** 没有 Turn 可接收插话时，所有未暂停条目按提交顺序作为新 Turn 发出 */
  takeQueueHead(): PreparedInput | undefined {
    const head = this.entries.find((entry) => !entry.paused);
    if (head === undefined) return undefined;
    // 已错过当前 Turn 的插话全部转排队，避免被接续 Turn 的安全点抢先消费。
    for (const entry of this.entries) {
      if (
        !entry.paused &&
        entry.mode !== "subagent" &&
        entry.mode !== "shell" &&
        entry.mode !== "ensemble"
      )
        entry.mode = "queue";
    }
    this.remove(head);
    this.publish();
    return head.input;
  }

  update(id: string, patch: PendingInputPatch): PendingInputOutcome {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return "consumed";
    if (entry.mode === "subagent" || entry.mode === "shell" || entry.mode === "ensemble")
      return "readonly";
    // ADR-0076 §1：带执行方式的条目只能排队，不能转成插话
    if (patch.mode === "steer" && entry.input.workMode !== undefined) return "work_mode";
    if (entry.input.workMode !== undefined && patch.input?.text?.trim() === "") return "empty_task";
    if (patch.mode !== undefined) entry.mode = patch.mode;
    if (patch.input?.text !== undefined) {
      const text = { type: "text" as const, text: patch.input.text };
      const firstText = entry.input.content.findIndex((block) => block.type === "text");
      const content: ContentBlock[] = entry.input.content.filter((block) => block.type !== "text");
      content.splice(firstText < 0 ? 0 : firstText, 0, text);
      entry.input.content = content;
    }
    this.publish();
    return "ok";
  }

  shellResult(id: string) {
    return this.entries.find((entry) => entry.id === id)?.input.backgroundShell;
  }

  cancel(id: string): PendingInputOutcome {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return "consumed";
    this.remove(entry);
    this.publish();
    return "ok";
  }

  /** 非 done 结束（ADR-0070 §4）：剩余条目全部转为排队并暂停，不自动发送 */
  pauseAll(): void {
    this.paused = true;
    if (this.entries.length === 0) return;
    for (const entry of this.entries) {
      if (entry.mode !== "subagent" && entry.mode !== "shell" && entry.mode !== "ensemble")
        entry.mode = "queue";
      entry.paused = true;
    }
    this.publish();
  }

  /** 清空指定模式的条目（例如停止 Ensemble 时移除未送达帖子） */
  dropMode(mode: PendingInputMode): void {
    const dropped = this.entries.filter((entry) => entry.mode === mode);
    if (dropped.length === 0) return;
    for (const entry of dropped) this.remove(entry);
    this.publish();
  }

  /** 回退（ADR-0073 §4）：丢弃启动调用不在 keep 里的子代理结果 */
  dropSubagents(keep: ReadonlySet<string>): void {
    const dropped = this.entries.filter(
      (entry) =>
        (entry.mode === "subagent" &&
          entry.input.subagent !== undefined &&
          !keep.has(entry.input.subagent.callId)) ||
        (entry.mode === "shell" &&
          entry.input.backgroundShell !== undefined &&
          !keep.has(entry.input.backgroundShell.callId)),
    );
    if (dropped.length === 0) return;
    for (const entry of dropped) this.remove(entry);
    this.publish();
  }

  /** 开始新一轮：若列表中没有暂停条目，清除上一轮残留的 paused 标记（ADR-0070 §4、ADR-0073 §3） */
  turnStarted(): void {
    if (!this.entries.some((entry) => entry.paused)) {
      this.paused = false;
    }
  }

  /** Turn 以 done 结束：之后收束的子代理结果不再按暂停追加（ADR-0073 §3） */
  turnDone(): void {
    this.paused = false;
  }

  /** 解除暂停（ADR-0070 §4） */
  resume(): void {
    this.paused = false;
    if (!this.entries.some((entry) => entry.paused)) return;
    for (const entry of this.entries) entry.paused = false;
    this.publish();
  }

  private remove(entry: Entry): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
  }

  private publish(): void {
    this.emit(this.snapshot());
  }
}
