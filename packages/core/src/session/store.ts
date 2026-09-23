/**
 * SessionStore：create / load / list（sessions.md 第 2、4、8 节）。
 * Phase 1 不做：排他锁、损坏尾部截断、恢复修复——打开顺序与校验在此就位，
 * Phase 3 在标注的扩展点插入对应步骤。
 */
import { randomBytes } from "node:crypto";
import {
  decodeDurableEvent,
  EventParseError,
  LOG_FORMAT_VERSION,
  type DurableEvent,
} from "../protocol/index.js";
import type { FileSystem, PathOps } from "../platform/index.js";
import { fsErrorCode } from "../platform/index.js";
import { SessionError } from "./errors.js";
import { SessionImpl } from "./session.js";
import type { CreateSessionInput, Session, SessionStore, SessionSummary } from "./types.js";

/** 时间有序的会话 ID：可排序且冲突概率可忽略 */
function newSessionId(now = new Date()): string {
  const t = now.toISOString().replace(/[-:T]/g, "").slice(0, 12); // YYYYMMDDHHmm
  return `${t}-${randomBytes(4).toString("hex")}`;
}

export interface SessionStoreDeps {
  fs: FileSystem;
  paths: PathOps;
  /** 会话目录：<NOCTURNE_HOME>/sessions */
  sessionsDir: string;
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const { fs, paths, sessionsDir } = deps;

  function logPath(id: string): string {
    return paths.join(sessionsDir, `${id}.jsonl`);
  }

  async function loadEvents(id: string): Promise<DurableEvent[]> {
    let text: string;
    try {
      text = await fs.readTextFile(logPath(id));
    } catch (e) {
      if (fsErrorCode(e) === "ENOENT") {
        throw new SessionError("session_not_found", `会话不存在: ${id}`);
      }
      throw e;
    }
    const events: DurableEvent[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line === "") {
        // 只有文件末尾允许出现空段（结尾换行符之后）
        if (i !== lines.length - 1) {
          throw new SessionError("session_log_corrupt", `日志第 ${i + 1} 行为空`);
        }
        continue;
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
        // Phase 3：若损坏仅在最末一行，另存 <id>.jsonl.tail-<ts> 后物理截断
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
    // Phase 3 扩展点：第 4 节第 5 步——检查整条日志，对未结算调用补
    // tool.completed(interrupted)，对未结束 Turn 补 turn.completed(error,
    // process_exited, recovered)。
    return events;
  }

  return {
    async create(input: CreateSessionInput): Promise<Session> {
      await fs.mkdir(sessionsDir);
      const id = newSessionId();
      const path = logPath(id);
      // Phase 3 扩展点：先以排他方式创建 <id>.lock，再写第一行
      await fs.writeFile(path, "");
      const session = new SessionImpl({ id, logPath: path, fs, events: [] });
      await session.emit("session.created", {
        formatVersion: LOG_FORMAT_VERSION,
        nocturneVersion: input.nocturneVersion,
        cwd: input.cwd,
        workspaceRoot: input.workspaceRoot,
        model: input.model,
        permissionPreset: input.permissionPreset,
      });
      return session;
    },

    async load(id: string): Promise<Session> {
      // Phase 3 扩展点：先取得排他锁再读取（sessions.md 第 4 节顺序不可调换）
      const events = await loadEvents(id);
      return new SessionImpl({ id, logPath: logPath(id), fs, events });
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
          summaries.push({
            id: event.sessionId,
            createdAt: event.time,
            cwd: event.payload.cwd,
            workspaceRoot: event.payload.workspaceRoot,
            model: event.payload.model,
            mtimeMs: stat.mtimeMs,
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
