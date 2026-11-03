import { useEffect, useRef, useState } from "react";
import type { PermissionPresetName } from "@nocturne/core/protocol";
import type {
  AgentDevice,
  AgentPairingRequest,
  AgentPipeFailureReason,
  AgentPipeStatus,
  AgentScope,
  RemoteStatus,
  RpcClient,
} from "@nocturne/rpc/client";
import qrcode from "qrcode-generator";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { Scrim } from "./ProvidersPage";
import { REMOTE_CONNECTION_TEXT, useRemoteStatus } from "./remote";
import {
  Badge,
  Button,
  Switch,
  EmptyState,
  Field,
  ICON_SM,
  Icon,
  PageHeader,
  SettingsGroup,
  SettingsRow,
} from "./ui";
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
const PAIR_PRESET_OPTIONS: DropdownOption[] = [
  { value: "read-only", label: "只读 (read-only)" },
  { value: "default", label: "默认 (default)" },
  { value: "auto-edit", label: "自动编辑 (auto-edit)" },
  { value: "guarded", label: "受控 (guarded)" },
  { value: "smart", label: "智能审查 (smart)" },
  { value: "bypass", label: "无限制 (bypass)" },
];
const AGENT_SCOPE_OPTIONS: DropdownOption[] = [
  { value: "read-only", label: "只读" },
  { value: "run", label: "可运行" },
];
const AGENT_CAP_OPTIONS: DropdownOption[] = [
  { value: "read-only", label: "上限：只读" },
  { value: "default", label: "上限：默认" },
  { value: "auto-edit", label: "上限：自动编辑" },
  { value: "guarded", label: "上限：受控" },
  { value: "smart", label: "上限：智能审查" },
  { value: "bypass", label: "上限：无限制" },
];
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
            <label htmlFor="remote-pair-url">配对链接</label>
            <div className="remote-link">
              <input id="remote-pair-url" className="input lg mono" readOnly value={offer.url} />
              <Button
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
              </Button>
            </div>
          </>
        )}
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Scrim>
  );
}

export function AgentPairingDialog({
  client,
  request,
  onDone,
}: {
  client: RpcClient;
  request: AgentPairingRequest;
  onDone?: () => void;
}) {
  const [scope, setScope] = useState<AgentScope>("run");
  const [maxPreset, setMaxPreset] = useState<PermissionPresetName>("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const respond = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await client.call("agent.respondPairing", {
        requestId: request.requestId,
        approved,
        ...(approved ? { scope, maxPermissionPreset: maxPreset } : {}),
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scrim
      onClose={() => {
        void respond(false);
      }}
    >
      <div
        className="dlg remote-pair agent-pair-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="外部 Agent 接入请求"
      >
        <h3>外部 Agent 接入请求</h3>
        <div className="agent-pair-meta">
          <div>
            <span>名称</span>
            <b>{request.name}</b>
          </div>
          <div>
            <span>公钥指纹</span>
            <code>{request.fingerprint}</code>
          </div>
          {request.processInfo && (
            <div>
              <span>进程</span>
              <code>
                PID {request.processInfo.pid}
                {request.processInfo.command ? ` · ${request.processInfo.command}` : ""}
              </code>
            </div>
          )}
        </div>
        <div className="agent-pair-options" role="radiogroup" aria-label="授权范围">
          <label className={`agent-scope-opt${scope === "read-only" ? " selected" : ""}`}>
            <input
              type="radio"
              name="agent-scope"
              value="read-only"
              checked={scope === "read-only"}
              onChange={() => {
                setScope("read-only");
              }}
            />
            <b>只读</b>
          </label>
          <label className={`agent-scope-opt${scope === "run" ? " selected" : ""}`}>
            <input
              type="radio"
              name="agent-scope"
              value="run"
              checked={scope === "run"}
              onChange={() => {
                setScope("run");
              }}
            />
            <b>可运行</b>
          </label>
        </div>
        {scope === "run" && (
          <div className="agent-preset-field">
            <span className="flabel">新建会话权限上限</span>
            <Dropdown
              label="新建会话权限上限"
              value={maxPreset}
              options={PAIR_PRESET_OPTIONS}
              onChange={(next) => {
                setMaxPreset(next as PermissionPresetName);
              }}
            />
          </div>
        )}
        {error && (
          <p className="remote-error" role="alert">
            {error}
          </p>
        )}
        <div className="remote-actions agent-pair-actions">
          <Button
            disabled={busy}
            onClick={() => {
              void respond(false);
            }}
          >
            拒绝
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              void respond(true);
            }}
          >
            批准
          </Button>
        </div>
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
      <div className="spage">
        <div className="readable">
          <PageHeader
            title="远程"
            actions={
              status?.registered ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy || status.connection !== "online" || !client}
                  onClick={() => {
                    void operation(async () => {
                      if (client) setOffer(await client.call("remote.startPairing", {}));
                    });
                  }}
                >
                  配对新手机
                </Button>
              ) : undefined
            }
          />
          <div className="sbody">
            {error && (
              <p className="remote-error" role="alert">
                {error}
              </p>
            )}
            {!status ? (
              <p role="status">正在读取远程状态…</p>
            ) : !status.registered ? (
              <>
                <SettingsGroup title="让手机连到这台电脑">
                  <div className="remote-setup">
                    <p>向中继管理员索取一次性邀请</p>
                    <Field label="中继邀请" htmlFor="remote-invite">
                      <div className="remote-link">
                        <input
                          id="remote-invite"
                          className="input lg mono"
                          value={invite}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="粘贴邀请（nocturne-invite:…）"
                          onChange={(event) => {
                            setInvite(event.target.value);
                          }}
                        />
                        <Button
                          variant="primary"
                          disabled={busy || !client || !invite.trim()}
                          onClick={() => {
                            void operation(async () => {
                              await client?.call("remote.register", { invite });
                              setInvite("");
                            });
                          }}
                        >
                          {busy ? "登记中…" : "登记"}
                        </Button>
                      </div>
                    </Field>
                  </div>
                </SettingsGroup>
              </>
            ) : (
              <>
                <SettingsGroup title="中继">
                  <SettingsRow label={status.relay ? new URL(status.relay.origin).host : "中继"}>
                    <Badge
                      variant={
                        status.connection === "online"
                          ? "ok"
                          : status.connection === "connecting"
                            ? "neutral"
                            : "warn"
                      }
                    >
                      {REMOTE_CONNECTION_TEXT[status.connection]}
                    </Badge>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirm({ kind: "unregister" });
                      }}
                    >
                      退出登记
                    </Button>
                  </SettingsRow>
                  <SettingsRow label="允许远程访问">
                    {" "}
                    <Switch
                      aria-label="允许远程访问"
                      checked={status.enabled}
                      disabled={busy || !client}
                      onChange={(next) => {
                        void operation(
                          () =>
                            client?.call("remote.setEnabled", { enabled: next }) ??
                            Promise.resolve(),
                        );
                      }}
                    />
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup
                  title="已配对设备"
                  count={status.devices.length}
                  plain={status.devices.length === 0}
                >
                  {status.devices.length === 0 ? (
                    <EmptyState inline>还没有配对手机</EmptyState>
                  ) : (
                    status.devices.map((device) => (
                      <SettingsRow
                        key={device.id}
                        label={device.name}
                        badge={device.online ? <Badge variant="ok">在线</Badge> : undefined}
                        desc={
                          <>
                            {device.online ? "在线" : "离线"}，
                            {device.lastSeenAt
                              ? `最近在线 ${new Date(device.lastSeenAt).toLocaleString("zh-CN")}`
                              : "尚未上线"}
                            ，{device.push ? "已订阅推送" : "无推送订阅"}
                          </>
                        }
                      >
                        <div className="remote-actions">
                          <Button
                            size="sm"
                            disabled={
                              busy || !status.connections.some((c) => c.deviceId === device.id)
                            }
                            onClick={() => {
                              void operation(
                                () =>
                                  client?.call("remote.disconnectDevice", { id: device.id }) ??
                                  Promise.resolve(),
                              );
                            }}
                          >
                            断开
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy || status.connection !== "online"}
                            onClick={() => {
                              setConfirm({ kind: "remove", id: device.id, name: device.name });
                            }}
                          >
                            移除
                          </Button>
                        </div>
                      </SettingsRow>
                    ))
                  )}
                </SettingsGroup>
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
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setConfirm(undefined);
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        variant="danger-solid"
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
                      </Button>
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
            <ExternalAgentsSection
              client={client}
              agents={status?.agents ?? []}
              pipe={status?.agentPipe}
              busy={busy}
              onOperate={operation}
            />
            <details className="remote-trust group">
              <summary>
                <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
                中继只转发密文，看不到你的对话、代码或命令。你需要信任谁
              </summary>
              <p className="desc">
                手机网页由中继管理员提供：你需要信任管理员不会篡改网页，并妥善保护服务器。被篡改的网页可以在手机解密后读取内容，端到端加密无法防止这一点。
              </p>
              <p className="desc">
                本机配对用于可见性与误触发隔离，防不住本机同一用户下的恶意程序。
              </p>
            </details>
          </div>
        </div>
      </div>
      {offer && client && <PairingDialog client={client} offer={offer} onClose={closePairing} />}
      {client && status?.pendingAgentPairings?.[0] && (
        <AgentPairingDialog client={client} request={status.pendingAgentPairings[0]} />
      )}
    </div>
  );
}

const AGENT_PIPE_FAILURE_TEXT: Record<AgentPipeFailureReason, string> = {
  address_in_use:
    "本机 agent 管道未启动：另一个 Nocturne 后台已占用该管道，外部 agent 会连到那一个",
  sid_unavailable: "本机 agent 管道未启动：无法获取当前 Windows 用户 SID",
  acl_failed: "本机 agent 管道未启动：无法收紧管道访问权限",
  other: "本机 agent 管道未启动",
};

function ExternalAgentsSection({
  client,
  agents,
  pipe,
  busy,
  onOperate,
}: {
  client: RpcClient | undefined;
  agents: AgentDevice[];
  pipe?: AgentPipeStatus | undefined;
  busy: boolean;
  onOperate: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const pipeMessage =
    pipe !== undefined && pipe.state !== "off" && pipe.state !== "listening"
      ? (pipe.message ?? AGENT_PIPE_FAILURE_TEXT[pipe.state])
      : undefined;
  const pipeFailed = pipeMessage !== undefined;
  return (
    <SettingsGroup
      title={agents.length > 0 ? "外部 Agent" : undefined}
      count={agents.length}
      plain={agents.length === 0}
    >
      {pipeMessage !== undefined && (
        <p className="remote-warning" role="status">
          {pipeMessage}
        </p>
      )}
      {agents.length === 0
        ? !pipeFailed && <EmptyState inline>还没有已批准的外部 Agent</EmptyState>
        : agents.map((agent) => (
            <SettingsRow
              key={agent.id}
              label={agent.name}
              badge={agent.online ? <Badge variant="ok">在线</Badge> : undefined}
              desc={
                <>
                  {agent.online ? "在线" : "离线"} · 指纹 <code>{agent.fingerprint}</code>
                  {agent.lastSeenAt
                    ? ` · 最近活跃 ${new Date(agent.lastSeenAt).toLocaleString("zh-CN")}`
                    : ""}
                </>
              }
            >
              <div className="remote-actions">
                <Dropdown
                  label={`${agent.name} 范围`}
                  disabled={busy || !client ? "" : undefined}
                  value={agent.scope}
                  options={AGENT_SCOPE_OPTIONS}
                  onChange={(next) => {
                    const nextScope = next as AgentScope;
                    void onOperate(
                      () =>
                        client?.call("agent.setScope", {
                          id: agent.id,
                          scope: nextScope,
                          maxPermissionPreset: agent.maxPermissionPreset,
                        }) ?? Promise.resolve(),
                    );
                  }}
                />
                {agent.scope === "run" && (
                  <Dropdown
                    label={`${agent.name} 权限上限`}
                    disabled={busy || !client ? "" : undefined}
                    value={agent.maxPermissionPreset}
                    options={AGENT_CAP_OPTIONS}
                    onChange={(next) => {
                      const nextPreset = next as PermissionPresetName;
                      void onOperate(
                        () =>
                          client?.call("agent.setScope", {
                            id: agent.id,
                            scope: agent.scope,
                            maxPermissionPreset: nextPreset,
                          }) ?? Promise.resolve(),
                      );
                    }}
                  />
                )}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy || !client}
                  onClick={() => {
                    void onOperate(
                      () => client?.call("agent.revoke", { id: agent.id }) ?? Promise.resolve(),
                    );
                  }}
                >
                  吊销
                </Button>
              </div>
            </SettingsRow>
          ))}
    </SettingsGroup>
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
              <Button
                size="sm"
                onClick={() => {
                  if (client)
                    void client.call("remote.disconnectDevice", { id: d.deviceId }).catch(() => {
                      setError("断开失败，请重试");
                    });
                }}
              >
                断开
              </Button>
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
          <Button onClick={onOpen}>打开远程设置</Button>
        </div>
      )}
    </div>
  );
}
