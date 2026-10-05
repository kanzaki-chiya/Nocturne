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
  private readonly exitListeners = new Set<(e: BackendExited) => void>();
  /** 同一项目并发 ensure 共享的打开中 Promise */
  private readonly pending = new Map<string, Promise<RpcClient>>();
  /** 新后台握手成功后通知：App 据此给每个 client 订阅 providersChanged */
  private readonly clientListeners = new Set<(client: RpcClient) => void>();
  /**
   * 由 propagateConfig 发起、对应的 providersChanged 还没到的 reloadConfig 个数。
   * 服务端先推通知再回响应，所以通知到达时计数一定还在；据此认出"回声"不再转发，
   * 避免后台之间互相触发成环。
   */
  private readonly echoes = new Map<RpcClient, number>();
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
        for (const listener of this.clientListeners) {
          try {
            listener(client);
          } catch {
            // 监听器异常不影响后台接入
          }
        }
        void transport.exited.then(({ code, stderr }) => {
          // 后台退出：从池中移除并通知（UI 显示"后台已退出"与重新连接）
          this.echoes.delete(client);
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

  /** 项目最后一个会话关闭后结束后台；主动退出不触发崩溃横幅。 */
  async release(workspace: string): Promise<void> {
    const key = projectKey(workspace);
    const pending = this.pending.get(key);
    if (pending !== undefined) await pending;
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.echoes.delete(entry.client);
    entry.client.close();
    await entry.transport.exited;
  }

  /** 该项目已握手的 client；没有运行中的后台返回 undefined */
  get(workspace: string): RpcClient | undefined {
    return this.entries.get(projectKey(workspace))?.client;
  }

  /** 任意一个运行中的 client；会话列表是全局的，用哪个后台查都一样 */
  any(): RpcClient | undefined {
    for (const entry of this.entries.values()) return entry.client;
    return undefined;
  }

  runningKeys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 配置协调（ADR-0046 2026-10-05 修订第 3 条）：origin 上的配置变了（收到它的
   * providersChanged，或它的 updateSettings 等写设置的请求成功），让其他已连接的后台
   * 各 reloadConfig 一次。后台之间不直接通信，Core 不感知多进程。
   */
  propagateConfig(origin: RpcClient): void {
    for (const entry of this.entries.values()) {
      const client = entry.client;
      if (client === origin) continue;
      this.echoes.set(client, (this.echoes.get(client) ?? 0) + 1);
      client.runtime.reloadConfig().catch(() => {
        // 失败时服务端没推通知（重载在推送之前抛错），把计数还回去；
        // 该后台继续用旧配置，下一次变更或重启时再同步
        this.consumeEcho(client);
      });
    }
  }

  /**
   * providersChanged 到达时调用：是 propagateConfig 引起的重载就消费一次计数并返回
   * true（调用方不再转发）；否则返回 false，说明这是该后台自己的变更。
   */
  consumeEcho(client: RpcClient): boolean {
    const pending = this.echoes.get(client) ?? 0;
    if (pending <= 0) return false;
    if (pending === 1) this.echoes.delete(client);
    else this.echoes.set(client, pending - 1);
    return true;
  }

  /** 每个新后台握手成功后回调一次（订阅 providersChanged 等全局通知用）。 */
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
