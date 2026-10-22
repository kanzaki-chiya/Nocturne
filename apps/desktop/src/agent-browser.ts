/**
 * 面板浏览器 · 桌面内置（desktop-browser.md）的前端状态：
 * - 订阅外壳的 watch 通道，得到 agent 标签的可见状态（标题、地址、活动、接管）；
 * - 把 agent 标签合进当前会话的面板（不持久化，刷新页面即由外壳重建）；
 * - 主界面向外壳报告 UI 状态，让外壳把正在显示的 agent webview 放到面板占位区，
 *   其余移到可见区域之外；
 * - present 消息：`open` 在所属会话正显示在前台时切到新标签，布局完成后确认。
 *
 * 这里不接触 bearer、网页正文或截图字节；截图经工具结果附件显示。
 */
import type {
  AgentBrowserHost,
  AgentTabInfo,
  AgentUiState,
  AgentWatchMessage,
  AgentWatchSnapshot,
} from "./host";
import type { BrowserTab, PanelTab, SessionPanel } from "./side-panel";

export const EMPTY_SNAPSHOT: AgentWatchSnapshot = {
  shellGeneration: 0,
  revision: 0,
  enabled: false,
  tabs: [],
};

/** agent 标签在面板里的 id：与外壳 tabId 一一对应，避免和用户的浏览器标签撞 id */
export function agentPanelTabId(tabId: string): string {
  return `agent:${tabId}`;
}

export function agentTabOf(info: AgentTabInfo): BrowserTab {
  return {
    id: agentPanelTabId(info.tabId),
    kind: "browser",
    url: info.url,
    ...(info.title !== "" ? { title: info.title } : {}),
    agent: info,
  };
}

/** 当前会话的 agent 标签（按外壳给的顺序） */
export function agentTabsFor(
  snapshot: AgentWatchSnapshot,
  sessionId: string | null,
): AgentTabInfo[] {
  if (sessionId === null) return [];
  return snapshot.tabs.filter((tab) => tab.rootSessionId === sessionId && tab.live);
}

/**
 * 把当前会话的 agent 标签合进面板：新增的追加到末尾，已有更新标题/地址/状态，
 * 外壳关掉的移除。不做持久化（storeSessionPanel 会跳过 agent 标签）。
 */
export function syncAgentTabs(panel: SessionPanel, desired: readonly AgentTabInfo[]): SessionPanel {
  const wanted = new Map(desired.map((info) => [agentPanelTabId(info.tabId), info]));
  const kept: PanelTab[] = [];
  let changed = false;
  for (const tab of panel.tabs) {
    if (tab.kind !== "browser" || tab.agent === undefined) {
      kept.push(tab);
      continue;
    }
    const info = wanted.get(tab.id);
    if (info === undefined) {
      changed = true;
      continue;
    }
    wanted.delete(tab.id);
    const next = agentTabOf(info);
    if (
      tab.url !== next.url ||
      tab.title !== next.title ||
      tab.agent.state !== info.state ||
      tab.agent.operation !== info.operation ||
      tab.agent.notice !== info.notice ||
      (tab.agent.dialog?.message ?? "") !== (info.dialog?.message ?? "")
    ) {
      changed = true;
      kept.push(next);
    } else {
      kept.push(tab);
    }
  }
  for (const info of wanted.values()) {
    kept.push(agentTabOf(info));
    changed = true;
  }
  if (!changed) return panel;
  const activeExists = kept.some((tab) => tab.id === panel.activeId);
  return {
    ...panel,
    tabs: kept,
    activeId: activeExists ? panel.activeId : (kept[0]?.id ?? ""),
  };
}

/** 面板里除了 agent 之外的标签（切换会话时清理别的会话的 agent 标签用） */
export function withoutAgentTabs(panel: SessionPanel): SessionPanel {
  const tabs = panel.tabs.filter((tab) => !(tab.kind === "browser" && tab.agent !== undefined));
  if (tabs.length === panel.tabs.length) return panel;
  return {
    ...panel,
    tabs,
    activeId: tabs.some((tab) => tab.id === panel.activeId) ? panel.activeId : (tabs[0]?.id ?? ""),
  };
}

/** 面板当前标签里的 agent 信息（uiState 用） */
export function activeAgent(panel: SessionPanel | undefined): AgentTabInfo | undefined {
  const tab = panel?.tabs.find((item) => item.id === panel.activeId);
  return tab?.kind === "browser" ? tab.agent : undefined;
}

export type PresentListener = (present: { operationId: string; tabId: string }) => void;

/** 外壳 watch 通道的客户端：一个窗口一份，订阅者同步拿快照。 */
export class AgentBrowserStore {
  private snapshot: AgentWatchSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly presentListeners = new Set<PresentListener>();
  private started = false;
  /** present 正在等布局确认的标签 */
  private pendingPresent: { operationId: string; tabId: string } | undefined;

  constructor(private readonly host: AgentBrowserHost | undefined) {}

  start(): void {
    if (this.started || this.host === undefined) return;
    this.started = true;
    void this.host
      .watch((message) => {
        this.receive(message);
      })
      .then(
        (snapshot) => {
          this.apply(snapshot);
        },
        () => undefined,
      );
  }

  dispose(): void {
    this.listeners.clear();
    this.presentListeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.snapshot.revision;

  get(): AgentWatchSnapshot {
    return this.snapshot;
  }

  enabled(): boolean {
    return this.snapshot.enabled;
  }

  tabs(): AgentTabInfo[] {
    return this.snapshot.tabs;
  }

  onPresent(listener: PresentListener): () => void {
    this.presentListeners.add(listener);
    return () => {
      this.presentListeners.delete(listener);
    };
  }

  /** 当前等待布局确认的 present（前端确认一次就清） */
  takePendingPresent(): { operationId: string; tabId: string } | undefined {
    const pending = this.pendingPresent;
    this.pendingPresent = undefined;
    return pending;
  }

  pending(): { operationId: string; tabId: string } | undefined {
    return this.pendingPresent;
  }

  private apply(snapshot: AgentWatchSnapshot): void {
    if (snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot;
    this.emit();
  }

  private receive(message: AgentWatchMessage): void {
    if (message.kind === "present") {
      if (message.revision < this.snapshot.revision) return;
      this.pendingPresent = { operationId: message.operationId, tabId: message.tabId };
      for (const listener of this.presentListeners) {
        listener({ operationId: message.operationId, tabId: message.tabId });
      }
      return;
    }
    if (message.kind === "tabs") {
      if (message.revision < this.snapshot.revision) return;
      this.snapshot = {
        shellGeneration: message.shellGeneration,
        revision: message.revision,
        enabled: this.snapshot.enabled,
        tabs: message.tabs,
      };
      this.emit();
      return;
    }
    // operation：只更新对应标签的活动文案，不重排
    if (message.revision < this.snapshot.revision) return;
    const operation = message.state === "started" ? message.operation : undefined;
    this.snapshot = {
      ...this.snapshot,
      revision: message.revision,
      tabs: this.snapshot.tabs.map((tab) =>
        tab.tabId === message.tabId ? { ...tab, operation } : tab,
      ),
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  async uiState(ui: AgentUiState): Promise<void> {
    if (this.host === undefined) return;
    try {
      await this.host.uiState(ui);
    } catch {
      // 外壳不在（测试/旧版本）：布局失败不影响界面
    }
  }

  async presented(input: {
    shellGeneration: number;
    operationId: string;
    tabId: string;
    layoutVersion: number;
  }): Promise<void> {
    if (this.host === undefined) return;
    try {
      await this.host.presented(input);
    } catch {
      // present 已经超时：外壳自己会回收预留
    }
  }

  async control(
    tabId: string,
    action: "takeover" | "return" | "close",
  ): Promise<string | undefined> {
    if (this.host === undefined) return undefined;
    try {
      const result = await this.host.control(tabId, action);
      return result.state;
    } catch {
      return undefined;
    }
  }
}
