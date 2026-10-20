/**
 * 面板内置浏览器的 webview 池（ADR-0060 第 5 节、desktop.md 5.10）：每个浏览器标签按需
 * 创建一个外壳子 webview；同时存活的至多 MAX_LIVE_BROWSERS 个，超出时回收最久没显示的
 * 后台标签（只保留地址，再显示时重新加载）。关闭标签、删除会话时销毁。
 *
 * 同一个标签的外壳命令按顺序排队：创建是异步的，之后的布局、导航等它拿到 id 再发。
 * 连续的布局只发最后一次。只由 PanelHost / BrowserPane 使用，手机网页版不打进来。
 */
import type { BrowserAction, BrowserBounds, BrowserHost, BrowserMessage } from "./host";

export const MAX_LIVE_BROWSERS = 5;
/** 「已下载」提示显示这么久后自动消失 */
export const NOTICE_HIDE_MS = 4000;

/**
 * 工具栏下方的提示：被拦下的导航或下载。只显示最近的一条，新的替换旧的；
 * 拦截提示在下一次开始加载时清掉，「已下载」几秒后自动消失（autoHide）。
 */
export interface BrowserNotice {
  kind: "blocked" | "download";
  text: string;
  alert: boolean;
  autoHide: boolean;
  /** 每条提示一个序号：关闭和自动消失只作用于这一条 */
  seq: number;
}

/** 下载消息的提示文案 */
export function downloadNotice(
  state: "started" | "finished" | "failed",
  name: string,
): Pick<BrowserNotice, "text" | "alert" | "autoHide"> {
  switch (state) {
    case "started":
      return { text: `正在下载 ${name}`, alert: false, autoHide: false };
    case "finished":
      return { text: `已下载 ${name}`, alert: false, autoHide: true };
    case "failed":
      return { text: `下载失败：${name}`, alert: true, autoHide: false };
  }
}

export interface BrowserStatus {
  url: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  /** 网站图标的 object URL；没有时 undefined */
  favicon?: string | undefined;
  /** 工具栏下方的提示（BrowserNotice） */
  notice?: BrowserNotice | undefined;
  /** 创建或导航失败的说明 */
  error?: string | undefined;
  /** 外壳里有没有对应的 webview（被回收或还没显示过时为 false） */
  live: boolean;
}

export interface BrowserPoolEvents {
  /** 网页地址变了：PanelHost 写回标签（重启恢复用） */
  onUrl: (tabId: string, url: string) => void;
  onTitle: (tabId: string, title: string) => void;
  /** target=_blank / window.open：在本会话新开一个浏览器标签 */
  onNewWindow: (tabId: string, url: string) => void;
  /** 焦点在网页里时按下的应用快捷键：和焦点在主界面时一样处理 */
  onShortcut: (key: "b" | "t" | "p" | "backquote") => void;
}

interface Entry {
  tabId: string;
  status: BrowserStatus;
  /** 外壳 webview id；undefined = 不存活 */
  id?: number | undefined;
  /** 每次创建递增：被回收的旧 webview 迟到的消息丢掉 */
  generation: number;
  /** 排队中的外壳命令 */
  chain: Promise<void>;
  visible: boolean;
  /** 想要的位置；null = 隐藏 */
  bounds: BrowserBounds | null;
  /** 上次真正发给外壳的位置（null = 隐藏） */
  sent: BrowserBounds | null | undefined;
  layoutQueued: boolean;
  lastShown: number;
  destroyed: boolean;
  listeners: Set<() => void>;
}

/** 外壳命令的错误是 { code, message } 对象，不是 Error */
export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error;
    if (typeof message === "string") return message;
  }
  return String(error);
}

const sameBounds = (a: BrowserBounds | null | undefined, b: BrowserBounds | null) =>
  a === b ||
  (a !== null &&
    a !== undefined &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

export class BrowserPool {
  private readonly entries = new Map<string, Entry>();
  private clock = 0;
  private noticeSeq = 0;

  constructor(
    private readonly host: BrowserHost,
    private readonly events: BrowserPoolEvents,
    private readonly limit = MAX_LIVE_BROWSERS,
  ) {}

  /** 登记一个标签（不建 webview）；已有就不动 */
  register(tabId: string, url: string): void {
    if (this.entries.has(tabId)) return;
    this.entries.set(tabId, {
      tabId,
      status: { url, loading: false, back: false, forward: false, live: false },
      generation: 0,
      chain: Promise.resolve(),
      visible: false,
      bounds: null,
      sent: undefined,
      layoutQueued: false,
      lastShown: 0,
      destroyed: false,
      listeners: new Set(),
    });
  }

  status(tabId: string): BrowserStatus | undefined {
    return this.entries.get(tabId)?.status;
  }

  subscribe(tabId: string, listener: () => void): () => void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return () => undefined;
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /** 存活的 webview 数（含正在创建的） */
  get liveCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.status.live) n += 1;
    return n;
  }

  /** 显示在 bounds 处；没有 webview 就按记住的地址创建（超出上限先回收最久没显示的） */
  show(tabId: string, bounds: BrowserBounds): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined || entry.destroyed) return;
    this.clock += 1;
    entry.lastShown = this.clock;
    entry.visible = true;
    entry.bounds = bounds;
    // 上次创建失败时不自动重试（尺寸变化会反复触发），等用户点「重试」或重新导航
    if (!entry.status.live && entry.status.error === undefined) {
      this.evictFor(entry);
      this.create(entry);
    }
    this.queueLayout(entry);
  }

  /** 创建失败后的「重试」 */
  retry(tabId: string, bounds: BrowserBounds): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    this.patch(entry, { error: undefined });
    this.show(tabId, bounds);
  }

  hide(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    entry.visible = false;
    entry.bounds = null;
    if (entry.status.live) this.queueLayout(entry);
  }

  /**
   * 把显示中的 webview 全部藏起来并等外壳处理完（最多等 maxWaitMs）。
   * 关面板前调用：主界面重排是同一帧的事，原生 webview 走异步命令，不先藏就会晚一帧盖在对话区上
   */
  async hideShown(maxWaitMs = 120): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const [tabId, entry] of this.entries) {
      if (!entry.visible || !entry.status.live) continue;
      this.hide(tabId);
      waits.push(entry.chain);
    }
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** 关掉一条提示（关闭按钮、自动消失）；已被新提示替换时不动 */
  dismissNotice(tabId: string, seq: number): void {
    const entry = this.entries.get(tabId);
    if (entry?.status.notice?.seq !== seq) return;
    this.patch(entry, { notice: undefined });
  }

  /** 地址栏导航；返回错误文案（外壳拒绝的协议等），成功为 undefined */
  async navigate(tabId: string, url: string): Promise<string | undefined> {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return undefined;
    this.patch(entry, { notice: this.withoutBlocked(entry), error: undefined });
    if (!entry.status.live) {
      // 还没有 webview（被回收、还没显示过、创建失败）：记下地址，按它创建
      this.patch(entry, { url });
      this.events.onUrl(tabId, url);
      if (entry.visible && entry.bounds !== null) this.show(tabId, entry.bounds);
      return undefined;
    }
    let failure: string | undefined;
    await this.enqueue(entry, async (id) => {
      try {
        await this.host.navigate(id, url);
      } catch (error) {
        failure = errorText(error);
      }
    });
    return failure;
  }

  action(tabId: string, action: BrowserAction): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    if (!entry.status.live) {
      // 回收后的标签点「重新加载」：显示时本来就会按地址重建
      return;
    }
    void this.enqueue(entry, (id) => this.host.action(id, action).catch(() => undefined));
  }

  /** 截当前页面；没有 webview 或失败时 undefined */
  async capture(tabId: string): Promise<Uint8Array | undefined> {
    const entry = this.entries.get(tabId);
    if (entry?.id === undefined) return undefined;
    try {
      return await this.host.capture(entry.id);
    } catch {
      return undefined;
    }
  }

  /** 关闭标签、删除会话：销毁 webview，丢掉记录 */
  destroy(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    entry.destroyed = true;
    entry.visible = false;
    this.entries.delete(tabId);
    this.release(entry);
    if (entry.status.favicon !== undefined) URL.revokeObjectURL(entry.status.favicon);
  }

  dispose(): void {
    for (const tabId of [...this.entries.keys()]) this.destroy(tabId);
  }

  // ── 内部 ──

  /** 清掉拦截提示，下载提示留着 */
  private withoutBlocked(entry: Entry): BrowserNotice | undefined {
    return entry.status.notice?.kind === "blocked" ? undefined : entry.status.notice;
  }

  private notice(
    kind: BrowserNotice["kind"],
    body: Pick<BrowserNotice, "text" | "alert" | "autoHide">,
  ): BrowserNotice {
    this.noticeSeq += 1;
    return { kind, ...body, seq: this.noticeSeq };
  }

  private patch(entry: Entry, change: Partial<BrowserStatus>): void {
    entry.status = { ...entry.status, ...change };
    for (const listener of entry.listeners) listener();
  }

  /** 排在这个标签的命令队列后面；没有 webview 时跳过 */
  private enqueue(entry: Entry, op: (id: number) => Promise<void>): Promise<void> {
    const run = entry.chain.then(async () => {
      if (entry.id !== undefined) await op(entry.id);
    });
    entry.chain = run.catch(() => undefined);
    return entry.chain;
  }

  private queueLayout(entry: Entry): void {
    if (entry.layoutQueued) return;
    entry.layoutQueued = true;
    void this.enqueue(entry, async (id) => {
      entry.layoutQueued = false;
      const bounds = entry.visible ? entry.bounds : null;
      if (sameBounds(entry.sent, bounds)) return;
      entry.sent = bounds;
      await this.host.layout(id, bounds).catch(() => undefined);
    }).then(() => {
      // webview 没建成（enqueue 跳过了 op）时也要复位
      entry.layoutQueued = false;
    });
  }

  private evictFor(entry: Entry): void {
    const live = [...this.entries.values()].filter((e) => e.status.live && e !== entry);
    while (live.length >= this.limit) {
      const victims = live.filter((e) => !e.visible).sort((a, b) => a.lastShown - b.lastShown);
      const victim = victims[0];
      if (victim === undefined) return;
      live.splice(live.indexOf(victim), 1);
      this.release(victim);
      this.patch(victim, {
        live: false,
        loading: false,
        back: false,
        forward: false,
        notice: undefined,
      });
    }
  }

  /** 销毁外壳 webview（排在已发出的命令后面） */
  private release(entry: Entry): void {
    entry.generation += 1;
    const chain = entry.chain;
    entry.chain = chain.then(async () => {
      const id = entry.id;
      entry.id = undefined;
      entry.sent = undefined;
      if (id !== undefined) await this.host.destroy(id).catch(() => undefined);
    });
  }

  private create(entry: Entry): void {
    entry.generation += 1;
    const generation = entry.generation;
    const url = entry.status.url;
    this.patch(entry, { live: true, loading: true, error: undefined });
    entry.chain = entry.chain.then(async () => {
      if (entry.generation !== generation) return;
      try {
        // 先建成隐藏的，再由排在后面的布局命令放到位置上
        const id = await this.host.create(url, null, (message) => {
          if (entry.generation === generation) this.onMessage(entry, message);
        });
        if (entry.generation !== generation) {
          // 创建期间被关掉或回收
          await this.host.destroy(id).catch(() => undefined);
          return;
        }
        entry.id = id;
        entry.sent = null;
      } catch (error) {
        if (entry.generation !== generation) return;
        this.patch(entry, { live: false, loading: false, error: errorText(error) });
      }
    });
  }

  private onMessage(entry: Entry, message: BrowserMessage): void {
    switch (message.kind) {
      case "url":
        if (message.url === entry.status.url) return;
        this.patch(entry, { url: message.url });
        this.events.onUrl(entry.tabId, message.url);
        return;
      case "title":
        this.events.onTitle(entry.tabId, message.title);
        return;
      case "loading":
        this.patch(
          entry,
          message.loading
            ? { loading: true, notice: this.withoutBlocked(entry) }
            : { loading: false },
        );
        return;
      case "history":
        this.patch(entry, { back: message.back, forward: message.forward });
        return;
      case "favicon": {
        if (entry.status.favicon !== undefined) URL.revokeObjectURL(entry.status.favicon);
        const favicon =
          message.png === null || message.png.length === 0
            ? undefined
            : URL.createObjectURL(new Blob([new Uint8Array(message.png)], { type: "image/png" }));
        this.patch(entry, { favicon });
        return;
      }
      case "newWindow":
        this.events.onNewWindow(entry.tabId, message.url);
        return;
      case "blocked":
        this.patch(entry, {
          notice: this.notice("blocked", { text: message.message, alert: true, autoHide: false }),
          loading: false,
        });
        return;
      case "download":
        this.patch(entry, {
          notice: this.notice("download", downloadNotice(message.state, message.name)),
        });
        return;
      case "shortcut":
        this.events.onShortcut(message.key);
        return;
    }
  }
}
