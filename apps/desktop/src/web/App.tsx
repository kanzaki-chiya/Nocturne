import { useEffect, useRef, useState, type ReactNode } from "react";
import { RpcError } from "@nocturne/rpc/client";
import type { ParsedOffer } from "@nocturne/remote";
import { createAttachmentImageSource, type AttachmentImageSource } from "../attachment-images";
import type { ComposerSubmit } from "../Composer";
import { projectKey } from "../session-tree";
import { UsagePage } from "../UsagePage";
import { PhoneConnection } from "./connection";
import { pairPhone, pairingError, parsePairingLink, parsePairingTarget } from "./pairing";
import { PhoneSessions, phoneStatus, submitAccepted, type PhoneCreateOptions } from "./sessions";
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
  phoneProjects,
  plainWorkspaceOf,
  projectName,
  projectSessions,
  shortDate,
} from "./projects";
import {
  IconBack,
  IconChevron,
  IconComputer,
  IconFolder,
  IconHome,
  IconMore,
  IconPlus,
  IconSettings,
} from "./icons";
import { Popover, PopoverOption } from "./Popover";
import { DraftComposer, SessionScreen, mcpText } from "./SessionScreen";

export const TRUST_TEXT =
  "中继只转发密文，看不到会话内容。你仍需信任中继维护者及服务器不会篡改下发的手机网页；端到端加密防不住被篡改的网页。远程访问相当于在手机上执行代码，请妥善保管手机并及时移除丢失设备。";
export const ABILITY_TEXT =
  "手机能做会话里的一切：在任意项目新建会话、对话（含图片与 @ 文件引用）、切换模型、思考档位与权限预设、压缩、斜杠命令与技能、权限与提问、中断、回退与重发、分叉、查看本轮改动和用量。设置、服务商与凭据、MCP 与外部 agent 管理、持久授权、项目信任和 Shell 设置只能在电脑上改——这些在移除手机之后仍会生效。";
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
  | { kind: "session"; hostId: string; sessionId: string }
  | { kind: "settings"; hostId?: string }
  | { kind: "usage"; hostId: string }
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
  const [sessions] = useState(
    () =>
      new PhoneSessions(changed, (sessionId, type, seq, live) => {
        platformRef.current.observer?.event?.(sessionId, type, seq, live);
      }),
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
  const [connection, setConnection] = useState<PhoneConnection>();
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
  const [busy, setBusy] = useState(false);
  const [installHint, setInstallHint] = useState(false);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<PhoneTheme>(() => loadTheme());
  const [menu, setMenu] = useState<"hosts" | "session" | null>(null);
  const [menuOutput, setMenuOutput] = useState<string>();
  const [addingHost, setAddingHost] = useState(false);
  /** 首页「其他目录…」正在输入的路径；undefined 表示收起 */
  const [otherDir, setOtherDir] = useState<string>();
  const hostTrigger = useRef<HTMLButtonElement>(null);
  const sessionTrigger = useRef<HTMLButtonElement>(null);
  // 从推送点进来：连上电脑后跳到需要处理的会话
  const [attention, setAttention] = useState(() =>
    new URLSearchParams(location.search).has("attention"),
  );
  const navigate = (next: Page, replace = false) => {
    (replace ? history.replaceState.bind(history) : history.pushState.bind(history))(
      next,
      "",
      location.pathname,
    );
    setPage(next);
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
      })
      .catch(() => {
        setError("无法读取手机存储，请允许网站保存数据后重试");
      });
    const pop = (e: PopStateEvent) => {
      setPage((e.state as Page | null) ?? { kind: "welcome" });
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
    let channel: PhoneConnection | undefined;
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
        channel = new PhoneConnection({
          origin,
          identity,
          host: target,
          changed,
          connected: async (client, relay) => {
            await sessions.connected(client);
            await storage.putHost({ ...target, lastConnectedAt: Date.now() });
            await push?.attach(target.hostId, relay).catch(() => undefined);
          },
          disconnected: (reason) => {
            recordDisconnect(target.name, reason);
            platformRef.current.observer?.disconnected?.(target, reason);
            sessions.disconnected();
            push?.detach(target.hostId);
          },
        });
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
  const entry = page.kind === "session" ? sessions.opened.get(page.sessionId) : undefined;
  const connected = online;
  const extension: PhoneExtensionApi = {
    open: (name) => {
      navigate({ kind: "ext", page: name, ...(hostId ? { hostId } : {}) });
    },
    host: computer,
    connected,
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
    navigate({ kind: "session", hostId, sessionId: target.session.id });
    await submitAccepted(
      target,
      {
        text: input.text,
        ...(input.skill ? { skill: input.skill } : {}),
        ...(input.delegate ? { delegate: input.delegate } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      },
      (failure) => {
        if (
          failure !== undefined &&
          !(failure instanceof RpcError && failure.code === "connection_closed")
        )
          setError(failure instanceof Error ? failure.message : "发送失败");
        void sessions.refresh().catch(() => undefined);
      },
    );
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
          <label className="phone-switch">
            <span>
              {push.state === "working" ? "正在设置推送…" : "需要处理时提醒我"}
              <small>只显示固定提醒，不发送会话内容</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="推送通知"
              checked={push.state === "enabled"}
              disabled={push.state === "working" || push.state === "denied" || !hostId}
              onChange={() => {
                void (push.state === "enabled" ? push.disable() : push.enable());
              }}
            />
          </label>
          {!hostId && <small>先连上一台电脑再开启</small>}
        </>
      )}
    </section>
  );

  const pairForm = (
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
      <button className="phone-primary" disabled={!link.trim()}>
        继续配对
      </button>
    </form>
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
      case "ext":
        return platform.pages?.[page.page]?.title ?? "设置";
      case "project":
        return plainWorkspace !== undefined && projectKey(page.path) === projectKey(plainWorkspace)
          ? "普通对话"
          : projectName(page.path);
      case "session":
        return (
          entry?.view.title ??
          sessions.list.find((item) => item.id === page.sessionId)?.firstText ??
          "会话"
        );
      default:
        return computer?.name ?? "电脑";
    }
  })();

  let body: ReactNode;
  if (offer) {
    body = (
      <section className="phone-body">
        <h2>确认这台手机的名称</h2>
        <p>名称会显示在电脑的「设置 › 远程」中。</p>
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
            <p>{platform.trustText ?? TRUST_TEXT}</p>
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
        {!loaded && <p role="status">{connected ? "正在读取会话…" : "连接后会在这里显示项目。"}</p>}
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
                <small>
                  <span>在电脑上的任意已有目录新建会话</span>
                </small>
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
              <small>
                目录必须已存在。项目配置未被信任的新目录需要先在电脑上信任（nctrn trust）。
              </small>
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
            {rows.length} 个会话 · {page.path}
          </p>
          {rows.length === 0 && loaded && <p>还没有会话，在下方输入即可在这里新建。</p>}
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
                  <b>{heading}</b>
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
        onForked={(id) => {
          navigate({ kind: "session", hostId: page.hostId, sessionId: id });
        }}
      />
    ) : (
      <section className="phone-body">
        <p role="status">{connected ? "正在打开会话…" : "连接后会打开会话。"}</p>
      </section>
    );
  } else if (page.kind === "ext") {
    body = (
      <section className="phone-body phone-settings">
        {platform.pages?.[page.page]?.render(extension)}
      </section>
    );
  } else if (page.kind === "usage") {
    body = (
      <section className="phone-body phone-usage">
        <UsagePage
          client={connected ? sessions.client : undefined}
          scope={`${computer?.name ?? "电脑"}上的全部会话 · 含子代理`}
        />
      </section>
    );
  } else {
    const disconnects = loadDisconnects();
    body = (
      <section className="phone-body phone-settings">
        <section className="phone-section" aria-label="已配对的电脑">
          <h3>已配对的电脑</h3>
          {hosts.map((item) => (
            <div className="phone-host" key={item.hostId}>
              <div className="phone-host-line">
                <IconComputer />
                <input
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
              </div>
              <div className="phone-host-actions">
                <button
                  onClick={() => {
                    navigate({ kind: "home", hostId: item.hostId });
                  }}
                >
                  打开
                </button>
                <button
                  className="danger"
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
            </div>
          ))}
          {addingHost ? (
            <>
              <p>在电脑的「设置 › 远程」选择「配对新手机」，扫码或复制链接粘贴到这里。</p>
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
        <section className="phone-section" aria-label="连接诊断">
          <h3>连接诊断</h3>
          <dl className="phone-facts">
            <div>
              <dt>当前</dt>
              <dd>
                {page.hostId === undefined || connection === undefined
                  ? "未连接任何电脑"
                  : `${computer?.name ?? "电脑"} · ${STATE_TEXT[connection.state] ?? connection.state}${connection.message ? `（${connection.message}）` : ""}`}
              </dd>
            </div>
          </dl>
          {disconnects.length === 0 ? (
            <small>最近没有断线记录</small>
          ) : (
            <>
              <ul className="phone-log" aria-label="最近断线">
                {disconnects.map((item) => (
                  <li key={`${item.at}:${item.reason}`}>
                    <time>{new Date(item.at).toLocaleString("zh-CN", { hour12: false })}</time>
                    <span>
                      {item.host} · {item.reason}
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
            </>
          )}
          <small>只记在这台手机上，不含会话内容。</small>
          {platform.diagnostics?.(extension)}
        </section>
        <section className="phone-section" aria-label="主题">
          <h3>主题</h3>
          <div className="phone-segment" role="radiogroup" aria-label="主题">
            {(
              [
                ["system", "跟随系统"],
                ["light", "亮色"],
                ["dark", "暗色"],
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
          <section className="phone-section" aria-label="用量">
            <h3>用量</h3>
            <button
              className="phone-list-action"
              onClick={() => {
                if (page.hostId !== undefined) navigate({ kind: "usage", hostId: page.hostId });
              }}
            >
              查看 {computer?.name ?? "电脑"} 的用量统计
            </button>
          </section>
        )}
        <section className="phone-section" aria-label="关于">
          <h3>关于与信任边界</h3>
          <p>{ABILITY_TEXT}</p>
          <p>{platform.trustText ?? TRUST_TEXT}</p>
        </section>
      </section>
    );
  }

  const homeHeader = page.kind === "home" && !offer;
  return (
    <main className="phone">
      <header className={`phone-header${homeHeader ? " home" : ""}`}>
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
        ) : (
          <h1>{title}</h1>
        )}
        {page.kind === "session" ? (
          <button
            ref={sessionTrigger}
            className="phone-icon-button"
            aria-label="会话菜单"
            aria-haspopup="dialog"
            aria-expanded={menu === "session"}
            disabled={!entry}
            onClick={() => {
              setMenuOutput(undefined);
              setMenu(menu === "session" ? null : "session");
            }}
          >
            <IconMore />
          </button>
        ) : page.kind === "settings" ||
          page.kind === "usage" ||
          page.kind === "ext" ||
          page.kind === "welcome" ||
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
      {connection && connection.state !== "online" && page.kind !== "settings" && (
        <aside className="phone-status" role="status">
          {connection.message || "正在建立加密连接…"}
        </aside>
      )}
      {installHint && (
        <aside className="phone-status">
          请在 Safari
          分享菜单选择「添加到主屏幕」。添加后需在主屏幕应用里再配对一次，用电脑上的「复制链接」粘贴即可。
        </aside>
      )}
      {body}
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
      {menu === "session" && entry && (
        <Popover
          anchor={sessionTrigger.current}
          label="会话菜单"
          onClose={() => {
            setMenu(null);
          }}
          wide={menuOutput !== undefined}
        >
          <div className="phone-popover-h">{menuOutput !== undefined ? "MCP 状态" : "会话"}</div>
          {menuOutput !== undefined ? (
            <pre className="phone-output">{menuOutput}</pre>
          ) : (
            <>
              <PopoverOption
                label="压缩上下文"
                detail="与输入 /compact 相同"
                disabled={
                  !connected
                    ? "电脑尚未连接"
                    : entry.view.currentTurn !== undefined
                      ? "当前 Turn 结束后可压缩"
                      : undefined
                }
                onSelect={() => {
                  setMenu(null);
                  void operation(async () => {
                    await entry.session.compact();
                  });
                }}
              />
              <PopoverOption
                label="MCP 状态"
                detail="与输入 /mcp 相同"
                disabled={connected ? undefined : "电脑尚未连接"}
                onSelect={() => {
                  void entry.session.mcpServers().then(
                    (servers) => {
                      setMenuOutput(mcpText(servers));
                    },
                    (reason: unknown) => {
                      setMenuOutput(reason instanceof Error ? reason.message : String(reason));
                    },
                  );
                }}
              />
            </>
          )}
        </Popover>
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
  );
}
