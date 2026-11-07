import { useEffect, useRef, useState } from "react";
import type { ApplicationTarget, PermissionAction } from "@nocturne/core/protocol";
import type { ComputerDescription, RpcComputer } from "@nocturne/rpc/client";
import { Dropdown } from "./Dropdown";
import type { PrefsStore } from "./prefs";
import { Button, PageHeader, SettingsGroup, SettingsRow, Switch } from "./ui";

const ACTIONS = [
  { value: "allow", label: "允许" },
  { value: "ask", label: "询问" },
  { value: "deny", label: "拒绝" },
] as const;
const COLORS = ["#3b78c4", "#1f7a46", "#d9a227", "#c8509a", "#2f80c9", "#2aae67"];
function colorOf(identity: string): string {
  let hash = 0;
  for (let i = 0; i < identity.length; i += 1) hash += identity.charCodeAt(i);
  return COLORS[hash % COLORS.length] ?? "#3b78c4";
}
function stateLabel(
  state: NonNullable<ComputerDescription["state"]>["state"],
  enabled: boolean,
): string {
  return !enabled || state === "stopped"
    ? "未启动"
    : state === "starting"
      ? "启动中"
      : state === "running"
        ? "运行中"
        : "启动失败";
}
export function ComputerSettingsPage({
  computer,
  prefs,
  version,
  pickExecutable,
  hotkeyBound = true,
}: {
  computer?: RpcComputer | undefined;
  prefs: PrefsStore;
  version: number;
  pickExecutable?: (() => Promise<string | null>) | undefined;
  hotkeyBound?: boolean | undefined;
}) {
  const [description, setDescription] = useState<ComputerDescription | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState<ApplicationTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!computer) return;
    let live = true;
    const stop = computer.onChanged((next) => {
      if (live) setDescription(next);
    });
    void computer
      .describe()
      .then((next) => {
        if (live) setDescription(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [computer, version]);
  useEffect(() => {
    if (!adding) return;
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setAdding(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAdding(false);
    };
    window.addEventListener("click", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [adding]);

  const state = description?.state;
  const enabled = state?.enabled ?? prefs.get().computerEnabled === true;
  const cursor = state?.cursor ?? prefs.get().computerCursor !== false;
  const rules = description?.rules ?? [];
  const otherAction = rules.find((rule) => rule.pattern === "*")?.action ?? "ask";
  const specific = rules.filter((rule) => rule.pattern !== "*");
  const listed = new Set(specific.map((rule) => rule.pattern.toLowerCase()));

  const run = async (work: () => Promise<ComputerDescription>) => {
    setBusy(true);
    try {
      setDescription(await work());
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="page3" aria-label="电脑操控">
      <div className="spage">
        <div className="readable">
          <PageHeader title="电脑操控" />
          <div className="sbody">
            <SettingsGroup>
              <SettingsRow label="电脑操控">
                <Switch
                  aria-label="电脑操控"
                  checked={enabled}
                  disabled={busy || !computer}
                  onChange={(next) => {
                    if (next) {
                      setConfirming(true);
                      return;
                    }
                    prefs.update({ computerEnabled: false });
                    if (computer) void run(() => computer.setEnabled(false));
                  }}
                />
              </SettingsRow>
              {confirming && (
                <SettingsRow
                  label="模型能看到你的屏幕，并在允许的软件里替你点击和输入。"
                  role="alertdialog"
                  ariaLabel="启用电脑操控"
                >
                  <Button
                    size="sm"
                    onClick={() => {
                      setConfirming(false);
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !computer}
                    onClick={() => {
                      setConfirming(false);
                      prefs.update({ computerEnabled: true });
                      if (computer) void run(() => computer.setEnabled(true));
                    }}
                  >
                    仍然启用
                  </Button>
                </SettingsRow>
              )}
              <SettingsRow label="驱动" dimmed={!enabled}>
                <span
                  className={`computer-dot${state?.state === "running" && enabled ? "" : " stopped"}`}
                >
                  {state?.state === "running" && enabled && !hotkeyBound
                    ? "运行中（停止快捷键未绑定）"
                    : stateLabel(state?.state ?? "stopped", enabled)}
                </span>
                <span className="num">cua-driver {state?.version ?? "0.40.2"}</span>
                <Button
                  size="sm"
                  disabled={!enabled || busy || !computer}
                  onClick={() => {
                    if (computer) void run(() => computer.restart());
                  }}
                >
                  重启
                </Button>
              </SettingsRow>
              <SettingsRow label="显示光标" dimmed={!enabled}>
                <Switch
                  aria-label="显示光标"
                  checked={cursor}
                  disabled={!enabled || busy || !computer}
                  onChange={(next) => {
                    prefs.update({ computerCursor: next });
                    if (computer) void run(() => computer.setCursor(next));
                  }}
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="权限" className={enabled ? undefined : "off"}>
              <SettingsRow label="其他软件" dimmed={!enabled}>
                <Dropdown
                  label="其他软件"
                  value={otherAction}
                  options={ACTIONS}
                  disabled={enabled ? undefined : "请先开启电脑操控"}
                  onChange={(value) => {
                    if (computer)
                      void run(() =>
                        computer.setPermission({
                          identity: "*",
                          action: value === "ask" ? null : (value as PermissionAction),
                        }),
                      );
                  }}
                />
              </SettingsRow>
              {specific.map((rule) => {
                const name = rule.app?.name ?? rule.pattern;
                return (
                  <SettingsRow
                    key={rule.pattern}
                    dimmed={!enabled}
                    label={
                      <span className="computer-app">
                        <span
                          className="app-ic"
                          style={{
                            background: rule.app?.icon ? "transparent" : colorOf(rule.pattern),
                          }}
                        >
                          {rule.app?.icon ? (
                            <img src={`data:image/png;base64,${rule.app.icon}`} alt="" />
                          ) : (
                            (name[0] ?? "A")
                          )}
                        </span>
                        <span className="app-name">{name}</span>
                        {/\.exe$/iu.test(rule.pattern) && (
                          <span className="exe in-row">{rule.pattern}</span>
                        )}
                      </span>
                    }
                  >
                    <Dropdown
                      label={name}
                      value={rule.action}
                      options={ACTIONS}
                      disabled={enabled ? undefined : "请先开启电脑操控"}
                      onChange={(value) => {
                        if (computer)
                          void run(() =>
                            computer.setPermission({
                              identity: rule.pattern,
                              action: value as PermissionAction,
                              app: rule.app,
                            }),
                          );
                      }}
                    />
                    <button
                      type="button"
                      className="icon-x"
                      aria-label={`移除 ${name}`}
                      disabled={!enabled || busy}
                      onClick={() => {
                        if (computer)
                          void run(() =>
                            computer.setPermission({ identity: rule.pattern, action: null }),
                          );
                      }}
                    >
                      ×
                    </button>
                  </SettingsRow>
                );
              })}
              <div className="computer-add-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="computer-add"
                  aria-label="添加软件"
                  disabled={!enabled || busy || !computer}
                  onClick={() => {
                    if (adding) {
                      setAdding(false);
                      return;
                    }
                    setAdding(true);
                    void computer
                      ?.runningApps()
                      .then(setRunning)
                      .catch(() => {
                        setRunning([]);
                      });
                  }}
                >
                  + 添加软件
                </button>
                {adding && (
                  <div className="computer-apps-menu" role="listbox" aria-label="添加软件">
                    {running.map((app) => {
                      const identity = app.identity ?? "";
                      const name = app.name ?? identity;
                      const exists = listed.has(identity.toLowerCase());
                      return (
                        <button
                          key={identity}
                          type="button"
                          role="option"
                          aria-selected={false}
                          aria-disabled={exists ? "true" : undefined}
                          disabled={exists}
                          onClick={() => {
                            setAdding(false);
                            if (computer && identity)
                              void run(() =>
                                computer.setPermission({
                                  identity,
                                  action: "ask",
                                  app: { name, icon: app.icon },
                                }),
                              );
                          }}
                        >
                          <span
                            className="app-ic"
                            style={{ background: app.icon ? "transparent" : colorOf(identity) }}
                          >
                            {app.icon ? (
                              <img src={`data:image/png;base64,${app.icon}`} alt="" />
                            ) : (
                              (name[0] ?? "A")
                            )}
                          </span>
                          <span>{name}</span>
                          {!app.packageFamilyName && /\.exe$/iu.test(identity) && (
                            <span className="exe">{identity}</span>
                          )}
                        </button>
                      );
                    })}
                    {pickExecutable !== undefined && (
                      <button
                        type="button"
                        onClick={() => {
                          setAdding(false);
                          void pickExecutable()
                            .then((file) => {
                              const exe = file?.split(/[/\\]/u).pop()?.toLowerCase();
                              if (computer && exe?.endsWith(".exe")) {
                                const name = exe.slice(0, -4);
                                void run(() =>
                                  computer.setPermission({
                                    identity: exe,
                                    action: "ask",
                                    app: { name },
                                  }),
                                );
                              }
                            })
                            .catch(() => undefined);
                        }}
                      >
                        浏览…
                      </button>
                    )}
                  </div>
                )}
              </div>
            </SettingsGroup>
          </div>
        </div>
      </div>
    </section>
  );
}
