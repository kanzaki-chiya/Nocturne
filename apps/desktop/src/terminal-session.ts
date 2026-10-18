/**
 * 面板终端的进程生命周期（ADR-0060 第 4 节），与 xterm 无关、可单测：
 * 一个标签一个进程；换 shell 或「重新启动」先结束旧进程再开新的；
 * 进程退出后给出退出码；标签关闭（dispose）时结束进程。
 * 旧进程迟到的输出与退出消息按代次丢弃，不会混进新进程的屏幕。
 *
 * 开进程期间的输入先排队：ConPTY 启动时先发 `ESC[6n` 查光标位置，xterm.js 自动回答，
 * 这条回答可能在 terminal_open 返回 id 之前产生；丢掉它 shell 就一直停在启动阶段。
 */
import type { TerminalHost, TerminalMessage } from "./host";

export type TerminalStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number | undefined }
  | { kind: "error"; message: string };

export interface TerminalSink {
  output: (data: string) => void;
  status: (status: TerminalStatus) => void;
}

export interface TerminalLaunch {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}

export class TerminalSession {
  private generation = 0;
  private id: number | undefined;
  private disposed = false;
  private size = { cols: 80, rows: 24 };
  /** 开进程期间（还没拿到 id）的输入；拿到 id 后按顺序发出 */
  private queued: string[] | undefined;

  constructor(
    private readonly host: TerminalHost,
    private readonly sink: TerminalSink,
  ) {}

  /** 当前进程 id（测试用）；没有在跑时 undefined */
  get processId(): number | undefined {
    return this.id;
  }

  /** 开进程；已有进程时先结束它（换 shell、重新启动都走这里） */
  async start(launch: TerminalLaunch): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.size = { cols: launch.cols, rows: launch.rows };
    const previous = this.id;
    this.id = undefined;
    this.queued = [];
    if (previous !== undefined) await this.host.close(previous).catch(() => undefined);
    // dispose 也会推进代次：代次变了就是被换掉或标签已关
    if (generation !== this.generation) return;
    this.sink.status({ kind: "starting" });
    const onMessage = (message: TerminalMessage) => {
      if (generation !== this.generation) return;
      if (message.kind === "output") {
        this.sink.output(message.data);
      } else {
        this.id = undefined;
        this.queued = undefined;
        this.sink.status({ kind: "exited", code: message.code ?? undefined });
      }
    };
    let id: number;
    try {
      id = await this.host.open({ ...launch, ...this.size }, onMessage);
    } catch (error) {
      if (generation === this.generation) {
        this.queued = undefined;
        this.sink.status({
          kind: "error",
          message: error instanceof Error ? error.message : errorText(error),
        });
      }
      return;
    }
    if (generation !== this.generation) {
      // 开的过程中被换掉或标签已关：这个进程没人要了
      await this.host.close(id).catch(() => undefined);
      return;
    }
    this.id = id;
    for (const data of this.takeQueued()) void this.host.write(id, data).catch(() => undefined);
    this.sink.status({ kind: "running" });
  }

  private takeQueued(): string[] {
    const queued = this.queued ?? [];
    this.queued = undefined;
    return queued;
  }

  write(data: string): void {
    if (this.id === undefined) {
      this.queued?.push(data);
      return;
    }
    void this.host.write(this.id, data).catch(() => undefined);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    if (this.id === undefined) return;
    void this.host.resize(this.id, cols, rows).catch(() => undefined);
  }

  /** 标签关闭：结束进程，之后的消息全部丢弃 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const id = this.id;
    this.id = undefined;
    this.queued = undefined;
    if (id !== undefined) void this.host.close(id).catch(() => undefined);
  }
}

/** 外壳命令的错误是 { code, message } 对象，不是 Error */
function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error;
    if (typeof message === "string") return message;
  }
  return String(error);
}
