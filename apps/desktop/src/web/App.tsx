import { useEffect, useRef, useState, type ReactNode } from "react";
import { RpcError } from "@nocturne/rpc/client";
import type { ParsedOffer } from "@nocturne/remote";
import { createAttachmentImageSource, type AttachmentImageSource } from "../attachment-images";
import type { ComposerSubmit } from "../Composer";
import { PaneErrorBoundary } from "../ErrorBoundary";
import { projectKey } from "../session-tree";
import { UsagePage } from "../UsagePage";
import { SchedulePage } from "../SchedulePage";
import { GrantsPage } from "../GrantsPage";
import {
  PhoneConnection,
  type PhoneConnectionLike,
  type PhoneConnectionOptions,
} from "./connection";
import { pairPhone, pairingError, parsePairingLink, parsePairingTarget } from "./pairing";
import {
  failPhoneOutgoing,
  phoneStatus,
  phoneSubmitBody,
  PhoneSessions,
  submitAccepted,
  trackPhoneOutgoing,
  type PhoneCreateOptions,
} from "./sessions";
import type { PairedHost, PhoneStorage } from "./storage";
import { webHost, type WebHost } from "./host";
import { pushAvailable, type PhonePush } from "./push";
import { webPlatform, type PhoneExtensionApi, type PhonePlatform } from "./platform";
import {
  applyTheme,
  clearDisconnects,
  loadDisconnects,
  loadTheme,
  recordDisconnect,
  saveTheme,
  type PhoneTheme,
} from "./local";
import {
  phoneProjectName,
  phoneProjects,
  plainWorkspaceOf,
  projectSessions,
  shortDate,
} from "./projects";
import {
  IconBack,
  IconChevron,
  IconComputer,
  IconFolder,
  IconHome,
  IconPlus,
  IconSettings,
  IconTerminal,
  IconTime,
} from "./icons";
import { Popover, PopoverOption } from "./Popover";
import { DraftComposer, SessionScreen } from "./SessionScreen";
import { ImageViewerProvider, type ImageViewerControl } from "../ImageViewer";
import { Switch } from "../ui";
import type { PhonePanelPage } from "./PhoneSidePanel";
import { SwarmPane } from "../SwarmPane";
import { swarmStatusDot } from "../swarm-ui";

export const TRUST_TEXT =
  "中继只转发密文，看不到会话内容。你仍需信任中继维护者及服务器不会篡改下发的手机网页；端到端加密防不住被篡改的网页。远程访问相当于在手机上执行代码，请妥善保管手机并及时移除丢失设备。";
export function iosBrowser(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}
export function standalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
type Page =
  | { kind: "welcome" }
  | { kind: "home"; hostId: string }
  | { kind: "project"; hostId: string; path: string }
  | { kind: "session"; hostId: string; sessionId: string; panel?: PhonePanelPage }
  | { kind: "swarm"; hostId: string; sessionId: string }
  | {
      kind: "swarm-member";
      hostId: string;
      sessionId: string;
      childSessionId: string;
      memberName: string;
    }
  | { kind: "settings"; hostId?: string }
  | { kind: "usage"; hostId: string }
  | { kind: "schedules"; hostId: string }
  | { kind: "grants"; hostId: string }
  | { kind: "diagnostics"; hostId: string }
  | { kind: "ext"; page: string; hostId?: string };

const STATE_TEXT: Record<string, string> = {
  online: "已连接",
  connecting: "正在连接",
  offline: "电脑离线",
  revoked: "已被移除",
  incompatible: "版本不兼容",
};

function lastHost(hosts: PairedHost[]): PairedHost | undefined {
  return [...hosts].sort(
    (a, b) => (b.lastConnectedAt ?? b.pairedAt) - (a.lastConnectedAt ?? a.pairedAt),
  )[0];
}

export function PhoneApp({
  storage,
  initialFragment = "",
  host = webHost,
  push: injectedPush,
  platform = webPlatform,
}: {
  storage: PhoneStorage;
  initialFragment?: string;
  host?: WebHost;
  /** 网页传 `browserPush`；不传（App）则没有推送，设置页不出现推送区块 */
  push?: PhonePush | ((changed: () => void) => PhonePush);
  platform?: PhonePlatform;
}) {
  const [, render] = useState(0);
  const changed = () => {
    render((n) => n + 1);
  };
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const currentRef = useRef<{
    hostId: string | undefined;
    sessionId: string | undefined;
    covered: boolean;
  }>({ hostId: undefined, sessionId: undefined, covered: false });
  const [sessions] = useState(
    () =>
      new PhoneSessions(
        changed,
        (sessionId, type, seq, live, eventTime) => {
          platformRef.current.observer?.event?.(sessionId, type, seq, live, eventTime);
        },
        (sessionId, event, live, entry, turnStartedAt) => {
          const current = currentRef.current;
          if (!current.hostId) return;
          const summary = sessions.list.find((item) => item.id === sessionId);
          platformRef.current.observer?.sessionEvent?.(
            current.hostId,
            sessionId,
            event,
            live,
            {
              ...(entry.view.title !== undefined ? { title: entry.view.title } : {}),
              ...(summary?.firstText !== undefined ? { firstText: summary.firstText } : {}),
            },
            platformRef.current.isForeground?.() === true &&
              !current.covered &&
              current.sessionId === sessionId,
            turnStartedAt,
          );
        },
      ),
  );
  // 消息里的图片经 readAttachment 回读；过大的由后台拒绝，占位条显示原因
  const [images] = useState<AttachmentImageSource>(() => ({
    ...createAttachmentImageSource(),
    showErrors: true,
  }));
  useEffect(
    () => () => {
      images.dispose();
    },
    [images],
  );
  const [push] = useState(() =>
    typeof injectedPush === "function" ? injectedPush(changed) : injectedPush,
  );
  const [connection, setConnection] = useState<PhoneConnectionLike>();
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [page, setPage] = useState<Page>({ kind: "welcome" });
  const [offer, setOffer] = useState<ParsedOffer>();
  /** 本次配对的中继：网页是页面源，App 取自配对链接 */
  const [offerOrigin, setOfferOrigin] = useState(() => location.origin);
  const [link, setLink] = useState("");
  const [deviceName, setDeviceName] = useState(
    navigator.userAgent.includes("iPhone")
      ? "iPhone"
      : navigator.userAgent.includes("Android")
        ? "Android 手机"
        : "手机",
  );
  const [error, setError] = useState("");
  const [draftRestore, setDraftRestore] = useState<{
    path: string;
    text: string;
    attachments: ComposerSubmit["attachments"];
    error: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [installHint, setInstallHint] = useState(false);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<PhoneTheme>(() => loadTheme());
  const [menu, setMenu] = useState<"hosts" | null>(null);
  /** 会话页顶栏右侧的位置：SessionScreen 放入会话菜单与侧边栏按钮 */
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>();
  const [renameError, setRenameError] = useState("");
  const [addingHost, setAddingHost] = useState(false);
  /** 首页「其他目录…」正在输入的路径；undefined 表示收起 */
  const [otherDir, setOtherDir] = useState<string>();
  const hostTrigger = useRef<HTMLButtonElement>(null);
  // 从推送点进来：连上电脑后跳到需要处理的会话
  const [attention, setAttention] = useState(() =>
    new URLSearchParams(location.search).has("attention"),
  );
  const [notificationTarget, setNotificationTarget] = useState<{
    hostId: string;
    sessionId: string;
  } | null>(null);
  const viewerControl = useRef<ImageViewerControl | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const closingViewerFromPop = useRef(false);
  const handleViewerOpenChange = (open: boolean) => {
    if (open) {
      const raw = history.state as (Page & { __viewer?: boolean }) | null;
      const base: Page = raw ? (({ __viewer: _, ...rest }) => rest)(raw) : pageRef.current;
      history.pushState({ ...base, __viewer: true }, "", location.pathname);
    } else if (!closingViewerFromPop.current) {
      if ((history.state as { __viewer?: boolean } | null)?.__viewer === true) {
        history.back();
      }
    }
    closingViewerFromPop.current = false;
  };
  const syncSelection = (target: Page) => {
    if (target.kind === "session" || target.kind === "swarm") {
      sessions.setSelected(target.sessionId);
    } else if (target.kind === "swarm-member") {
      sessions.setSelected(target.childSessionId, target.sessionId);
    } else {
      sessions.setSelected(undefined);
    }
  };
  const navigate = (next: Page, replace = false) => {
    if (viewerControl.current?.isOpen === true) {
      closingViewerFromPop.current = true;
      viewerControl.current.close();
    }
    (replace ? history.replaceState.bind(history) : history.pushState.bind(history))(
      next,
      "",
      location.pathname,
    );
    syncSelection(next);
    setPage(next);
    setAddingHost(false);
    setCameraDenied(false);
    setError("");
    setMenu(null);
  };
  const operation = async (run: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    applyTheme(theme);
    const media =
      theme === "system" && typeof window.matchMedia === "function"
        ? (window.matchMedia("(prefers-color-scheme: light)") as Partial<MediaQueryList>)
        : undefined;
    const report = () => {
      const resolved = theme === "system" ? (media?.matches === true ? "light" : "dark") : theme;
      platformRef.current.observer?.theme?.(resolved);
    };
    report();
    media?.addEventListener?.("change", report);
    return () => {
      media?.removeEventListener?.("change", report);
    };
  }, [theme]);
  useEffect(() => {
    void push?.refresh();
    let active = true;
    void storage
      .hosts()
      .then((list) => {
        if (!active) return;
        setHosts(list);
        setReady(true);
        if (initialFragment && platform.relay === "page") {
          try {
            setOffer(parsePairingLink(initialFragment, location.origin));
          } catch (e) {
            setError(pairingError(e));
          }
        }
        const recent = lastHost(list);
        if (recent) navigate({ kind: "home", hostId: recent.hostId }, true);
        void platform.notificationTarget?.().then((target) => {
          if (target) setNotificationTarget(target);
        });
      })
      .catch(() => {
        setError("无法读取手机存储，请允许网站保存数据后重试");
      });
    const pop = (e: PopStateEvent) => {
      const raw = e.state as (Page & { __viewer?: boolean }) | null;
      if (viewerControl.current?.isOpen === true && raw?.__viewer !== true) {
        closingViewerFromPop.current = true;
        viewerControl.current.close();
      }
      const next: Page = raw ? (({ __viewer: _, ...rest }) => rest)(raw) : { kind: "welcome" };
      if (
        next.kind === pageRef.current.kind &&
        JSON.stringify(next) === JSON.stringify(pageRef.current)
      ) {
        return;
      }
      syncSelection(next);
      setPage(next);
      setAddingHost(false);
      setCameraDenied(false);
      setError("");
      setMenu(null);
    };
    window.addEventListener("popstate", pop);
    return () => {
      active = false;
      window.removeEventListener("popstate", pop);
    };
  }, [storage]);
  /** 页面可见，或 App 开了「后台保持连接」：都要保持连接 */
  const shouldConnect = () =>
    platformRef.current.keepConnected === true || document.visibilityState !== "hidden";
  const hostId = "hostId" in page ? page.hostId : undefined;
  const activeSessionId =
    page.kind === "session" || page.kind === "swarm" || page.kind === "swarm-member"
      ? page.sessionId
      : undefined;
  const viewingSessionId =
    !offer && activeSessionId !== undefined && platform.isForeground?.() === true
      ? activeSessionId
      : undefined;
  currentRef.current = {
    hostId,
    sessionId: activeSessionId,
    covered: !!offer,
  };
  const reportedViewing =
    hostId !== undefined && viewingSessionId !== undefined ? `${hostId}|${viewingSessionId}` : "";
  const lastViewing = useRef("");
  useEffect(() => {
    if (lastViewing.current === reportedViewing) return;
    lastViewing.current = reportedViewing;
    platformRef.current.observer?.viewing?.(
      hostId !== undefined && viewingSessionId !== undefined
        ? { hostId, sessionId: viewingSessionId }
        : undefined,
    );
  });
  useEffect(() => {
    if (page.kind === "session") platform.dismissNotification?.(page.hostId, page.sessionId);
  }, [page, platform]);
  useEffect(() => platform.onNotificationTarget?.(setNotificationTarget), [platform]);
  useEffect(
    () =>
      platform.onAndroidBack?.(() => {
        if (viewerControl.current?.isOpen === true) {
          history.back();
          return;
        }
        if (page.kind === "welcome" || page.kind === "home") platform.moveTaskToBack?.();
        else history.back();
      }),
    [page, platform],
  );
  const computer = hosts.find((h) => h.hostId === hostId);
  useEffect(() => {
    if (!hostId) {
      setConnection(undefined);
      sessions.clear();
      return;
    }
    const target = hosts.find((h) => h.hostId === hostId);
    if (!target) return;
    let active = true;
    let channel: PhoneConnectionLike | undefined;
    sessions.clear();
    void storage
      .identity()
      .then((identity) => {
        if (!active) return;
        const origin = platform.relay === "page" ? location.origin : target.origin;
        if (!origin) {
          setError("这台电脑的配对记录缺少中继地址，请移除后重新配对");
          return;
        }
        const connectionOptions: PhoneConnectionOptions = {
          origin,
          identity,
          host: target,
          changed,
          ...(platform.initialized ? { initialized: platform.initialized.bind(platform) } : {}),
          ...(platform.versionMessage
            ? { versionMessage: platform.versionMessage.bind(platform) }
            : {}),
          connected: async (client, relay) => {
            await sessions.connected(client);
            await storage.putHost({ ...target, lastConnectedAt: Date.now() });
            if (relay) await push?.attach(target.hostId, relay).catch(() => undefined);
          },
          disconnected: (reason) => {
            recordDisconnect(target.name, reason);
            platformRef.current.observer?.disconnected?.(target, reason);
            sessions.disconnected();
            push?.detach(target.hostId);
          },
        };
        channel = platform.createConnection
          ? platform.createConnection(connectionOptions)
          : new PhoneConnection(connectionOptions);
        setConnection(channel);
        channel.visibility(shouldConnect());
        channel.start();
      })
      .catch(() => {
        setError("无法读取手机身份，请检查网站存储权限");
      });
    const visibility = () => channel?.visibility(shouldConnect());
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      channel?.stop();
      push?.detach(target.hostId);
      document.removeEventListener("visibilitychange", visibility);
    };
    // hosts 变化（重命名）不重连；切换电脑才重连
  }, [hostId, storage, hosts.length]);
  useEffect(() => {
    const viewport = window.visualViewport;
    // iOS 弹出软键盘时会把可视区在布局视口内上移（offsetTop），只缩高度会让整页滚出可视区。
    const resize = () => {
      const style = document.documentElement.style;
      const height = viewport?.height ?? window.innerHeight;
      const top = viewport?.offsetTop ?? 0;
      style.setProperty("--phone-height", `${height}px`);
      style.setProperty("--phone-top", `${top}px`);
      style.setProperty("--phone-bottom", `${Math.max(0, window.innerHeight - top - height)}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
    };
  }, []);
  useEffect(() => {
    // service worker 只有网页的推送会用；App 没有推送，不监听
    const worker = push
      ? (navigator.serviceWorker as ServiceWorkerContainer | undefined)
      : undefined;
    const message = (e: MessageEvent) => {
      if ((e.data as { t?: unknown } | null)?.t === "nocturne.attention") setAttention(true);
    };
    worker?.addEventListener("message", message);
    return () => worker?.removeEventListener("message", message);
  }, []);
  const online = connection?.state === "online";
  const loaded = sessions.loaded;
  const plainWorkspace = plainWorkspaceOf(connection?.sessionsDir);
  const openSession = (id: string) => {
    void operation(async () => {
      await sessions.open(id);
    });
  };
  useEffect(() => {
    if (!attention || !online || !loaded || !hostId) return;
    let active = true;
    void sessions.attentionTarget().then((id) => {
      if (!active) return;
      setAttention(false);
      if (!id) return;
      // 返回时回到该会话所在的项目页：首页 → 项目 → 会话
      const summary = sessions.list.find((item) => item.id === id);
      navigate({ kind: "home", hostId }, true);
      if (summary) navigate({ kind: "project", hostId, path: summary.cwd });
      navigate({ kind: "session", hostId, sessionId: id });
      openSession(id);
    });
    return () => {
      active = false;
    };
  }, [attention, online, loaded, hostId]);
  useEffect(() => {
    if (!notificationTarget || !ready || !hosts.some((h) => h.hostId === notificationTarget.hostId))
      return;
    if (hostId !== notificationTarget.hostId) {
      navigate({ kind: "home", hostId: notificationTarget.hostId }, true);
      return;
    }
    if (!online || !loaded) return;
    const { sessionId } = notificationTarget;
    setNotificationTarget(null);
    const summary = sessions.list.find((item) => item.id === sessionId);
    navigate({ kind: "home", hostId }, true);
    if (summary) navigate({ kind: "project", hostId, path: summary.cwd });
    navigate({ kind: "session", hostId, sessionId });
    openSession(sessionId);
  }, [notificationTarget, ready, hosts, hostId, online, loaded]);
  const coordinatorEntry = activeSessionId ? sessions.opened.get(activeSessionId) : undefined;
  const entry =
    page.kind === "session"
      ? coordinatorEntry
      : page.kind === "swarm-member"
        ? sessions.opened.get(page.childSessionId)
        : undefined;
  useEffect(() => {
    if (!online) return;
    if (page.kind === "swarm" && !coordinatorEntry) {
      void sessions.open(page.sessionId).catch(() => undefined);
    } else if (page.kind === "swarm-member" && !entry) {
      void sessions
        .openMember(page.childSessionId, coordinatorEntry?.workspace ?? "", page.sessionId)
        .catch(() => undefined);
    }
  }, [online, page, coordinatorEntry, entry, sessions]);
  const connected = online;
  const extension: PhoneExtensionApi = {
    open: (name) => {
      navigate({ kind: "ext", page: name, ...(hostId ? { hostId } : {}) });
    },
    host: computer,
    connected,
    refresh: changed,
  };
  // 平台观察者：已配对电脑与连接状态变化（App 据此维护后台服务与常驻通知）
  useEffect(() => {
    platformRef.current.observer?.hosts?.(hosts);
  }, [hosts]);
  const reportedState = `${computer?.hostId ?? ""}|${connection?.state ?? "offline"}|${connection?.message ?? ""}`;
  const lastReported = useRef("");
  useEffect(() => {
    if (lastReported.current === reportedState) return;
    lastReported.current = reportedState;
    platformRef.current.observer?.state?.(
      computer,
      connection?.state ?? "offline",
      connection?.message ?? "",
    );
  });
  // App 回到前台：补刷一次会话列表（别的进程新建的会话没有通知），并重新同步在看状态
  useEffect(
    () =>
      platformRef.current.onForeground?.(() => {
        changed();
        void sessions.refresh().catch(() => undefined);
      }),
    [sessions],
  );
  // 「后台保持连接」开关变化：立即按新值重新判定是否保持
  useEffect(() => {
    connection?.visibility(shouldConnect());
  }, [platform.keepConnected, connection]);
  const statuses = Object.fromEntries(
    [...sessions.opened].map(([id, opened]) => [id, phoneStatus(opened)]),
  );

  const createIn = async (path: string, input: ComposerSubmit, options: PhoneCreateOptions) => {
    if (!hostId) throw new Error("电脑尚未连接");
    const target = await sessions.create(path, options);
    const local = trackPhoneOutgoing(target, input, "turn", "steer");
    target.busy = true;
    navigate({ kind: "session", hostId, sessionId: target.session.id });
    try {
      await submitAccepted(
        target,
        phoneSubmitBody(input),
        (failure) => {
          target.busy = false;
          if (
            failure !== undefined &&
            !(failure instanceof RpcError && failure.code === "connection_closed")
          )
            setError(failure instanceof Error ? failure.message : "发送失败");
          changed();
          void sessions.refresh().catch(() => undefined);
        },
        local.id,
      );
      changed();
    } catch (failure) {
      failPhoneOutgoing(target, local.id);
      target.busy = false;
      sessions.setSelected(undefined);
      setDraftRestore({
        path,
        text: input.draftText ?? input.text,
        attachments: input.attachments,
        error: failure instanceof Error ? failure.message : "发送失败",
      });
      navigate({ kind: "project", hostId, path });
      throw failure;
    }
    // 与桌面相同：被接收后才记入输入历史，失败不影响发送
    if (input.text !== "")
      void target.session.recordInputHistory(input.text).catch(() => undefined);
  };

  const pushSection = push && (
    <section className="phone-section" aria-label="推送通知">
      <h3>推送通知</h3>
      {!pushAvailable(iosBrowser(), standalone()) ? (
        <p>添加到主屏幕后才能接收推送</p>
      ) : push.state === "unsupported" ? (
        <p>此浏览器不支持推送通知</p>
      ) : (
        <>
          {push.state === "denied" && (
            <p>通知权限已被拒绝，请在系统设置或浏览器的网站设置中允许 Nocturne 通知。</p>
          )}
          {push.message && <p role="status">{push.message}</p>}
          <div className="phone-item">
            <span className="phone-item-label">
              {push.state === "working" ? "正在设置推送…" : "需要处理时提醒我"}
            </span>
            <Switch
              aria-label="推送通知"
              checked={push.state === "enabled"}
              disabled={push.state === "working" || push.state === "denied" || !hostId}
              onChange={() => {
                void (push.state === "enabled" ? push.disable() : push.enable());
              }}
            />
          </div>
          {!hostId && <small>先连上一台电脑再开启</small>}
        </>
      )}
    </section>
  );

  const pairForm = (
    <>
      {platform.scanPairing && (
        <>
          <button
            className="phone-primary phone-pair-button"
            disabled={busy}
            onClick={() => {
              void operation(async () => {
                const result = await platform.scanPairing?.();
                if (!result) return;
                setCameraDenied("denied" in result);
                if ("denied" in result) {
                  setError("没有相机权限");
                  return;
                }
                if ("cancelled" in result) return;
                try {
                  const target = parsePairingTarget(result.text);
                  setOffer(target.offer);
                  setOfferOrigin(target.origin);
                  setLink("");
                } catch (cause) {
                  setError(pairingError(cause));
                }
              });
            }}
          >
            扫码
          </button>
          {cameraDenied && (
            <button
              className="phone-list-action"
              onClick={() => {
                void Promise.resolve(platform.openAppSettings?.()).catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : "操作失败，请重试");
                });
              }}
            >
              打开系统设置
            </button>
          )}
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            if (platform.relay === "page") {
              setOffer(parsePairingLink(link, location.origin));
              setOfferOrigin(location.origin);
            } else {
              const target = parsePairingTarget(link);
              setOffer(target.offer);
              setOfferOrigin(target.origin);
            }
            setLink("");
            setError("");
          } catch (cause) {
            setError(pairingError(cause));
          }
        }}
      >
        <label>
          粘贴配对链接
          <input
            autoComplete="off"
            spellCheck={false}
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
            }}
            placeholder={
              platform.relay === "page" ? "https://…/#pair=… 或 pair=…" : "https://…/#pair=…"
            }
          />
        </label>
        <button
          className={
            platform.scanPairing ? "phone-pair-button phone-pair-secondary" : "phone-primary"
          }
          disabled={!link.trim()}
        >
          继续配对
        </button>
      </form>
    </>
  );

  const title = (() => {
    if (offer) return "将与电脑配对";
    switch (page.kind) {
      case "welcome":
        return "Nocturne";
      case "settings":
        return "设置";
      case "usage":
        return "用量";
      case "grants":
        return "授权";
      case "diagnostics":
        return "连接诊断";
      case "schedules":
        return "定时任务";
      case "ext":
        return platform.pages?.[page.page]?.title ?? "设置";
      case "project":
        return phoneProjectName(page.path, plainWorkspace);
      case "session":
        return (
          entry?.view.title ??
          sessions.list.find((item) => item.id === page.sessionId)?.firstText ??
          "会话"
        );
      case "swarm":
        return coordinatorEntry?.view.swarm?.title ?? "Swarm";
      case "swarm-member":
        return `@${page.memberName}`;
      default:
        return computer?.name ?? "电脑";
    }
  })();

  let body: ReactNode;
  if (offer) {
    body = (
      <section className="phone-body">
        <h2>确认这台手机的名称</h2>
        <label>
          设备名
          <input
            value={deviceName}
            maxLength={64}
            onChange={(e) => {
              setDeviceName(e.target.value);
            }}
          />
        </label>
        <button
          className="phone-primary"
          disabled={busy || !deviceName.trim()}
          onClick={() => {
            void operation(async () => {
              try {
                const paired = await pairPhone(
                  storage,
                  offer,
                  offerOrigin,
                  deviceName,
                  undefined,
                  undefined,
                  platform.relay === "link",
                );
                setOffer(undefined);
                setAddingHost(false);
                setCameraDenied(false);
                setHosts(await storage.hosts());
                setInstallHint(platform.relay === "page" && iosBrowser() && !standalone());
                navigate({ kind: "home", hostId: paired.hostId }, true);
              } catch (e) {
                throw new Error(pairingError(e));
              }
            });
          }}
        >
          {busy ? "正在配对…" : "确认配对"}
        </button>
      </section>
    );
  } else if (page.kind === "welcome") {
    body = (
      <section className="phone-body">
        {!ready ? (
          <p role="status">正在读取手机存储…</p>
        ) : (
          <>
            <h2>把会话带在身边</h2>
            {platform.relay === "page" && standalone() && (
              <p className="phone-pair-first">在主屏幕应用里，请先粘贴电脑复制的配对链接。</p>
            )}
            <p>
              {platform.pairHint ??
                "在电脑的「设置 › 远程」登记中继，然后选择「配对新手机」，用相机扫码。"}
            </p>
            {pairForm}
          </>
        )}
      </section>
    );
  } else if (page.kind === "home") {
    const projects = phoneProjects(sessions.list, plainWorkspace);
    body = (
      <section className="phone-body phone-list">
        <h3 className="phone-list-h">项目</h3>
        {!loaded && connected && <p role="status">正在读取会话…</p>}
        <button
          className="phone-row"
          disabled={!connected}
          onClick={() => {
            navigate({ kind: "schedules", hostId: page.hostId });
          }}
        >
          <span className="phone-row-icon">
            <IconTime />
          </span>
          <span className="phone-row-main">
            <b>定时任务</b>
          </span>
        </button>
        {projects.map((project) => (
          <button
            key={project.key}
            className="phone-row"
            disabled={!loaded}
            onClick={() => {
              navigate({ kind: "project", hostId: page.hostId, path: project.path });
            }}
          >
            <span className="phone-row-icon">{project.plain ? <IconHome /> : <IconFolder />}</span>
            <span className="phone-row-main">
              <b>{project.name}</b>
              <small>
                <span>{project.count} 个会话</span>
                {project.latest !== undefined && <span>{shortDate(project.latest)}</span>}
              </small>
            </span>
          </button>
        ))}
        {loaded &&
          (otherDir === undefined ? (
            <button
              className="phone-row other"
              onClick={() => {
                setOtherDir("");
              }}
            >
              <span className="phone-row-icon">
                <IconPlus />
              </span>
              <span className="phone-row-main">
                <b>其他目录…</b>
              </span>
            </button>
          ) : (
            <form
              className="phone-other-dir"
              onSubmit={(event) => {
                event.preventDefault();
                const path = otherDir.trim();
                if (path === "") return;
                setOtherDir(undefined);
                navigate({ kind: "project", hostId: page.hostId, path });
              }}
            >
              <label>
                电脑上的目录完整路径
                <input
                  value={otherDir}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="例如 D:\code\app 或 /home/me/app"
                  onChange={(event) => {
                    setOtherDir(event.target.value);
                  }}
                />
              </label>
              <div className="phone-actions">
                <button
                  type="button"
                  onClick={() => {
                    setOtherDir(undefined);
                  }}
                >
                  取消
                </button>
                <button className="phone-primary" disabled={otherDir.trim() === ""}>
                  打开
                </button>
              </div>
            </form>
          ))}
      </section>
    );
  } else if (page.kind === "project") {
    const rows = projectSessions(sessions.list, page.path, plainWorkspace, statuses);
    const byId = new Map(sessions.list.map((item) => [item.id, item]));
    body = (
      <>
        <section className="phone-body phone-list">
          <p className="phone-sub">{computer?.name ?? "电脑"}</p>
          <p className="phone-sub" title={page.path}>
            {rows.length} 个会话<span className="muted-value">{page.path}</span>
          </p>
          {rows.length === 0 && loaded && <p>还没有会话</p>}
          {rows.map((row) => {
            const opened = sessions.opened.get(row.id);
            const summary = byId.get(row.id);
            const heading = opened?.view.title ?? row.title;
            const status = statuses[row.id] ?? "idle";
            return (
              <button
                className="phone-row session"
                key={row.id}
                disabled={!connected}
                onClick={() => {
                  navigate({ kind: "session", hostId: page.hostId, sessionId: row.id });
                  openSession(row.id);
                }}
              >
                <span className="phone-row-main">
                  <b>
                    {(row.client ?? summary?.client) !== undefined && (
                      <span
                        className="phone-session-client"
                        title={(row.client ?? summary?.client)?.name}
                        aria-label={(row.client ?? summary?.client)?.name}
                      >
                        <IconTerminal />
                      </span>
                    )}
                    {heading}
                  </b>
                  {heading !== row.title && <span className="phone-row-summary">{row.title}</span>}
                  <small>
                    <span className={`phone-badge ${status}`}>
                      {status === "pending" ? "待确认" : status === "running" ? "运行中" : ""}
                      {summary?.forkedFrom ? "分叉" : ""}
                    </span>
                    <span>{summary ? shortDate(summary.mtimeMs) : ""}</span>
                  </small>
                </span>
              </button>
            );
          })}
        </section>
        <DraftComposer
          runtime={connected ? sessions.client?.runtime : undefined}
          workspace={page.path}
          connected={connected}
          restore={draftRestore?.path === page.path ? draftRestore : undefined}
          onRestoreUsed={() => {
            setDraftRestore(null);
          }}
          onCreate={(input, options) => createIn(page.path, input, options)}
        />
      </>
    );
  } else if (page.kind === "session") {
    body = entry ? (
      <SessionScreen
        key={entry.session.id}
        entry={entry}
        connected={connected}
        images={images}
        plain={
          plainWorkspace !== undefined && projectKey(entry.workspace) === projectKey(plainWorkspace)
        }
        openUrl={(url) => {
          host.openUrl(url);
        }}
        onError={setError}
        onChanged={() => {
          void sessions.refresh().catch(() => undefined);
        }}
        sessions={sessions}
        headerSlot={headerSlot}
        panel={page.panel}
        onPanel={(panel) => {
          navigate({ ...page, panel });
        }}
        onPanelBack={() => {
          history.back();
        }}
        onPanelClose={() => {
          history.go(page.panel?.kind === "overview" ? -1 : -2);
        }}
        onOpenSwarm={() => {
          navigate({ kind: "swarm", hostId: page.hostId, sessionId: page.sessionId });
        }}
        onRename={() => {
          setRenameError("");
          setRenameDraft(title);
        }}
        onManageGrants={() => {
          navigate({ kind: "grants", hostId: page.hostId });
        }}
        onForked={(id) => {
          navigate({ kind: "session", hostId: page.hostId, sessionId: id });
        }}
      />
    ) : (
      <section className="phone-body">{connected && <p role="status">正在打开会话…</p>}</section>
    );
  } else if (page.kind === "swarm") {
    const swarm = coordinatorEntry?.view.swarm;
    body =
      coordinatorEntry && swarm ? (
        <section className="phone-swarm">
          <SwarmPane
            swarm={swarm}
            session={coordinatorEntry.session}
            openUrl={(url) => {
              host.openUrl(url);
            }}
            onSelectCoordinator={() => {
              history.back();
            }}
            onOpenMember={(member) => {
              const parentId = page.sessionId;
              const workspace = coordinatorEntry.workspace;
              navigate({
                kind: "swarm-member",
                hostId: page.hostId,
                sessionId: parentId,
                childSessionId: member.childSessionId,
                memberName: member.name,
              });
              void operation(async () => {
                await sessions.openMember(member.childSessionId, workspace, parentId);
              });
            }}
            visible
          />
        </section>
      ) : (
        <section className="phone-swarm" />
      );
  } else if (page.kind === "swarm-member") {
    const swarm = coordinatorEntry?.view.swarm;
    const memberStatus = swarm?.members.find(
      (item) => item.childSessionId === page.childSessionId,
    )?.status;
    const frozen =
      swarm?.status !== "active" || memberStatus === undefined || memberStatus === "removed";
    body = entry ? (
      <SessionScreen
        key={entry.session.id}
        entry={entry}
        connected={connected}
        images={images}
        plain={
          plainWorkspace !== undefined && projectKey(entry.workspace) === projectKey(plainWorkspace)
        }
        openUrl={(url) => {
          host.openUrl(url);
        }}
        onError={setError}
        onChanged={() => {
          void sessions.refresh().catch(() => undefined);
        }}
        sessions={sessions}
        onForked={() => undefined}
        swarmMember={{ name: page.memberName, frozen }}
      />
    ) : (
      <section className="phone-body">{connected && <p role="status">正在打开会话…</p>}</section>
    );
  } else if (page.kind === "ext") {
    body = (
      <section className="phone-body phone-settings">
        {platform.pages?.[page.page]?.render(extension)}
      </section>
    );
  } else if (page.kind === "schedules") {
    const workspaces = phoneProjects(sessions.list, plainWorkspace).map((project) => ({
      path: project.plain ? null : project.path,
      label: project.name,
    }));
    body = (
      <section className="phone-body phone-schedules">
        <SchedulePage
          api={connected ? sessions.client?.runtime : undefined}
          workspaces={workspaces}
          readOnly
          onOpenSession={async (sessionId) => {
            if (!sessions.list.some((item) => item.id === sessionId)) {
              await sessions.refresh().catch(() => undefined);
            }
            if (!sessions.list.some((item) => item.id === sessionId)) return false;
            navigate({ kind: "session", hostId: page.hostId, sessionId });
            openSession(sessionId);
            return true;
          }}
          onChanged={() => {
            void sessions.refresh().catch(() => undefined);
          }}
        />
      </section>
    );
  } else if (page.kind === "grants") {
    body = (
      <section className="phone-grants">
        <GrantsPage
          client={connected ? sessions.client : undefined}
          plainWorkspace={plainWorkspace ?? undefined}
          remote
        />
      </section>
    );
  } else if (page.kind === "usage") {
    body = (
      <section className="phone-body phone-usage">
        <UsagePage client={connected ? sessions.client : undefined} />
      </section>
    );
  } else if (page.kind === "diagnostics") {
    const disconnects = loadDisconnects();
    body = (
      <section className="phone-body phone-settings">
        <section className="phone-section" aria-label="连接诊断">
          <div className="phone-item">
            <span className="phone-item-label">{computer?.name ?? "电脑"}</span>
            <span className="muted-value">
              {STATE_TEXT[connection?.state ?? "offline"] ?? connection?.state}
              {connection?.message ? `（${connection.message}）` : ""}
            </span>
          </div>
        </section>
        {disconnects.length > 0 && (
          <section className="phone-section" aria-label="断线记录">
            <h3>断线记录</h3>
            <ul className="phone-log">
              {disconnects.map((item) => (
                <li key={`${item.at}:${item.reason}`}>
                  <time>
                    {new Date(item.at).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })}
                  </time>
                  <span>
                    {item.host === computer?.name ? item.reason : `${item.host}：${item.reason}`}
                  </span>
                </li>
              ))}
            </ul>
            <button
              className="phone-list-action"
              onClick={() => {
                clearDisconnects();
                changed();
              }}
            >
              清除记录
            </button>
          </section>
        )}
        {platform.diagnostics && (
          <section className="phone-section">{platform.diagnostics(extension)}</section>
        )}
      </section>
    );
  } else {
    body = (
      <section className="phone-body phone-settings">
        <section className="phone-section" aria-label="已配对的电脑">
          <h3>已配对的电脑</h3>
          {hosts.map((item) => (
            <div className="phone-item phone-host-line" key={item.hostId}>
              <IconComputer />
              <input
                className="phone-host-name"
                aria-label={`重命名 ${item.name}`}
                defaultValue={item.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== item.name)
                    void operation(async () => {
                      await storage.putHost({ ...item, name });
                      setHosts(await storage.hosts());
                    });
                }}
              />
              <button
                className="phone-text-button"
                onClick={() => {
                  navigate({ kind: "home", hostId: item.hostId });
                }}
              >
                打开
              </button>
              <button
                className="phone-text-button danger"
                onClick={() => {
                  void operation(async () => {
                    await storage.removeHost(item.hostId);
                    const rest = await storage.hosts();
                    setHosts(rest);
                    setError("已从手机移除。电脑上的设备记录请在电脑的『设置 › 远程』里移除");
                    if (item.hostId === page.hostId) navigate({ kind: "settings" }, true);
                  });
                }}
              >
                移除
              </button>
            </div>
          ))}
          {addingHost ? (
            <>
              <p>
                {platform.pairHint ??
                  "在电脑的「设置 › 远程」选择「配对新手机」，扫码或复制链接粘贴到这里。"}
              </p>
              {pairForm}
            </>
          ) : (
            <button
              className="phone-list-action"
              onClick={() => {
                setAddingHost(true);
              }}
            >
              添加电脑
            </button>
          )}
        </section>
        {platform.background?.(extension)}
        {pushSection}
        <section className="phone-section" aria-label="主题">
          <h3>主题</h3>
          <div className="phone-segment" role="radiogroup" aria-label="主题">
            {(
              [
                ["system", "跟随系统"],
                ["light", "月之亮面"],
                ["dark", "月之暗面"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={theme === value}
                className={theme === value ? "on" : undefined}
                onClick={() => {
                  saveTheme(value);
                  setTheme(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
        {page.hostId !== undefined && (
          <section className="phone-section" aria-label={computer?.name ?? "电脑"}>
            <h3>{computer?.name ?? "电脑"}</h3>
            <button
              className="phone-item phone-nav"
              onClick={() => {
                if (page.hostId) navigate({ kind: "diagnostics", hostId: page.hostId });
              }}
            >
              <span className="phone-item-label">连接诊断</span>
              <span className="muted-value">
                {STATE_TEXT[connection?.state ?? "offline"] ?? connection?.state}
              </span>
              <span className="phone-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            <button
              className="phone-item phone-nav"
              onClick={() => {
                if (page.hostId) navigate({ kind: "grants", hostId: page.hostId });
              }}
            >
              <span className="phone-item-label">授权</span>
              <span className="phone-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            <button
              className="phone-item phone-nav"
              onClick={() => {
                if (page.hostId) navigate({ kind: "usage", hostId: page.hostId });
              }}
            >
              <span className="phone-item-label">用量</span>
              <span className="phone-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </section>
        )}
        <section className="phone-section" aria-label="关于">
          <h3>关于</h3>
          {platform.updateAbout?.()}
          <details className="phone-trust">
            <summary>安全说明</summary>
            <p>{platform.trustText ?? TRUST_TEXT}</p>
          </details>
        </section>
      </section>
    );
  }

  const homeHeader = page.kind === "home" && !offer;
  const sessionHeader = page.kind === "session" && !offer;
  const swarmHeaderDot =
    page.kind === "swarm" && !offer ? swarmStatusDot(coordinatorEntry?.view.swarm) : undefined;
  const sessionPath =
    page.kind === "session"
      ? (entry?.workspace ?? sessions.list.find((item) => item.id === page.sessionId)?.cwd)
      : undefined;
  return (
    <ImageViewerProvider
      capabilities={platform.imageViewer}
      saveFile={platform.saveFile}
      controlRef={viewerControl}
      onOpenChange={handleViewerOpenChange}
    >
      <main className="phone">
        {platform.updateLifecycle?.()}
        <header
          className={`phone-header${homeHeader ? " home" : ""}${sessionHeader ? " session" : ""}`}
        >
          {homeHeader ? (
            <span className="phone-header-side" />
          ) : (
            <button
              className="phone-icon-button"
              aria-label="返回"
              disabled={(page.kind === "welcome" && !offer) || (!offer && history.length <= 1)}
              onClick={() => {
                if (offer) setOffer(undefined);
                else history.back();
              }}
            >
              <IconBack />
            </button>
          )}
          {homeHeader ? (
            <button
              ref={hostTrigger}
              className="phone-host-switch"
              aria-label="切换电脑"
              aria-haspopup="dialog"
              aria-expanded={menu === "hosts"}
              onClick={() => {
                setMenu(menu === "hosts" ? null : "hosts");
              }}
            >
              <IconComputer />
              <h1>{title}</h1>
              <i
                className={`phone-dot ${connection?.state ?? "offline"}`}
                aria-label={STATE_TEXT[connection?.state ?? "offline"]}
                role="img"
              />
              <IconChevron />
            </button>
          ) : sessionHeader ? (
            <div className="phone-header-title">
              <h1>{title}</h1>
              {sessionPath !== undefined && (
                <p className="phone-header-project">
                  {phoneProjectName(sessionPath, plainWorkspace)}
                </p>
              )}
            </div>
          ) : page.kind === "swarm" && !offer ? (
            <div className="phone-swarm-head-title">
              {swarmHeaderDot !== undefined && (
                <span className={`sp-swarm-dot ${swarmHeaderDot}`} aria-hidden="true" />
              )}
              <h1>{title}</h1>
            </div>
          ) : (
            <h1>{title}</h1>
          )}
          {sessionHeader ? (
            <div className="phone-header-tools" ref={setHeaderSlot} />
          ) : page.kind === "swarm" ||
            page.kind === "swarm-member" ||
            page.kind === "settings" ||
            page.kind === "diagnostics" ||
            page.kind === "usage" ||
            page.kind === "schedules" ||
            page.kind === "ext" ||
            offer ? (
            <span className="phone-header-side" />
          ) : (
            <button
              className="phone-icon-button"
              aria-label="设置"
              onClick={() => {
                navigate({ kind: "settings", ...(hostId ? { hostId } : {}) });
              }}
            >
              <IconSettings />
            </button>
          )}
        </header>
        {error && (
          <p className="phone-error" role="alert">
            {error}
          </p>
        )}
        {connection &&
          connection.state !== "online" &&
          page.kind !== "settings" &&
          page.kind !== "diagnostics" && (
            <aside
              className={`phone-status${
                connection.state === "incompatible" &&
                connection.message === "App 版本过旧" &&
                platform.incompatibleUpdate
                  ? " phone-update-content"
                  : ""
              }`}
              role="status"
            >
              {connection.state === "incompatible" &&
              connection.message === "App 版本过旧" &&
              platform.incompatibleUpdate
                ? platform.incompatibleUpdate()
                : connection.message || "正在建立加密连接…"}
            </aside>
          )}
        {homeHeader && connection?.state !== "incompatible" && platform.updateNotice?.()}
        {installHint && (
          <aside className="phone-status">
            请在 Safari
            分享菜单选择「添加到主屏幕」。添加后需在主屏幕应用里再配对一次，用电脑上的「复制链接」粘贴即可。
          </aside>
        )}
        <PaneErrorBoundary
          key={JSON.stringify(page.kind === "session" ? { ...page, panel: undefined } : page)}
        >
          {body}
        </PaneErrorBoundary>
        {menu === "hosts" && (
          <Popover
            anchor={hostTrigger.current}
            label="切换电脑"
            onClose={() => {
              setMenu(null);
            }}
          >
            <div className="phone-popover-h">电脑</div>
            {hosts.map((item) => (
              <PopoverOption
                key={item.hostId}
                icon={<IconComputer />}
                label={item.name}
                detail={
                  item.hostId === hostId
                    ? STATE_TEXT[connection?.state ?? "offline"]
                    : item.lastConnectedAt
                      ? `上次连接 ${shortDate(item.lastConnectedAt)}`
                      : "尚未连接"
                }
                checked={item.hostId === hostId}
                onSelect={() => {
                  setMenu(null);
                  if (item.hostId !== hostId) navigate({ kind: "home", hostId: item.hostId }, true);
                }}
              />
            ))}
            <PopoverOption
              label="管理电脑与配对…"
              onSelect={() => {
                navigate({ kind: "settings", ...(hostId ? { hostId } : {}) });
              }}
            />
          </Popover>
        )}
        {renameDraft !== undefined && page.kind === "session" && (
          <div className="phone-rename-backdrop">
            <form
              className="phone-rename-dialog"
              role="dialog"
              aria-label="重命名会话"
              onSubmit={(e) => {
                e.preventDefault();
                const next = renameDraft;
                if (next === title) {
                  setRenameDraft(undefined);
                  return;
                }
                setBusy(true);
                void (async () => {
                  try {
                    if (!sessions.client) throw new Error("电脑尚未连接");
                    await sessions.client.runtime.renameSession(page.sessionId, next);
                    await sessions.refresh();
                    setRenameDraft(undefined);
                  } catch (reason) {
                    setRenameError(
                      reason instanceof RpcError && reason.code === "session_locked"
                        ? "这个会话正在别处打开，关掉后再改名"
                        : reason instanceof Error
                          ? reason.message
                          : "操作失败，请重试",
                    );
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              <h2>重命名会话</h2>
              <input
                aria-label="会话名称"
                autoFocus
                value={renameDraft}
                onChange={(e) => {
                  setRenameDraft(e.target.value);
                }}
              />
              {renameError && <p role="alert">{renameError}</p>}
              <div className="phone-rename-actions">
                <button
                  type="button"
                  onClick={() => {
                    setRenameDraft(undefined);
                  }}
                >
                  取消
                </button>
                <button type="submit" disabled={busy}>
                  保存
                </button>
              </div>
            </form>
          </div>
        )}
        {connection?.state === "revoked" && hostId && (
          <button
            className="phone-remove"
            onClick={() => {
              void operation(async () => {
                await storage.removeHost(hostId);
                const rest = await storage.hosts();
                setHosts(rest);
                const next = lastHost(rest);
                navigate(next ? { kind: "home", hostId: next.hostId } : { kind: "welcome" }, true);
                setError("电脑上的设备记录请在电脑的『设置 › 远程』里移除");
              });
            }}
          >
            移除这台电脑
          </button>
        )}
      </main>
    </ImageViewerProvider>
  );
}
