import { useEffect, useRef, useState } from "react";
import type { RemoteStatus, RpcClient } from "@nocturne/rpc/client";
import qrcode from "qrcode-generator";
import { Scrim } from "./ProvidersPage";
import { REMOTE_CONNECTION_TEXT, useRemoteStatus } from "./remote";
import "./pages.css";
import "./mcp.css";
import "./remote.css";

export function qrModules(url: string): { size: number; path: string; count: number } {
  const code = qrcode(0, "M");
  code.addData(url, "Byte");
  code.make();
  const size = code.getModuleCount();
  let path = "",
    count = 0;
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) {
      if (code.isDark(row, col)) {
        path += `M${col + 4},${row + 4}h1v1h-1z`;
        count++;
      }
    }
  return { size: size + 8, path, count };
}
export function PairingQr({ url }: { url: string }) {
  const qr = qrModules(url);
  return (
    <svg
      className="remote-qr"
      role="img"
      aria-label="手机配对二维码"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#111" />
    </svg>
  );
}
const pairingErrors: Record<string, string> = {
  bad_mac: "配对密钥不匹配，请重新扫码",
  bad_signature: "设备签名校验失败，请重新配对",
  fingerprint_mismatch: "电脑身份不匹配，请重新扫码",
  limit: "已达到设备数量上限，请先移除旧设备",
  revoked: "此设备已被中继管理员吊销",
  timeout: "配对超时，请关闭后重新配对",
  closed: "配对连接已断开，请重新扫码",
  protocol_error: "配对报文无效，请重新扫码",
};
export function PairingDialog({
  client,
  offer,
  onClose,
}: {
  client: RpcClient;
  offer: { url: string; expiresAt: number };
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now()),
    [result, setResult] = useState(""),
    [success, setSuccess] = useState(false),
    [copied, setCopied] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    const paired = client.onNotification("remote.paired", ({ device }) => {
      setSuccess(true);
      setResult(`已配对：${device.name}`);
      closeTimer = setTimeout(() => {
        closeRef.current();
      }, 1600);
    });
    const failed = client.onNotification("remote.pairingFailed", ({ code }) => {
      setResult(pairingErrors[code] ?? "配对失败，请重新扫码");
    });
    return () => {
      clearInterval(timer);
      clearTimeout(closeTimer);
      paired();
      failed();
    };
  }, [client]);
  const seconds = Math.max(0, Math.ceil((offer.expiresAt - now) / 1000));
  return (
    <Scrim onClose={onClose}>
      <div className="dlg remote-pair" role="dialog" aria-modal="true" aria-label="配对新手机">
        <h3>配对新手机</h3>
        <p>用手机相机扫描二维码，在手机上确认配对。</p>
        {!success && <PairingQr url={offer.url} />}
        <p role="status">
          {result ||
            (seconds > 0
              ? `链接将在 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后失效`
              : "链接已过期，请重新配对")}
        </p>
        {!success && (
          <>
            <label htmlFor="remote-pair-url">已打开过手机页面？复制链接到手机浏览器</label>
            <div className="remote-link">
              <input id="remote-pair-url" readOnly value={offer.url} />
              <button
                className="btn3"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(offer.url)
                    .then(() => {
                      setCopied(true);
                    })
                    .catch(() => {
                      setResult("复制失败，请手动复制链接");
                    });
                }}
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </>
        )}
        <button className="btn3" onClick={onClose}>
          关闭
        </button>
      </div>
    </Scrim>
  );
}

export function RemotePage({ client }: { client: RpcClient | undefined }) {
  const status = useRemoteStatus(client);
  const [invite, setInvite] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<{ url: string; expiresAt: number }>();
  const [confirm, setConfirm] = useState<
    { kind: "remove"; id: string; name: string } | { kind: "unregister" }
  >();
  const operation = async (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const closePairing = () => {
    setOffer(undefined);
    if (client) void client.call("remote.cancelPairing", {}).catch(() => undefined);
  };
  useEffect(
    () => () => {
      if (client && offer) void client.call("remote.cancelPairing", {}).catch(() => undefined);
    },
    [client, offer],
  );
  return (
    <div className="page3">
      <header className="ph3">
        <div className="grow">
          <h3>远程</h3>
        </div>
      </header>
      <div className="remote-body">
        {error && (
          <p className="remote-error" role="alert">
            {error}
          </p>
        )}
        {!status ? (
          <p role="status">正在读取远程状态…</p>
        ) : !status.registered ? (
          <>
            <h4>让手机连到这台电脑</h4>
            <p>
              远程控制让你在离开电脑时查看会话、发送文字、回答提问和确认操作。电脑需要保持运行。
            </p>
            <p>
              向中继管理员索取一次性邀请，粘贴在下方即可登记。也可以在自己的服务器上搭建中继，再为这台电脑生成邀请；部署说明将随中继提供。
            </p>
            <label htmlFor="remote-invite">中继邀请</label>
            <div className="remote-link">
              <input
                id="remote-invite"
                value={invite}
                autoComplete="off"
                spellCheck={false}
                placeholder="粘贴邀请（nocturne-invite:…）"
                onChange={(event) => {
                  setInvite(event.target.value);
                }}
              />
              <button
                className="btn3 primary"
                disabled={busy || !client || !invite.trim()}
                onClick={() => {
                  void operation(async () => {
                    await client?.call("remote.register", { invite });
                    setInvite("");
                  });
                }}
              >
                {busy ? "登记中…" : "登记"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="remote-heading">
              <div>
                <h4>{status.relay ? new URL(status.relay.origin).host : "中继"}</h4>
                <span className={`remote-state ${status.connection}`}>
                  {REMOTE_CONNECTION_TEXT[status.connection]}
                </span>
              </div>
              <button
                className={`mcp-switch${status.enabled ? " on" : ""}`}
                role="switch"
                aria-label="允许远程访问"
                aria-checked={status.enabled}
                disabled={busy || !client}
                onClick={() => {
                  void operation(
                    () =>
                      client?.call("remote.setEnabled", { enabled: !status.enabled }) ??
                      Promise.resolve(),
                  );
                }}
              />
            </div>
            <p>
              允许远程访问
              <span className="muted-value">{status.enabled ? "已开启" : "已关闭"}</span>
            </p>
            <section className="remote-devices">
              <div className="remote-heading">
                <h4>已配对设备</h4>
                <button
                  className="btn3"
                  disabled={busy || status.connection !== "online" || !client}
                  onClick={() => {
                    void operation(async () => {
                      if (client) setOffer(await client.call("remote.startPairing", {}));
                    });
                  }}
                >
                  配对新手机
                </button>
              </div>
              {status.devices.length === 0 ? (
                <p>还没有配对手机。扫码后，这台手机才能访问你的会话。</p>
              ) : (
                status.devices.map((device) => (
                  <div className="remote-device" key={device.id}>
                    <div>
                      <b>{device.name}</b>
                      <p>
                        {device.online ? "在线" : "离线"}，
                        {device.lastSeenAt
                          ? `最近在线 ${new Date(device.lastSeenAt).toLocaleString("zh-CN")}`
                          : "尚未上线"}
                        ，{device.push ? "已订阅推送" : "无推送订阅"}
                      </p>
                    </div>
                    <div className="remote-actions">
                      <button
                        className="btn3"
                        disabled={busy || !status.connections.some((c) => c.deviceId === device.id)}
                        onClick={() => {
                          void operation(
                            () =>
                              client?.call("remote.disconnectDevice", { id: device.id }) ??
                              Promise.resolve(),
                          );
                        }}
                      >
                        断开
                      </button>
                      <button
                        className="btn3"
                        disabled={busy || status.connection !== "online"}
                        onClick={() => {
                          setConfirm({ kind: "remove", id: device.id, name: device.name });
                        }}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </section>
            <button
              className="btn3"
              disabled={busy}
              onClick={() => {
                setConfirm({ kind: "unregister" });
              }}
            >
              退出登记
            </button>
            {confirm && (
              <div
                className="remote-confirm"
                role="alertdialog"
                aria-label={confirm.kind === "remove" ? "移除设备确认" : "退出登记确认"}
              >
                <p>
                  {confirm.kind === "remove"
                    ? `移除「${confirm.name}」？移除后需要重新扫码配对。`
                    : "退出登记并移除所有配对设备？所有手机连接将断开。"}
                </p>
                <div className="remote-actions">
                  <button
                    className="btn3"
                    disabled={busy}
                    onClick={() => {
                      setConfirm(undefined);
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="btn3 primary"
                    disabled={busy}
                    onClick={() => {
                      void operation(async () => {
                        if (client) {
                          if (confirm.kind === "remove")
                            await client.call("remote.removeDevice", { id: confirm.id });
                          else await client.call("remote.unregister", {});
                          setConfirm(undefined);
                        }
                      });
                    }}
                  >
                    确认{confirm.kind === "remove" ? "移除" : "退出登记"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {status?.warnings.map((warning) => (
          <p className="remote-warning" key={warning}>
            {warning}
          </p>
        ))}
        <section className="remote-trust">
          <p>中继只转发密文，看不到你的对话、代码或命令。</p>
          <details>
            <summary>你需要信任谁</summary>
            <p>
              手机网页由中继管理员提供：你需要信任管理员不会篡改网页，并妥善保护服务器。被篡改的网页可以在手机解密后读取内容，端到端加密无法防止这一点。
            </p>
          </details>
        </section>
      </div>
      {offer && client && <PairingDialog client={client} offer={offer} onClose={closePairing} />}
    </div>
  );
}

export function RemoteBadge({
  status,
  client,
  onOpen,
}: {
  status: RemoteStatus | undefined;
  client: RpcClient | undefined;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  if (!status?.registered) return null;
  if (status.connection === "revoked" || status.connection === "replaced")
    return (
      <button className="status-item remote-warning" onClick={onOpen}>
        远程<span className="muted-value">{REMOTE_CONNECTION_TEXT[status.connection]}</span>
      </button>
    );
  if (status.connections.length === 0) return null;
  const devices = [...new Map(status.connections.map((c) => [c.deviceId, c])).values()];
  return (
    <div
      className="remote-badge"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className="status-item"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {devices.length === 1 ? "手机在线" : `手机在线 ${devices.length}`}
      </button>
      {open && (
        <div className="remote-panel" role="dialog" aria-label="在线手机">
          <h4>在线手机</h4>
          {devices.map((d) => (
            <div className="remote-device" key={d.deviceId}>
              <span>{d.name}</span>
              <button
                className="btn3"
                onClick={() => {
                  if (client)
                    void client.call("remote.disconnectDevice", { id: d.deviceId }).catch(() => {
                      setError("断开失败，请重试");
                    });
                }}
              >
                断开
              </button>
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
          <button className="btn3" onClick={onOpen}>
            打开远程设置
          </button>
        </div>
      )}
    </div>
  );
}
