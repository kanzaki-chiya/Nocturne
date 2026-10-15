import { createSessionView, type SessionView } from "@nocturne/core/protocol";
import {
  trackSessionView,
  type RpcClient,
  type RpcSession,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import { conversationStatus } from "../conversations";
import { projectKey, type SessionSummary, type SessionStatus } from "../session-tree";

export interface PhoneSession {
  session: RpcSession;
  client: RpcClient;
  workspace: string;
  view: SessionView;
  tracker?: SessionViewTracker;
  dead: boolean;
}
export function phoneStatus(entry: PhoneSession): SessionStatus {
  return conversationStatus({ view: entry.view, busy: false });
}
export function knownWorkspaces(list: SessionSummary[]): string[] {
  const paths = new Map<string, string>();
  for (const s of list)
    if (!s.parent) {
      paths.set(projectKey(s.cwd), s.cwd);
      paths.set(projectKey(s.workspaceRoot), s.workspaceRoot);
    }
  return [...paths.values()];
}
export class PhoneSessions {
  readonly opened = new Map<string, PhoneSession>();
  list: SessionSummary[] = [];
  /** 本次连接已拿到会话列表 */
  loaded = false;
  client: RpcClient | undefined;
  private generation = 0;
  private readonly opening = new Map<string, Promise<PhoneSession>>();
  private tracked: Promise<void> = Promise.resolve();
  constructor(private readonly changed: () => void) {}
  async connected(client: RpcClient): Promise<void> {
    this.client = client;
    const generation = ++this.generation;
    for (const [id, entry] of this.opened) {
      const result = await client.runtime.resumeSession(id);
      if (generation !== this.generation) return;
      await this.attach(client, result.session, entry.workspace, entry.view);
    }
    await this.refresh();
  }
  disconnected(): void {
    this.generation++;
    this.loaded = false;
    this.opening.clear();
    this.client = undefined;
    for (const entry of this.opened.values()) entry.dead = true;
    this.changed();
  }
  clear(): void {
    this.generation++;
    this.loaded = false;
    this.opening.clear();
    this.client = undefined;
    this.opened.clear();
    this.list = [];
    this.changed();
  }
  async refresh(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    if (!client) return;
    const list = await client.runtime.listSessions();
    if (generation !== this.generation) return;
    this.list = list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.loaded = true;
    this.changed();
    this.tracked = this.track(list.filter((item) => item.locked));
  }
  /**
   * 点开推送后要去的会话：推送无载荷，只能在连上后判断。等后台订阅完成，
   * 优先最近一个等待确认或回答的会话，没有就取最近有动静的会话（完成、出错类提醒）。
   */
  async attentionTarget(): Promise<string | undefined> {
    await this.tracked;
    const pending = this.list.find((item) => {
      const entry = this.opened.get(item.id);
      return (
        !!entry && !entry.dead && !!(entry.view.pendingPermission ?? entry.view.pendingQuestion)
      );
    });
    return (pending ?? this.list[0])?.id;
  }
  // 没有锁的会话不可能在运行，点开时再订阅；全部回放会让上百个会话的电脑迟迟连不上。
  // 锁只说明后台持有会话，不代表正在运行；在后台订阅同一视图判定准确状态，不阻塞连接。
  private async track(items: SessionSummary[]): Promise<void> {
    const generation = this.generation;
    for (const item of items) {
      if (generation !== this.generation) return;
      if (!this.opened.has(item.id)) await this.open(item.id).catch(() => undefined);
    }
  }
  private async attach(
    client: RpcClient,
    session: RpcSession,
    workspace: string,
    view = createSessionView(),
  ): Promise<PhoneSession> {
    const entry: PhoneSession = { client, session, workspace, view, dead: false };
    this.opened.set(session.id, entry);
    entry.tracker = await trackSessionView(
      session,
      () => {
        this.changed();
      },
      {
        view,
        afterSeq: view.lastSeq,
      },
    );
    this.changed();
    return entry;
  }
  async open(id: string): Promise<PhoneSession> {
    const old = this.opened.get(id);
    if (old && !old.dead) return old;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const client = this.requireClient();
    const generation = this.generation;
    const item = this.list.find((s) => s.id === id);
    const run = (async () => {
      const { session } = await client.runtime.resumeSession(id);
      if (generation !== this.generation) throw new Error("电脑连接已切换");
      return this.attach(client, session, item?.cwd ?? "", old?.view);
    })();
    this.opening.set(id, run);
    try {
      return await run;
    } finally {
      if (this.opening.get(id) === run) this.opening.delete(id);
    }
  }
  async create(workspace: string): Promise<PhoneSession> {
    if (!knownWorkspaces(this.list).includes(workspace))
      throw new Error("请选择会话列表中已有的工作区");
    const client = this.requireClient();
    const model = await client.runtime.defaultModel({ workspaceRoot: workspace });
    if (!model) throw new Error("电脑未设置默认模型，请在电脑上选择默认模型");
    const { session } = await client.runtime.createSession({
      model,
      cwd: workspace,
      workspaceRoot: workspace,
    });
    return this.attach(client, session, workspace);
  }
  private requireClient(): RpcClient {
    if (!this.client) throw new Error("电脑尚未连接，请稍后重试");
    return this.client;
  }
}
