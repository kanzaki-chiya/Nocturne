/**
 * 会话级非交互（ADR-0064 第 5、6 节，permissions.md 第 7 节）。
 *
 * 调度器发起的会话没有人在看：第一轮（调度器提交的那一轮）按非交互处理，
 * 复用权限层现有的 `non_interactive` 拒绝。之后只要有客户端提交了新的用户消息，
 * 会话就转为交互并不再变回去。是否已转为交互只由日志推出——
 * 持久日志里的 `message.user` 条数（rewind 不删日志事件），不新增事件，
 * 会话关闭再打开后结论不变。
 */

/** 无人值守会话里非交互拒绝的附加指引（ADR-0064 第 5 节） */
export const UNATTENDED_DENY_HINT =
  "这是无人值守的定时任务，无法请求确认；被拒绝的操作请在最终回复中列出，由用户之后处理";

export interface AttendanceOptions {
  /** Runtime 本身是否交互；非交互的 Runtime 里不会有交互会话 */
  runtimeInteractive: boolean;
  /** 会话是否以无人值守方式创建（`interactive: false` 或带定时任务来源） */
  unattended: boolean;
  /** 日志里已有的 `message.user` 条数 */
  userMessageCount: () => number;
}

/**
 * 返回「此刻会话是否交互」的读取函数，交给权限 gate 与提问通道。
 * 调度器提交的那一条是第 1 条用户消息；出现第 2 条即说明有客户端接管。
 */
export function createAttendance(options: AttendanceOptions): () => boolean {
  let attended = false;
  return () => {
    if (!options.runtimeInteractive) return false;
    if (!options.unattended || attended) return true;
    if (options.userMessageCount() >= 2) attended = true;
    return attended;
  };
}
