/**
 * SessionStore：create / load / list（sessions.md 第 2、4、8 节）。
 * 打开顺序不可调换：先取得排他锁，再读取、截断损坏尾部、校验、追加修复事件。
 */
import { randomBytes } from "node:crypto";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  EventParseError,
  LOG_FORMAT_VERSION,
  type DurableEvent,
} from "../protocol/index.js";
import { fsErrorCode, type Platform } from "../platform/index.js";
import { SessionError } from "./errors.js";
import { acquireSessionLock, lockLooksHeld, type SessionLock } from "./lock.js";
import { foldEvents } from "./fold.js";
import { SessionImpl } from "./session.js";
import type {
  CreateSessionInput,
  LoadSessionOptions,
  Session,
  SessionRecovery,
  SessionStore,
  SessionSummary,
} from "./types.js";

/** 时间有序的会话 ID：可排序且冲突概率可忽略 */
function newSessionId(now = new Date()): string {
  const t = now.toISOString().replace(/[-:T]/g, "").slice(0, 12); // YYYYMMDDHHmm
  return `${t}-${randomBytes(4).toString("hex")}`;
}

/** 修复事件的 turnId 归属：callId 属于哪个 Turn 的助手消息 */
interface UnsettledFix {
  callId: string;
  turnId: string;
  name: string;
  started: boolean;
}

export interface SessionStoreDeps {
  platform: Platform;
  /** 会话目录：<NOCTURNE_HOME>/sessions */
  sessionsDir: string;
}

interface LoadedLog {
  events: DurableEvent[];
  /** 截断的尾部另存文件名（仅文件名，不含目录） */
  truncatedTail?: string | undefined;
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const { platform, sessionsDir } = deps;
  const { fs, paths } = platform;

  function logPath(id: string): string {
    return paths.join(sessionsDir, `${id}.jsonl`);
  }
  function lockPath(id: string): string {
    return paths.join(sessionsDir, `${id}.lock`);
  }

  /**
   * 读取日志为字节 → 处理损坏尾部 → 逐行校验（sessions.md 第 4 节第 2、3 步）。
   * 损坏尾部：文件不以换行符结束，或最后一行无法解析为合法事件。
   * 尾部字节另存为 <id>.jsonl.tail-<ts>，然后物理截断日志。
   */
  async function loadEvents(id: string): Promise<LoadedLog> {
    let buf: Uint8Array;
    try {
      buf = await fs.readFile(logPath(id));
    } catch (e) {
      if (fsErrorCode(e) === "ENOENT") {
        throw new SessionError("session_not_found", `会话不存在: ${id}`);
      }
      throw e;
    }

    // 按 \n 切分，记录每行的字节偏移
    const lineOffsets: { start: number; end: number }[] = [];
    let cursor = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        lineOffsets.push({ start: cursor, end: i });
        cursor = i + 1;
      }
    }
    const endsClean = buf.length > 0 && buf[buf.length - 1] === 0x0a;
    if (cursor < buf.length) {
      // 最后一行无结尾换行符：写入中断过，无论内容是否可解析都按尾部处理
      lineOffsets.push({ start: cursor, end: buf.length });
    }

    const events: DurableEvent[] = [];
    let tailStart = -1;
    if (!endsClean && lineOffsets.length > 0) {
      // 未终止的最后一行无条件视为损坏尾部
      tailStart = lineOffsets.at(-1)?.start ?? -1;
      lineOffsets.pop();
    }
    for (let i = 0; i < lineOffsets.length; i++) {
      const range = lineOffsets[i];
      if (range === undefined) break;
      const { start, end } = range;
      const line = new TextDecoder().decode(buf.subarray(start, end));
      if (line === "") {
        throw new SessionError("session_log_corrupt", `日志第 ${i + 1} 行为空`);
      }
      let event: DurableEvent;
      try {
        event = decodeDurableEvent(line);
      } catch (e) {
        if (e instanceof EventParseError && e.code === "unknown_event_type") {
          throw new SessionError(
            "session_log_newer",
            `日志包含不认识的持久化事件类型: ${e.message}`,
            { cause: e },
          );
        }
        if (i === lineOffsets.length - 1 && tailStart === -1) {
          // 已终止但无法解析的最后一行同样算损坏尾部（sessions.md 第 4 节）
          tailStart = start;
          break;
        }
        throw new SessionError("session_log_corrupt", `日志第 ${i + 1} 行无法解析`, { cause: e });
      }
      if (event.seq !== events.length + 1) {
        throw new SessionError(
          "session_log_corrupt",
          `日志 seq 不连续：第 ${i + 1} 行 seq=${event.seq}，期望 ${events.length + 1}`,
        );
      }
      events.push(event);
    }

    let truncatedTail: string | undefined;
    if (tailStart >= 0) {
      const tailBytes = buf.subarray(tailStart);
      const tailName = `${id}.jsonl.tail-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.writeFile(paths.join(sessionsDir, tailName), tailBytes);
      await fs.truncate(logPath(id), tailStart);
      truncatedTail = tailName;
    }

    const first = events[0];
    if (first?.type !== "session.created") {
      throw new SessionError("session_log_corrupt", "日志第一行不是 session.created");
    }
    if (first.payload.formatVersion > LOG_FORMAT_VERSION) {
      throw new SessionError(
        "session_log_newer",
        `日志格式版本 ${first.payload.formatVersion} 高于支持的 ${LOG_FORMAT_VERSION}`,
      );
    }
    return { events, truncatedTail };
  }

  /**
   * 恢复修复（sessions.md 第 6 节）：未结算调用补 tool.completed(interrupted)，
   * 未结束 Turn 补 turn.completed(error/process_exited/recovered)。
   * 修复事件直接追加到日志（此刻还没有 Session 对象可 emit）。
   */
  async function repair(
    id: string,
    events: DurableEvent[],
  ): Promise<{ events: DurableEvent[]; recovery: SessionRecovery | undefined }> {
    const state = foldEvents(events);
    const fixes: UnsettledFix[] = [...state.unsettledCalls.values()];
    const openTurn = state.openTurn;
    if (fixes.length === 0 && openTurn === undefined) {
      return { events, recovery: undefined };
    }

    let seq = state.lastSeq;
    const appended: DurableEvent[] = [];
    const append = <T extends DurableEvent["type"]>(
      type: T,
      turnId: string | undefined,
      payload: Extract<DurableEvent, { type: T }>["payload"],
    ) => {
      seq += 1;
      appended.push({
        type,
        sessionId: id,
        seq,
        time: new Date().toISOString(),
        ...(turnId !== undefined ? { turnId } : {}),
        payload,
      } as DurableEvent);
    };

    for (const fix of fixes) {
      append("tool.completed", fix.turnId, {
        callId: fix.callId,
        name: fix.name,
        status: "interrupted",
        modelContent: fix.started ? "该工具可能已部分执行，请先检查当前状态再继续" : "工具未执行",
      });
    }
    if (openTurn !== undefined) {
      append("turn.completed", openTurn.turnId, {
        reason: "error",
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: { code: "process_exited", message: "进程在 Turn 结束前退出" },
        recovered: true,
      });
    }

    const text = appended.map((e) => `${encodeDurableEvent(e)}\n`).join("");
    await fs.appendFile(logPath(id), text);
    return {
      events: [...events, ...appended],
      recovery: {
        interruptedCalls: fixes.length,
        recoveredTurns: openTurn !== undefined ? 1 : 0,
      },
    };
  }

  return {
    async create(input: CreateSessionInput): Promise<Session> {
      await fs.mkdir(sessionsDir);
      const id = newSessionId();
      const lock = await acquireSessionLock(fs, platform, lockPath(id));
      try {
        await fs.writeFile(logPath(id), "");
        const session = new SessionImpl({
          id,
          logPath: logPath(id),
          fs,
          events: [],
          onClose: () => lock.release(),
        });
        await session.emit("session.created", {
          formatVersion: LOG_FORMAT_VERSION,
          nocturneVersion: input.nocturneVersion,
          cwd: input.cwd,
          workspaceRoot: input.workspaceRoot,
          model: input.model,
          permissionPreset: input.permissionPreset,
        });
        return session;
      } catch (e) {
        await lock.release();
        throw e;
      }
    },

    async load(id: string, options: LoadSessionOptions = {}): Promise<Session> {
      // 先锁后读（sessions.md 第 4 节顺序不可调换）
      const lock: SessionLock = await acquireSessionLock(fs, platform, lockPath(id), options);
      try {
        const loaded = await loadEvents(id);
        const repaired = await repair(id, loaded.events);
        const recovery: SessionRecovery | undefined =
          repaired.recovery !== undefined || loaded.truncatedTail !== undefined
            ? {
                interruptedCalls: repaired.recovery?.interruptedCalls ?? 0,
                recoveredTurns: repaired.recovery?.recoveredTurns ?? 0,
                ...(loaded.truncatedTail !== undefined
                  ? { truncatedTail: loaded.truncatedTail }
                  : {}),
              }
            : undefined;
        return new SessionImpl({
          id,
          logPath: logPath(id),
          fs,
          events: repaired.events,
          ...(recovery !== undefined ? { recovery } : {}),
          onClose: () => lock.release(),
        });
      } catch (e) {
        await lock.release();
        throw e;
      }
    },

    async list(filter = {}): Promise<SessionSummary[]> {
      let entries;
      try {
        entries = await fs.readdir(sessionsDir);
      } catch (e) {
        if (fsErrorCode(e) === "ENOENT") return [];
        throw e;
      }
      const summaries: SessionSummary[] = [];
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".jsonl")) continue;
        try {
          const text = await fs.readTextFile(entry.path);
          const firstLine = text.split("\n", 1)[0] ?? "";
          const event = decodeDurableEvent(firstLine);
          if (event.type !== "session.created") continue;
          if (filter.cwd !== undefined && !paths.equals(event.payload.cwd, filter.cwd)) {
            continue;
          }
          const stat = await fs.stat(entry.path);
          const id = entry.name.slice(0, -".jsonl".length);
          summaries.push({
            id: event.sessionId,
            createdAt: event.time,
            cwd: event.payload.cwd,
            workspaceRoot: event.payload.workspaceRoot,
            model: event.payload.model,
            mtimeMs: stat.mtimeMs,
            locked: await lockLooksHeld(fs, platform, lockPath(id)),
          });
        } catch {
          // 列表是只读操作：单个损坏文件不阻塞其他会话
        }
      }
      summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return summaries;
    },
  };
}
