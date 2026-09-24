/**
 * Session 实现：单一写入通道保证"先写后发"；seq 只由日志决定。
 */
import { randomBytes } from "node:crypto";
import {
  encodeDurableEvent,
  type DurableEvent,
  type DurablePayload,
  type DurableType,
  type EphemeralEvent,
  type EphemeralPayload,
  type EphemeralType,
  type RuntimeEvent,
} from "../protocol/index.js";
import type { FileSystem } from "../platform/index.js";
import { foldEvents } from "./fold.js";
import { SessionError } from "./errors.js";
import type {
  EmitOptions,
  Session,
  SessionHealth,
  SessionListener,
  SessionRecovery,
  SessionState,
} from "./types.js";

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export class SessionImpl implements Session {
  readonly id: string;
  readonly runId: string;
  readonly logPath: string;
  readonly recovery?: SessionRecovery | undefined;

  private readonly fs: FileSystem;
  private readonly events: DurableEvent[];
  private readonly listeners = new Set<SessionListener>();
  private readonly diag: { event: RuntimeEvent; error: unknown }[] = [];
  private readonly failController = new AbortController();
  private readonly onClose?: (() => Promise<void>) | undefined;

  private writeChain: Promise<void> = Promise.resolve();
  private nextSeq: number;
  private nextEseq = 1;
  private lastPublishedSeq: number;
  private healthState: SessionHealth = "ok";

  constructor(args: {
    id: string;
    logPath: string;
    fs: FileSystem;
    events: DurableEvent[];
    runId?: string;
    recovery?: SessionRecovery | undefined;
    /** 关闭时释放的资源（会话锁等） */
    onClose?: (() => Promise<void>) | undefined;
  }) {
    this.id = args.id;
    this.logPath = args.logPath;
    this.fs = args.fs;
    this.events = [...args.events];
    this.runId = args.runId ?? newRunId();
    this.recovery = args.recovery;
    this.onClose = args.onClose;
    this.nextSeq = (this.events.at(-1)?.seq ?? 0) + 1;
    this.lastPublishedSeq = this.nextSeq - 1;
  }

  get health(): SessionHealth {
    return this.healthState;
  }

  get failedSignal(): AbortSignal {
    return this.failController.signal;
  }

  state(): SessionState {
    return foldEvents(this.events);
  }

  durableEvents(): readonly DurableEvent[] {
    return this.events;
  }

  emit<T extends DurableType>(
    type: T,
    payload: DurablePayload<T>,
    options: EmitOptions = {},
  ): Promise<DurableEvent<T>> {
    if (this.healthState === "failed") {
      return Promise.reject(new SessionError("session_failed", "会话已失败，不再写入日志"));
    }
    if (this.healthState === "closed") {
      return Promise.reject(new SessionError("session_closed", "会话已关闭"));
    }
    const event = {
      type,
      sessionId: this.id,
      seq: this.nextSeq,
      time: new Date().toISOString(),
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      payload,
    } as DurableEvent<T>;
    this.nextSeq += 1;
    const line = `${encodeDurableEvent(event)}\n`;

    // 单一写入通道：所有持久化事件按序追加。
    // 追加前重查健康状态——前序写入失败后不再追加（sessions.md 第 5 节）
    const write = this.writeChain.then(() => {
      if (this.healthState !== "ok") {
        throw new SessionError("session_failed", "会话已失败，不再写入日志");
      }
      return this.fs.appendFile(this.logPath, line);
    });
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );

    return write.then(
      () => {
        this.events.push(event);
        this.lastPublishedSeq = event.seq;
        this.publish(event);
        return event;
      },
      (cause: unknown) => {
        this.enterFailed(cause);
        throw new SessionError("session_failed", "日志写入失败", { cause });
      },
    );
  }

  emitEphemeral<T extends EphemeralType>(
    type: T,
    payload: EphemeralPayload<T>,
    options: EmitOptions = {},
  ): EphemeralEvent<T> {
    const event = {
      type,
      sessionId: this.id,
      runId: this.runId,
      eseq: this.nextEseq,
      afterSeq: this.lastPublishedSeq,
      time: new Date().toISOString(),
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      payload,
    } as EphemeralEvent<T>;
    this.nextEseq += 1;
    this.publish(event);
    return event;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  diagnostics(): readonly { event: RuntimeEvent; error: unknown }[] {
    return this.diag;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.healthState !== "closed" && (await this.fs.exists(this.logPath))) {
      await this.fs.fsync(this.logPath);
    }
  }

  async close(): Promise<void> {
    if (this.healthState === "closed") return;
    // 等待已排队的写入落定；failed 状态下不再写（sessions.md 第 5 节）
    await this.writeChain;
    this.healthState = "closed";
    this.listeners.clear();
    // 释放会话锁等资源；释放失败不影响关闭
    if (this.onClose !== undefined) await this.onClose().catch(() => undefined);
  }

  private publish(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // 订阅者不影响执行（events.md 第 6 节）：捕获并记录，继续分发
        if (this.diag.length < 100) this.diag.push({ event, error });
      }
    }
  }

  private enterFailed(cause: unknown): void {
    if (this.healthState === "failed") return;
    this.healthState = "failed";
    this.failController.abort(cause);
    // 通过临时事件通知客户端；不再写日志（sessions.md 第 5 节）
    try {
      this.emitEphemeral("runtime.error", {
        code: "session_failed",
        message: "日志写入失败，会话已进入 failed 状态",
      });
    } catch {
      // 订阅者异常不影响失败传播
    }
  }
}
