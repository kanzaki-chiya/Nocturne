import { createRpcClient, type RpcClient } from "@nocturne/rpc/client";

import type { DesktopHost } from "./host";
import { DesktopError, TauriLineTransport } from "./transport";

export interface BackendExited {
  /** 后台启动时的工作区：「重启后台」时复用 */
  workspace: string;
  code: number | null;
  /** closed 消息携带的 stderr 尾部（缓冲随进程回收后只有这里有） */
  stderr: string[];
}

interface Entry {
  workspace: string;
  transport: TauriLineTransport;
  client: RpcClient;
}

/**
 * 单后台（ADR-0051）：整个窗口只有一个常驻 `nctrn rpc --stdio` 进程，
 * 所有项目与普通对话会话共用；会话的工作区随 createSession/resumeSession
 * 的日志元数据走，不再按项目起后台。后台退出时清空条目并通知订阅者。
 */
export class BackendPool {
  private readonly host: DesktopHost;
  private entry: Entry | undefined;
  private readonly exitListeners = new Set<(e: BackendExited) => void>();
  /** 并发 ensure 共享的打开中 Promise */
  private pending: Promise<RpcClient> | undefined;
  /** 新后台握手成功后通知：App 据此给 client 订阅 providersChanged */
  private readonly clientListeners = new Set<(client: RpcClient) => void>();
  constructor(host: DesktopHost) {
    this.host = host;
  }

  /**
   * 后台在跑就复用同一个 client；没在跑才以 workspace 为进程 cwd 启动 +
   * 握手。workspace 只是后台进程的启动目录（缺省工作区），会话各自的
   * cwd/workspaceRoot 由调用方经会话参数携带，与这里无关。
   */
  ensure(workspace: string): Promise<RpcClient> {
    if (this.entry !== undefined) return Promise.resolve(this.entry.client);
    if (this.pending !== undefined) return this.pending;

    const opening = (async (): Promise<RpcClient> => {
      const transport = await TauriLineTransport.open(this.host, workspace);
      try {
        const client = createRpcClient(transport, {
          clientName: "nocturne-desktop",
          interactive: true,
        });
        await client.initialize();
        const entry: Entry = { workspace, transport, client };
        this.entry = entry;
        for (const listener of this.clientListeners) {
          try {
            listener(client);
          } catch {
            // 监听器异常不影响后台接入
          }
        }
        void transport.exited.then(({ code, stderr }) => {
          // 后台退出：只清当前这一代（重启过的旧后台退出不影响新条目）
          if (this.entry === entry) {
            this.entry = undefined;
            for (const listener of this.exitListeners) {
              try {
                listener({ workspace: entry.workspace, code, stderr });
              } catch {
                // 监听器异常不影响其他监听器
              }
            }
          }
        });
        return client;
      } catch (error) {
        // 握手失败（含 protocol_version_mismatch、后台秒退）：关闭后台，并把
        // 进程退出码与 stderr 尾部带进错误——否则横幅只看到"连接已断开"，
        // 后台为什么没起来无从排查。
        transport.close();
        const { code, stderr } = await transport.exited;
        const tail = stderr.slice(-5).filter((line) => line.trim() !== "");
        if (tail.length > 0 && error instanceof Error) {
          const exitNote = code === null ? "" : `（退出码 ${code}）`;
          throw new DesktopError("backend_died", `${error.message}${exitNote}\n${tail.join("\n")}`);
        }
        throw error;
      }
    })();

    this.pending = opening;
    // then(cleanup, cleanup)：失败时也走到清理且不产生未接住的 rejection
    const cleanup = () => {
      if (this.pending === opening) this.pending = undefined;
    };
    void opening.then(cleanup, cleanup);
    return opening;
  }

  /** 已握手的 client；后台没在跑返回 undefined */
  get(): RpcClient | undefined {
    return this.entry?.client;
  }

  /** 运行中后台的快照：「后台日志」页的后台条目数据；没在跑返回 undefined */
  current(): { workspace: string; backendId: number } | undefined {
    if (this.entry === undefined) return undefined;
    return { workspace: this.entry.workspace, backendId: this.entry.transport.backendId };
  }

  /** 新后台握手成功后回调一次（订阅 providersChanged 等全局通知用）。 */
  onClient(listener: (client: RpcClient) => void): () => void {
    this.clientListeners.add(listener);
    return () => {
      this.clientListeners.delete(listener);
    };
  }

  onExit(listener: (e: BackendExited) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
}
