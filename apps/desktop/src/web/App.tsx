import { useEffect, useState } from "react";
import { RpcError } from "@nocturne/rpc/client";
import type { ParsedOffer } from "@nocturne/remote";
import { Conversation, PermissionCard, QuestionCard } from "../Conversation";
import type { AttachmentImageSource } from "../attachment-images";
import { projectName } from "../session-tree";
import { PhoneConnection } from "./connection";
import { pairPhone, pairingError, parsePairingLink } from "./pairing";
import { PhoneSessions, knownWorkspaces, phoneStatus } from "./sessions";
import type { PairedHost, PhoneStorage } from "./storage";
import { webHost, type WebHost } from "./host";
import { browserPush, pushAvailable, type PhonePush } from "./push";

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
const images: AttachmentImageSource = {
  placeholder: "图片（请在电脑上查看）",
  url: () => undefined,
  register: () => Promise.reject(new Error("请在电脑上查看图片")),
  load: () => Promise.reject(new Error("请在电脑上查看图片")),
  dispose: () => undefined,
};
type Page =
  | { kind: "hosts" }
  | { kind: "list"; hostId: string }
  | { kind: "session"; hostId: string; sessionId: string }
  | { kind: "new"; hostId: string }
  | { kind: "about" };
export function PhoneApp({
  storage,
  initialFragment = "",
  host = webHost,
  push: injectedPush,
}: {
  storage: PhoneStorage;
  initialFragment?: string;
  host?: WebHost;
  push?: PhonePush;
}) {
  const [, render] = useState(0);
  const changed = () => {
    render((n) => n + 1);
  };
  const [sessions] = useState(() => new PhoneSessions(changed));
  const [push] = useState(() => injectedPush ?? browserPush(changed));
  const [connection, setConnection] = useState<PhoneConnection>();
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [page, setPage] = useState<Page>({ kind: "hosts" });
  const [offer, setOffer] = useState<ParsedOffer>();
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
  const [text, setText] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [ready, setReady] = useState(false);
  const navigate = (next: Page, replace = false) => {
    (replace ? history.replaceState.bind(history) : history.pushState.bind(history))(
      next,
      "",
      location.pathname,
    );
    setPage(next);
    setError("");
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
    void push.refresh();
    let active = true;
    void storage
      .hosts()
      .then((list) => {
        if (!active) return;
        setHosts(list);
        setReady(true);
        if (initialFragment) {
          try {
            setOffer(parsePairingLink(initialFragment, location.origin));
          } catch (e) {
            setError(pairingError(e));
          }
        } else if (list.length === 1 && list[0]) navigate({ kind: "list", hostId: list[0].hostId });
      })
      .catch(() => {
        setError("无法读取手机存储，请允许网站保存数据后重试");
      });
    const pop = (e: PopStateEvent) => {
      setPage((e.state as Page | null) ?? { kind: "hosts" });
      setError("");
    };
    window.addEventListener("popstate", pop);
    return () => {
      active = false;
      window.removeEventListener("popstate", pop);
    };
  }, [storage]);
  const hostId = "hostId" in page ? page.hostId : undefined;
  useEffect(() => {
    if (!hostId) {
      setConnection(undefined);
      sessions.clear();
      return;
    }
    const computer = hosts.find((h) => h.hostId === hostId);
    if (!computer) return;
    let active = true;
    let channel: PhoneConnection | undefined;
    sessions.clear();
    void storage
      .identity()
      .then((identity) => {
        if (!active) return;
        channel = new PhoneConnection({
          origin: location.origin,
          identity,
          host: computer,
          changed,
          connected: async (client, relay) => {
            await sessions.connected(client);
            await storage.putHost({ ...computer, lastConnectedAt: Date.now() });
            await push.attach(computer.hostId, relay).catch(() => undefined);
          },
          disconnected: () => {
            sessions.disconnected();
            push.detach(computer.hostId);
          },
        });
        setConnection(channel);
        channel.visibility(document.visibilityState !== "hidden");
        channel.start();
      })
      .catch(() => {
        setError("无法读取手机身份，请检查网站存储权限");
      });
    const visibility = () => channel?.visibility(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      channel?.stop();
      push.detach(computer.hostId);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [hostId, storage]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        "--phone-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    return () => viewport?.removeEventListener("resize", resize);
  }, []);
  const entry = page.kind === "session" ? sessions.opened.get(page.sessionId) : undefined;
  const connected = connection?.state === "online";
  const [dismissed, setDismissed] = useState("");
  const pendingKey =
    entry?.view.pendingPermission?.requestId ?? entry?.view.pendingQuestion?.requestId;
  const replySession = entry && {
    ...entry.session,
    respondPermission: async (...args: Parameters<typeof entry.session.respondPermission>) => {
      try {
        await entry.session.respondPermission(...args);
      } catch (e) {
        if (!(e instanceof RpcError && e.code === "unknown_request")) throw e;
      }
      setDismissed(args[0]);
    },
    respondQuestion: async (...args: Parameters<typeof entry.session.respondQuestion>) => {
      try {
        await entry.session.respondQuestion(...args);
      } catch (e) {
        if (!(e instanceof RpcError && e.code === "unknown_request")) throw e;
      }
      setDismissed(args[0]);
    },
  };
  const submit = async () => {
    if (!text.trim()) return;
    const outgoing = text;
    const target = page.kind === "new" ? await sessions.create(workspace) : entry;
    if (!target || target.dead) throw new Error("电脑尚未连接");
    navigate({ kind: "session", hostId: hostId ?? "", sessionId: target.session.id });
    setText("");
    // Turn 期间保持中断与权限回复可用，不把提交挂到全页 busy。
    void target.session
      .submit({ text: outgoing })
      .catch((e: unknown) => {
        if (!(e instanceof RpcError && e.code === "connection_closed"))
          setError(e instanceof Error ? e.message : "发送失败");
      })
      .finally(() => {
        void sessions.refresh().catch(() => undefined);
      });
  };
  return (
    <main className="phone">
      <header className="phone-header">
        <button
          aria-label="返回"
          disabled={page.kind === "hosts" && !offer}
          onClick={() => {
            if (offer) setOffer(undefined);
            else history.back();
          }}
        >
          返回
        </button>
        <h1>
          {offer
            ? "将与电脑配对"
            : page.kind === "hosts"
              ? "Nocturne"
              : page.kind === "about"
                ? "关于远程访问"
                : page.kind === "session"
                  ? (entry?.view.title ?? "会话")
                  : (hosts.find((h) => h.hostId === hostId)?.name ?? "电脑")}
        </h1>
        <button
          onClick={() => {
            navigate({ kind: "about" });
          }}
        >
          关于
        </button>
      </header>
      {error && (
        <p className="phone-error" role="alert">
          {error}
        </p>
      )}
      {connection && connection.state !== "online" && (
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
      {offer ? (
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
                  const paired = await pairPhone(storage, offer, location.origin, deviceName);
                  setOffer(undefined);
                  setHosts(await storage.hosts());
                  setInstallHint(iosBrowser() && !standalone());
                  navigate({ kind: "list", hostId: paired.hostId });
                } catch (e) {
                  throw new Error(pairingError(e));
                }
              });
            }}
          >
            {busy ? "正在配对…" : "确认配对"}
          </button>
        </section>
      ) : page.kind === "about" ? (
        <section className="phone-body">
          <h2>自己的电脑，随时继续</h2>
          <p>{TRUST_TEXT}</p>
          <p>
            这里只支持文字、消息与工具调用、权限与提问、中断。不支持附件、回退、文件访问或修改设置。
          </p>
        </section>
      ) : page.kind === "hosts" ? (
        <section className="phone-body">
          {!ready ? (
            <p role="status">正在读取手机存储…</p>
          ) : hosts.length === 0 ? (
            <>
              <h2>把会话带在身边</h2>
              {standalone() && (
                <p className="phone-pair-first">在主屏幕应用里，请先粘贴电脑复制的配对链接。</p>
              )}
              <p>在电脑的「设置 › 远程」登记中继，然后选择「配对新手机」，用相机扫码。</p>
              <p>{TRUST_TEXT}</p>
            </>
          ) : (
            <>
              <h2>已配对的电脑</h2>
              {hosts.map((computer) => (
                <div className="phone-host" key={computer.hostId}>
                  <button
                    onClick={() => {
                      navigate({ kind: "list", hostId: computer.hostId });
                    }}
                  >
                    {computer.name}
                    <small>打开会话列表</small>
                  </button>
                  <label>
                    电脑名称
                    <input
                      aria-label={`重命名 ${computer.name}`}
                      defaultValue={computer.name}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (name && name !== computer.name)
                          void operation(async () => {
                            await storage.putHost({ ...computer, name });
                            setHosts(await storage.hosts());
                          });
                      }}
                    />
                  </label>
                  <button
                    onClick={() => {
                      void operation(async () => {
                        await storage.removeHost(computer.hostId);
                        setHosts(await storage.hosts());
                        setError("已从手机移除。电脑上的设备记录请在电脑的『设置 › 远程』里移除");
                      });
                    }}
                  >
                    移除这台电脑
                  </button>
                </div>
              ))}
            </>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                setOffer(parsePairingLink(link, location.origin));
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
                placeholder="https://…/#pair=… 或 pair=…"
              />
            </label>
            <button className="phone-primary" disabled={!link.trim()}>
              继续配对
            </button>
          </form>
        </section>
      ) : page.kind === "list" ? (
        <section className="phone-body">
          <div className="phone-toolbar">
            <h2>会话</h2>
            <button
              disabled={!connected || busy}
              onClick={() => {
                void operation(() => sessions.refresh());
              }}
            >
              刷新
            </button>
            <button
              disabled={!connected || !knownWorkspaces(sessions.list).length}
              onClick={() => {
                setWorkspace(knownWorkspaces(sessions.list)[0] ?? "");
                navigate({ kind: "new", hostId: page.hostId });
              }}
            >
              新建会话
            </button>
          </div>
          {sessions.list.length === 0 && (
            <p>
              {connected
                ? "这台电脑还没有会话，请先在电脑上开始一个会话。"
                : "连接后会在这里显示会话。"}
            </p>
          )}
          {sessions.list.map((item) => {
            const opened = sessions.opened.get(item.id);
            const status = opened ? phoneStatus(opened) : "idle";
            return (
              <button
                className="phone-session-row"
                key={item.id}
                disabled={!connected || busy}
                onClick={() => {
                  navigate({ kind: "session", hostId: page.hostId, sessionId: item.id });
                  void operation(async () => {
                    await sessions.open(item.id);
                  });
                }}
              >
                <b>{opened?.view.title ?? item.firstText ?? "未命名会话"}</b>
                <small>
                  {projectName(item.cwd)}
                  <span className={`phone-badge ${status}`}>
                    {status === "pending" ? "待确认" : status === "running" ? "运行中" : "空闲"}
                  </span>
                </small>
              </button>
            );
          })}
          <button
            onClick={() => {
              navigate({ kind: "hosts" });
            }}
          >
            管理电脑与配对
          </button>
          <section className="phone-push" aria-label="推送通知">
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
                <button
                  disabled={push.state === "working" || push.state === "denied"}
                  onClick={() => {
                    void (push.state === "enabled" ? push.disable() : push.enable());
                  }}
                >
                  {push.state === "working"
                    ? "正在设置推送…"
                    : push.state === "enabled"
                      ? "关闭推送通知"
                      : "开启推送通知"}
                </button>
                {push.state === "enabled" && <small>已开启 · 只显示固定提醒，不发送会话内容</small>}
              </>
            )}
          </section>
        </section>
      ) : (
        <>
          {page.kind === "new" ? (
            <section className="phone-body">
              <h2>新建会话</h2>
              <label>
                工作区
                <select
                  value={workspace}
                  onChange={(e) => {
                    setWorkspace(e.target.value);
                  }}
                >
                  {knownWorkspaces(sessions.list).map((path) => (
                    <option value={path} key={path}>
                      {projectName(path)}
                    </option>
                  ))}
                </select>
              </label>
              <p>使用电脑的默认模型，仅能选择已有会话的工作区。</p>
            </section>
          ) : entry ? (
            <Conversation
              session={entry.session}
              view={entry.view}
              openUrl={(url) => {
                host.openUrl(url);
              }}
              cwd={entry.workspace}
              images={images}
              busy={entry.view.currentTurn !== undefined}
              hidePersistentPermissions
              hideRequests
              subscribeEvents={(listener) =>
                entry.client.onEvent((id, event) => {
                  if (id === entry.session.id) listener(event);
                })
              }
            />
          ) : (
            <section className="phone-body">
              <p role="status">正在打开会话…</p>
            </section>
          )}
          <form
            className="phone-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void operation(submit);
            }}
          >
            <textarea
              aria-label="消息"
              placeholder="发送文字消息…"
              value={text}
              rows={2}
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
            <div>
              <button
                type="button"
                disabled={!connected || !entry?.view.currentTurn}
                onClick={() => entry?.session.interrupt()}
              >
                中断
              </button>
              <button
                className="phone-primary"
                disabled={
                  !connected || busy || !text.trim() || entry?.view.currentTurn !== undefined
                }
              >
                发送
              </button>
            </div>
          </form>
          {entry &&
            replySession &&
            pendingKey !== dismissed &&
            connected &&
            (entry.view.pendingPermission ?? entry.view.pendingQuestion) && (
              <div
                className="phone-sheet"
                role="dialog"
                aria-modal="true"
                aria-label={entry.view.pendingPermission ? "权限面板" : "提问面板"}
              >
                {entry.view.pendingPermission ? (
                  <PermissionCard
                    key={pendingKey}
                    pending={entry.view.pendingPermission}
                    session={replySession}
                    cwd={entry.workspace}
                    hidePersistentPermissions
                  />
                ) : entry.view.pendingQuestion ? (
                  <QuestionCard
                    key={pendingKey}
                    pending={entry.view.pendingQuestion}
                    session={replySession}
                  />
                ) : null}
              </div>
            )}
        </>
      )}
      {connection?.state === "revoked" && hostId && (
        <button
          className="phone-remove"
          onClick={() => {
            void operation(async () => {
              await storage.removeHost(hostId);
              setHosts(await storage.hosts());
              navigate({ kind: "hosts" });
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
