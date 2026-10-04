import { createRpcClient, type RpcClient } from "@nocturne/rpc/client";

import type { DesktopHost } from "./host";
import { projectKey } from "./session-tree";
import { TauriLineTransport } from "./transport";

export interface BackendExited {
  key: string;
  code: number | null;
  stderr: string[];
}

interface Entry {
  key: string;
  workspace: string;
  transport: TauriLineTransport;
  client: RpcClient;
}

/**
 * 后台池：按项目 key 保持一个 `nctrn rpc --stdio` 后台（ADR-0046 第 1 节）。
 * 后台退出时从池中移除并通知订阅者。
 */
export class BackendPool {
  private readonly host: DesktopHost;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<RpcClient>>();
  private readonly exitListeners = new Set<(e: BackendExited) => void>();

  constructor(host: DesktopHost) {
    this.host = host;
  }

  /** 该项目已有后台就复用；没有就打开后台 + 握手。并发调用共享同一次打开。 */
  ensure(workspace: string): Promise<RpcClient> {
    const key = projectKey(workspace);
    const existing = this.entries.get(key);
    if (existing !== undefined) return Promise.resolve(existing.client);
    const inflight = this.pending.get(key);
    if (inflight !== undefined) return inflight;

    const opening = (async (): Promise<RpcClient> => {
      const transport = await TauriLineTransport.open(this.host, workspace);
      try {
        const client = createRpcClient(transport, {
          clientName: "nocturne-desktop",
          interactive: true,
        });
        await client.initialize();
        const entry: Entry = { key, workspace, transport, client };
        this.entries.set(key, entry);
        void transport.exited.then(({ code, stderr }) => {
          // 后台退出：从池中移除并通知（UI 显示"后台已退出"与重新连接）
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
            for (const listener of this.exitListeners) {
              try {
                listener({ key, code, stderr });
              } catch {
                // 监听器异常不影响其他监听器
              }
            }
          }
        });
        return client;
      } catch (error) {
        // 握手失败（含 protocol_version_mismatch）：关闭后台，把错误抛给 UI
        transport.close();
        throw error;
      }
    })();

    this.pending.set(key, opening);
    // then(cleanup, cleanup)：失败时也走到清理且不产生未接住的 rejection
    const cleanup = () => {
      if (this.pending.get(key) === opening) this.pending.delete(key);
    };
    void opening.then(cleanup, cleanup);
    return opening;
  }

  /** 任意一个运行中的 client；会话列表是全局的，用哪个后台查都一样 */
  any(): RpcClient | undefined {
    for (const entry of this.entries.values()) return entry.client;
    return undefined;
  }

  runningKeys(): string[] {
    return [...this.entries.keys()];
  }

  onExit(listener: (e: BackendExited) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
}
