/**
 * 当前会话的子代理目录（ADR-0060 修订（五）第 1、3、4 条）：`runtime.listSubagents` 的
 * 查询结果和刷新节奏。
 *
 * - 进入会话、后台重连、窗口回到前台、离开设置页、打开概览浮层时查一次；
 * - 父 task 的 started / progress / completed 触发合并查询（trigger），不解析 progress 文本；
 * - 存在未结算的内置 task 时，补查每秒至多一次，请求不重叠——覆盖 started 先于 child 创建、
 *   进度漏收和短任务已结束的竞态；
 * - 只在「当前会话的窗口前台、document 可见、不在设置里、连着后台」时查询；窗口后台、进设置、
 *   切会话、断线、卸载都停止补查，在途请求的响应一律丢弃（代数过期）。
 *
 * 不依赖 React；界面经 subscribe / getVersion 读取。
 */
import type { SubagentSummary } from "@nocturne/core/protocol";

export interface DirectoryRuntime {
  listSubagents(parent: string): Promise<SubagentSummary[]>;
}

export interface DirectoryContext {
  runtime: DirectoryRuntime | undefined;
  /** 当前显示的会话；首页和新建会话页为 null */
  sessionId: string | null;
  /** document 可见（窗口没有最小化、没有被切到后台） */
  visible: boolean;
  settingsOpen: boolean;
  /** 父视图里存在未结算的内置 task：需要每秒补查 */
  pollNeeded: boolean;
}

/** 补查的最小间隔（毫秒） */
export const DIRECTORY_POLL_MS = 1000;

export class SubagentDirectory {
  private ctx: DirectoryContext = {
    runtime: undefined,
    sessionId: null,
    visible: true,
    settingsOpen: false,
    pollNeeded: false,
  };
  private summaries_: readonly SubagentSummary[] = [];
  private loaded_ = false;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  /** 每次停用或换会话/连接递增：过期请求的响应被丢弃 */
  private generation = 0;
  private inflight = false;
  /** 失焦/切会话会使旧请求失效，但同一后台仍须等它落定，避免重复 I/O */
  private readonly pending = new WeakSet<DirectoryRuntime>();
  private dirty = false;
  private lastStart = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getVersion = (): number => this.version;

  /** 当前会话的子代理摘要（含已结束），按开始时间升序 */
  get summaries(): readonly SubagentSummary[] {
    return this.summaries_;
  }
  /** 当前会话至少查询成功过一次 */
  get loaded(): boolean {
    return this.loaded_;
  }

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  private get active(): boolean {
    const { runtime, sessionId, visible, settingsOpen } = this.ctx;
    return (
      !this.disposed && runtime !== undefined && sessionId !== null && visible && !settingsOpen
    );
  }

  /** 每次渲染后同步最新上下文；只有真正变化才触发动作 */
  setContext(next: DirectoryContext): void {
    const prev = this.ctx;
    this.ctx = next;
    const wasActive = this.activeFor(prev);
    const identityChanged = prev.runtime !== next.runtime || prev.sessionId !== next.sessionId;
    if (identityChanged) {
      // 换会话或换后台连接：旧结果不属于这里了
      this.generation += 1;
      this.inflight = false;
      this.dirty = false;
      this.clearTimer();
      if (this.summaries_.length > 0 || this.loaded_) {
        this.summaries_ = [];
        this.loaded_ = false;
        this.bump();
      }
    } else if (wasActive && !this.active) {
      // 窗口后台 / 进设置：停止补查并丢弃在途响应
      this.generation += 1;
      this.inflight = false;
      this.dirty = false;
      this.clearTimer();
    }
    if (this.active && (identityChanged || !wasActive)) {
      this.refresh();
    } else if (this.active) {
      if (
        next.pollNeeded ||
        this.summaries_.some((item) => item.background && item.state === "running")
      )
        this.schedule();
      else this.clearTimer();
    }
  }

  private activeFor(ctx: DirectoryContext): boolean {
    return (
      !this.disposed &&
      ctx.runtime !== undefined &&
      ctx.sessionId !== null &&
      ctx.visible &&
      !ctx.settingsOpen
    );
  }

  /** 事件触发或打开概览：合并查询。查询在途时只记一次「再查一次」 */
  trigger(): void {
    if (!this.active) return;
    this.refresh();
  }

  private refresh(): void {
    if (!this.active) return;
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    const { runtime, sessionId } = this.ctx;
    if (runtime === undefined || sessionId === null) return;
    if (this.pending.has(runtime)) {
      this.dirty = true;
      return;
    }
    this.clearTimer();
    this.inflight = true;
    this.pending.add(runtime);
    this.dirty = false;
    this.lastStart = Date.now();
    const generation = this.generation;
    runtime.listSubagents(sessionId).then(
      (list) => {
        this.pending.delete(runtime);
        if (generation !== this.generation) {
          if (this.active && this.ctx.runtime === runtime && this.dirty) this.refresh();
          return;
        }
        this.inflight = false;
        this.summaries_ = list;
        this.loaded_ = true;
        this.bump();
        this.afterQuery();
      },
      () => {
        this.pending.delete(runtime);
        if (generation !== this.generation) {
          if (this.active && this.ctx.runtime === runtime && this.dirty) this.refresh();
          return;
        }
        // 查询失败保留旧结果；下一次触发或补查再试
        this.inflight = false;
        this.afterQuery();
      },
    );
  }

  private afterQuery(): void {
    if (!this.active) return;
    if (this.dirty) {
      this.dirty = false;
      this.refresh();
      return;
    }
    this.schedule();
  }

  /** 有未结算 task 时，距离上次开始至少 1 秒再补查一次 */
  private schedule(): void {
    if (
      !this.active ||
      (!this.ctx.pollNeeded &&
        !this.summaries_.some((item) => item.background && item.state === "running")) ||
      this.inflight ||
      this.timer !== undefined
    )
      return;
    const wait = Math.max(0, this.lastStart + DIRECTORY_POLL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 卸载：停补查、丢弃在途响应。StrictMode 会在同一实例上先卸载再挂载，所以可 revive */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.inflight = false;
    this.dirty = false;
    this.clearTimer();
  }

  /** 卸载后重新挂载（StrictMode）：被丢弃的在途查询要补回来 */
  revive(): void {
    this.disposed = false;
    if (this.active) this.refresh();
  }
}
