/**
 * 设置区的常规 / 模型 / 外观三页（desktop-v4.html A、B、E 屏；服务商页在
 * ProvidersPage.tsx）：逐项保存（ADR-0045 第 7 节）。单值项改完立即写
 * settings.json；复合项开对话框，对话框里「保存」才落盘；失败时值回到原样，
 * 这一行下面写红字。主题与普通对话工作区只写本机 prefs，不进 Core。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PermissionPresetName, ReasoningEffort } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { presetOptions } from "./choice-info";
import { Dropdown } from "./Dropdown";
import {
  DONE_THRESHOLD_CHOICES,
  NOTIFY_DEFAULTS,
  thresholdLabel,
  type NotifyResult,
} from "./notify";
import { Scrim } from "./ProvidersPage";
import { refKey, shellGroups } from "./session-controls";
import { modelKeyText, modelRefText } from "./model-ref";
import { ChoiceMenu } from "./Menu";
import type {
  JevEndpoint,
  JevReviewerConfig,
  ModelInfo,
  ReviewerRules,
  ReviewerSampleResult,
  SecurityReviewerConfig,
  SettingItem,
  SettingsPatch,
} from "./rpc-types";
import { describeUpdateError, type CheckResult } from "./updater";
import type { AgentBrowserHost } from "./host";
import { FILE_OPENER_LABELS, isFileOpener, type FileOpener, type PrefsStore } from "./prefs";
import { LAYER_TEXT, sourceMarker } from "./setting-source";
import {
  Button,
  Checkbox,
  DataTable,
  Field,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  Switch,
} from "./ui";

export type ThemePref = "system" | "light" | "dark";

/** 设置区里由本组件渲染的导航项（服务商页另见 ProvidersPage） */
export type SettingsPageSection = "general" | "models" | "appearance";

const SECTION_HEAD: Record<SettingsPageSection, { title: string }> = {
  general: { title: "常规" },
  models: { title: "模型" },
  appearance: { title: "外观" },
};

const THEMES: { value: ThemePref; label: string; sub?: string; cls: string }[] = [
  { value: "system", label: "跟随系统", cls: "sys" },
  { value: "light", label: "月之亮面", sub: "浅色", cls: "" },
  { value: "dark", label: "月之暗面", sub: "深色", cls: "dk" },
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 通知一节的键（ADR-0056）：「通知内容」三项在界面里同处一行 */
const NOTIFY_EVENT_KEYS = [
  "notifications.events.attention",
  "notifications.events.error",
  "notifications.events.done",
] as const;
const NOTIFY_THRESHOLD_KEYS = ["notifications.doneAfterSeconds"] as const;
const NOTIFY_TEST_KEY = "notifications.test";

type RoleKey = "task" | "vision" | "smol";
const ROLES: { role: RoleKey; label: string; unset: string }[] = [
  { role: "task", label: "子代理模型", unset: "跟随当前模型" },
  { role: "vision", label: "视觉模型", unset: "未设置" },
  { role: "smol", label: "轻量模型", unset: "跟随当前模型" },
];

const refText = modelKeyText;

/** 模型名与档位优先展示，服务商单独一行允许省略。off = 指向已停用模型（ADR-0054）。 */
function ModelValue({
  value,
  effort,
  off = false,
}: {
  value: string;
  effort?: string | undefined;
  off?: boolean;
}) {
  const at = value.indexOf("/");
  const provider = at < 0 ? "" : value.slice(0, at);
  const model = at < 0 ? value : value.slice(at + 1);
  return (
    <span className={`model-value${off ? " off" : ""}`} title={refText(value)}>
      <span className="model-primary">
        {model}
        {effort !== undefined && <span className="muted-value">{effort}</span>}
      </span>
      {provider !== "" && <span className="model-provider">{provider}</span>}
    </span>
  );
}

function reviewerText(cfg: SecurityReviewerConfig | undefined): ReactNode {
  if (cfg === undefined || cfg.backend === "off") return "关闭";
  if (cfg.backend === "model")
    return (
      <>
        模型<span className="muted-value">{refText(refKey(cfg.model))}</span>
      </>
    );
  const endpoint = cfg.endpoint === "custom" ? (cfg.baseURL ?? "自定义地址") : cfg.endpoint;
  return (
    <>
      Jev
      <span className="muted-value">{modelRefText({ provider: endpoint, model: cfg.model })}</span>
    </>
  );
}

export function SettingsPage({
  section,
  client,
  theme,
  fileOpener,
  editors,
  workspace,
  defaultWorkspace,
  workspaceOverridden,
  update,
  onThemeChange,
  onFileOpenerChange,
  onWorkspaceChange,
  pickFolder,
  providersVersion,
  notifications,
  onConfigSaved,
  onOpenSubagents,
  agentBrowser,
  prefs,
}: {
  section: SettingsPageSection;
  client: RpcClient | undefined;
  theme: ThemePref;
  /** 回答内文件引用"默认打开方式"（本机 prefs，不进 Core） */
  fileOpener: FileOpener;
  /** 已安装的编辑器（只列检测到的） */
  editors: { vscode: boolean; cursor: boolean };
  /** 生效的普通对话工作区（prefs 覆盖 ?? 默认） */
  workspace: string | null;
  /** 外壳 plain_workspace 默认路径（恢复默认用） */
  defaultWorkspace: string | null;
  /** prefs 里存了自选位置（显示「恢复默认」） */
  workspaceOverridden: boolean;
  /** 自动更新设置（ADR-0050）；桌面端总有 */
  update?: {
    /** 自动检查更新开关（默认开） */
    autoUpdate: boolean;
    /** 写本机 prefs；返回 false 表示写不进存储 */
    onAutoUpdateChange: (enabled: boolean) => boolean;
    /** 手动检查更新（不节流）；update 结果经 App 出全局提示条 */
    onCheck: () => Promise<CheckResult>;
  };
  /** 只写本机 prefs；返回 false 表示写不进存储 */
  onThemeChange: (theme: ThemePref) => boolean;
  /** 只写本机 prefs；返回 false 表示写不进存储 */
  onFileOpenerChange: (opener: FileOpener) => boolean;
  /** 切换普通对话工作区（null = 恢复默认）；返回错误文案或 undefined（成功） */
  onWorkspaceChange: (dir: string | null) => Promise<string | undefined>;
  pickFolder: () => Promise<string | null>;
  providersVersion: number;
  /**
   * 通知（ADR-0056）：「发送测试通知」走外壳同一个命令发一条测试通知；
   * 返回 shown=false + reason="disabled" 表示 Windows 关掉了本应用的通知权限。
   */
  notifications: { sendTest: (sound: boolean) => Promise<NotifyResult> };
  /** 写设置成功后调用：桌面端据此刷新会话列表 */
  onConfigSaved?: () => void;
  onOpenSubagents?: () => void;
  /** 面板浏览器 · 桌面内置（第 5 轮）；没有外壳时设置里不显示 */
  agentBrowser?: AgentBrowserHost | undefined;
  prefs?: PrefsStore | undefined;
}) {
  const [items, setItems] = useState<SettingItem[] | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [reviewerProviders, setReviewerProviders] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  /** 单值项保存中的乐观值；失败时清掉即回到原值 */
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    null | "defaultModel" | "reviewer" | "threshold" | { role: RoleKey }
  >(null);
  const [wsBusy, setWsBusy] = useState(false);
  const [shells, setShells] = useState<
    Awaited<ReturnType<NonNullable<typeof client>["runtime"]["listShells"]>>
  >([]);
  const [shellMenu, setShellMenu] = useState(false);
  const [shellBusy, setShellBusy] = useState(false);
  /** 「发送测试通知」：busy 防重复点；blocked = Windows 关掉了本应用的通知权限 */
  const [notifyTest, setNotifyTest] = useState<null | { busy: boolean; blocked: boolean }>(null);
  const shellTrigger = useRef<HTMLButtonElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (client === undefined) return;
    try {
      const [s, m, rp] = await Promise.all([
        client.runtime.describeSettings(),
        client.runtime.listModels(),
        client.runtime.listReviewerProviders(),
      ]);
      setItems(s);
      setModels(m);
      setReviewerProviders(rp.map((x) => x.id));
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh, providersVersion]);
  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
    }, 2200);
  };
  const setRowErr = (key: string, message: string | null) => {
    setRowError((cur) => {
      if (message !== null) return { ...cur, [key]: message };
      if (!(key in cur)) return cur;
      const { [key]: _removed, ...rest } = cur;
      return rest;
    });
  };

  /** 逐项保存：成功写回 items 并提示；失败把原因挂到该行（值仍是 items 里的原值） */
  const save = async (
    key: string,
    label: string,
    patch: SettingsPatch,
    options?: { reviewerKey: string },
  ): Promise<string | undefined> => {
    if (client === undefined) return "后台尚未就绪";
    setRowErr(key, null);
    try {
      const next = await client.runtime.updateSettings(patch, options);
      setItems(next);
      onConfigSaved?.();
      const value = next.find((x) => x.key === key)?.effective;
      showToast(`已保存 ${label}${value !== undefined ? ` = ${value}` : ""}`);
      return undefined;
    } catch (e) {
      const message = `保存失败：${errText(e)}，已恢复原值`;
      setRowErr(key, message);
      return errText(e);
    }
  };

  const item = (key: SettingItem["key"]) => items?.find((x) => x.key === key);
  /** ADR-0054：设置值指向停用模型（默认模型与模型角色都按未设置处理） */
  const modelOff = (value: string | undefined) =>
    value !== undefined &&
    items?.some((it) => it.effective === value && it.disabled !== undefined) === true;
  const defaultModelItem = item("defaultModel");
  const effortItem = item("reasoningEffort");
  const presetItem = item("permissions.preset");
  const reviewerItem = item("permission.reviewer");
  const reviewerRulesItem = item("permission.reviewerRules");
  const thresholdItem = item("compaction.threshold");
  const pruneLimitItem = item("compaction.pruneLimit");
  const shellItem = item("shell");
  const reviewerCfg = reviewerItem?.reviewer?.effective;

  // ── 通知（ADR-0056）：生效值读自 describeSettings，逐项保存 ──
  const notifyEnabled = item("notifications.enabled")?.effective !== "false";
  const notifyEvents = {
    attention: item("notifications.events.attention")?.effective !== "false",
    error: item("notifications.events.error")?.effective !== "false",
    done: item("notifications.events.done")?.effective !== "false",
  };
  const notifySound = item("notifications.sound")?.effective !== "false";
  /** 「通知内容」三个开关同处一行，共用一个来源标记：显示被覆盖的一项，否则第一项 */
  const notifyEventsMarker = () => {
    const list = NOTIFY_EVENT_KEYS.map((key) => item(key));
    return sourceMarker(list.find((entry) => entry?.overridden === true) ?? list[0]);
  };
  /** 阈值下拉：保存值不在档位里时单列一项「N 秒」并保留（不悄悄改成别的值） */
  const notifyThreshold = (() => {
    const entry = item("notifications.doneAfterSeconds");
    const raw = Number(entry?.saved ?? entry?.effective ?? NOTIFY_DEFAULTS.doneAfterSeconds);
    const seconds = Number.isFinite(raw) && raw >= 0 ? raw : NOTIFY_DEFAULTS.doneAfterSeconds;
    const options = DONE_THRESHOLD_CHOICES.map((choice) => ({
      value: String(choice.seconds),
      label: choice.label,
      description: `用时不到 ${choice.label}的轮不提醒`,
    }));
    if (!DONE_THRESHOLD_CHOICES.some((choice) => choice.seconds === seconds)) {
      options.push({
        value: String(seconds),
        label: thresholdLabel(seconds),
        description: "已保存的值，不在常用档位里",
      });
    }
    return { seconds, options };
  })();

  /** 「发送测试通知」：走外壳同一个通知命令，发一条「这是一条测试通知」 */
  const runNotifyTest = async () => {
    setNotifyTest({ busy: true, blocked: false });
    setRowErr(NOTIFY_TEST_KEY, null);
    try {
      const result: NotifyResult = await notifications.sendTest(notifySound);
      if (result.shown) {
        setNotifyTest(null);
        showToast("已发送测试通知");
        return;
      }
      if (result.reason === "disabled") {
        setNotifyTest({ busy: false, blocked: true });
        return;
      }
      setNotifyTest(null);
      setRowErr(NOTIFY_TEST_KEY, `发送失败：${result.detail ?? result.reason ?? "未知原因"}`);
    } catch (error) {
      setNotifyTest(null);
      setRowErr(NOTIFY_TEST_KEY, `发送失败：${errText(error)}`);
    }
  };

  const changeWorkspace = async (dir: string | null) => {
    setWsBusy(true);
    try {
      const err = await onWorkspaceChange(dir);
      setRowErr("workspace", err === undefined ? null : `保存失败：${err}`);
      if (err === undefined) showToast("已保存 普通对话工作区");
    } finally {
      setWsBusy(false);
    }
  };

  /** 手动「检查更新」：不节流；发现新版本时经 App 出全局提示条，这里只报失败原因 */
  const [updBusy, setUpdBusy] = useState(false);
  const runUpdateCheck = async () => {
    if (update === undefined) return;
    setUpdBusy(true);
    setRowErr("updateCheck", null);
    try {
      const result = await update.onCheck();
      if (result.kind === "error") {
        setRowErr("updateCheck", describeUpdateError(result.message));
      } else if (result.kind === "latest") {
        showToast("已是最新版本");
      }
      // "update"：App 的全局提示条接管
    } finally {
      setUpdBusy(false);
    }
  };

  const head = SECTION_HEAD[section];
  const needsCore = section !== "appearance";
  /** 一行可能对应多个键（「通知内容」三项）：合并成一条红字 */
  const errs = (...keys: string[]): ReactNode => {
    const list = keys.flatMap((key) => (rowError[key] !== undefined ? [rowError[key]] : []));
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return list.map((message) => <div key={message}>{message}</div>);
  };
  return (
    <section className="page3" data-testid="settings-page" aria-label={head.title}>
      {toast !== null && (
        <div className="toast3" role="status">
          <b>✓</b>
          {toast}
        </div>
      )}
      <div className="spage">
        <div className="readable">
          <PageHeader title={head.title} />
          <div className="sbody">
            {needsCore && client === undefined && (
              <p className="desc">后台尚未就绪，稍后自动刷新。</p>
            )}
            {needsCore && loadError !== null && <p className="desc err">{loadError}</p>}
            {needsCore && client !== undefined && items === null && loadError === null && (
              <p className="desc">加载中…</p>
            )}
            {section === "general" && items !== null && (
              <>
                <SettingsGroup title="权限">
                  <SettingsRow
                    label="默认权限预设"
                    marker={sourceMarker(presetItem)}
                    error={errs("permissions.preset")}
                  >
                    <Dropdown
                      label="默认权限预设"
                      value={pendingPreset ?? presetItem?.saved ?? ""}
                      options={[
                        {
                          value: "",
                          label: "跟随默认",
                          tag: presetItem?.effective ?? "—",
                        },
                        ...presetOptions(),
                      ]}
                      onChange={(v) => {
                        setPendingPreset(v);
                        void save("permissions.preset", "默认权限预设", {
                          "permissions.preset": v === "" ? null : (v as PermissionPresetName),
                        }).finally(() => {
                          setPendingPreset(null);
                        });
                      }}
                    />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title="执行">
                  <SettingsRow
                    label="安全审查"
                    marker={sourceMarker(reviewerItem)}
                    error={errs("permission.reviewer")}
                  >
                    <span className="val">{reviewerText(reviewerCfg)}</span>
                    <Button
                      size="sm"
                      onClick={() => {
                        setDialog("reviewer");
                      }}
                    >
                      编辑
                    </Button>
                  </SettingsRow>
                  {shellItem !== undefined && (
                    <SettingsRow
                      label="Shell"
                      marker={sourceMarker(shellItem)}
                      error={errs("shell")}
                    >
                      {shellItem.source === "env" ||
                      shellItem.source === "user" ||
                      shellItem.source === "project" ? (
                        <>
                          <span className="val mono">{shellItem.effective ?? "自动"}</span>
                          <span className="val dim">
                            {shellItem.source === "env"
                              ? "由环境变量 NOCTURNE_SHELL 指定"
                              : `由${LAYER_TEXT[shellItem.source]}指定`}
                          </span>
                        </>
                      ) : (
                        <button
                          type="button"
                          ref={shellTrigger}
                          className="dd"
                          aria-label="Shell"
                          aria-haspopup="menu"
                          aria-expanded={shellMenu}
                          disabled={shellBusy}
                          onClick={() => {
                            if (shellMenu) {
                              setShellMenu(false);
                              return;
                            }
                            setRowErr("shell", null);
                            void client?.runtime
                              .listShells()
                              .then((detected) => {
                                setShells(detected);
                                setShellMenu(true);
                              })
                              .catch((e: unknown) => {
                                setRowErr("shell", errText(e));
                              });
                          }}
                        >
                          <span className="dd-label">
                            {shellItem.saved ?? shellItem.effective ?? "自动"}
                          </span>
                          <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
                            <path
                              d="M4 6l4 4 4-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      )}
                      {shellMenu && (
                        <ChoiceMenu
                          anchor={shellTrigger.current}
                          label="Shell"
                          control={{
                            value: shellItem.saved ?? "auto",
                            groups: shellGroups(
                              shells,
                              shellItem.effective === "auto" || shellItem.effective === undefined
                                ? (shells.find(
                                    (item) => item.available && item.kind !== "powershell",
                                  )?.kind ?? "—")
                                : shellItem.effective,
                            ),
                            onSelect: async (value) => {
                              if (!client) return;
                              setShellBusy(true);
                              setRowErr("shell", null);
                              try {
                                setItems(await client.runtime.setShellSetting(value));
                                onConfigSaved?.();
                              } catch (e) {
                                setRowErr("shell", errText(e));
                              } finally {
                                setShellBusy(false);
                              }
                            },
                          }}
                          onClose={() => {
                            setShellMenu(false);
                          }}
                        />
                      )}
                    </SettingsRow>
                  )}
                  <SettingsRow
                    label="压缩阈值"
                    marker={sourceMarker(
                      pruneLimitItem?.overridden ? pruneLimitItem : thresholdItem,
                    )}
                    error={errs("compaction.threshold")}
                  >
                    <span className="val">
                      {thresholdText(thresholdItem?.effective, pruneLimitItem?.effective)}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => {
                        setDialog("threshold");
                      }}
                    >
                      编辑
                    </Button>
                  </SettingsRow>
                  {agentBrowser !== undefined && prefs !== undefined && (
                    <AgentBrowserRows host={agentBrowser} prefs={prefs} onToast={showToast} />
                  )}
                </SettingsGroup>
              </>
            )}
            {section === "general" && (
              <SettingsGroup title="普通对话">
                <SettingsRow label="工作区" error={errs("workspace")}>
                  <span className="val mono" title={workspace ?? ""}>
                    {workspace ?? "未就绪"}
                  </span>
                  <Button
                    size="sm"
                    disabled={wsBusy || workspace === null}
                    onClick={() => {
                      void pickFolder().then((dir) => {
                        if (dir !== null) void changeWorkspace(dir);
                      });
                    }}
                  >
                    {wsBusy ? "切换中…" : "更改…"}
                  </Button>
                  {workspaceOverridden && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={wsBusy}
                      title={defaultWorkspace ?? undefined}
                      onClick={() => void changeWorkspace(null)}
                    >
                      恢复默认
                    </Button>
                  )}
                </SettingsRow>
                <SettingsRow label="默认打开方式" error={errs("fileOpener")}>
                  <Dropdown
                    label="默认打开方式"
                    value={fileOpener}
                    options={[
                      {
                        value: "panel",
                        label: "Nocturne 面板",
                      },
                      { value: "system", label: "系统默认程序", description: "不带行号" },
                      ...(editors.vscode
                        ? [{ value: "vscode", label: "VS Code", description: "带行号跳转" }]
                        : []),
                      ...(editors.cursor
                        ? [{ value: "cursor", label: "Cursor", description: "带行号跳转" }]
                        : []),
                    ]}
                    onChange={(value) => {
                      if (!isFileOpener(value)) return;
                      const ok = onFileOpenerChange(value);
                      setRowErr("fileOpener", ok ? null : "本机存储不可写，设置只在本次运行内生效");
                      showToast(`已保存 默认打开方式 = ${FILE_OPENER_LABELS[value]}`);
                    }}
                  />
                </SettingsRow>
              </SettingsGroup>
            )}
            {section === "general" && update !== undefined && (
              <SettingsGroup title="更新">
                <SettingsRow label="自动检查更新" error={errs("autoUpdate")}>
                  <Switch
                    checked={update.autoUpdate}
                    aria-label="自动检查更新"
                    onChange={(next) => {
                      const ok = update.onAutoUpdateChange(next);
                      setRowErr("autoUpdate", ok ? null : "本机存储不可写，开关只在本次运行内生效");
                    }}
                  />
                </SettingsRow>
                <SettingsRow label="检查更新" error={errs("updateCheck")}>
                  <Button size="sm" disabled={updBusy} onClick={() => void runUpdateCheck()}>
                    {updBusy ? "检查中…" : "检查更新"}
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            )}

            {section === "general" && items !== null && (
              <SettingsGroup title="通知">
                <SettingsRow
                  label="通知"
                  marker={sourceMarker(item("notifications.enabled"))}
                  error={errs("notifications.enabled")}
                >
                  <Switch
                    checked={notifyEnabled}
                    aria-label="通知"
                    onChange={(next) => {
                      void save("notifications.enabled", "通知", {
                        "notifications.enabled": next,
                      });
                    }}
                  />
                </SettingsRow>
                <SettingsRow
                  label="通知内容"
                  dimmed={!notifyEnabled}
                  marker={notifyEventsMarker()}
                  error={errs(...NOTIFY_EVENT_KEYS)}
                >
                  <Checkbox
                    checked={notifyEvents.attention}
                    aria-label="需要确认"
                    disabled={!notifyEnabled}
                    onChange={(next) => {
                      void save("notifications.events.attention", "需要确认", {
                        "notifications.events.attention": next,
                      });
                    }}
                  >
                    需要确认（权限、提问）
                  </Checkbox>
                  <Checkbox
                    checked={notifyEvents.error}
                    aria-label="出错停止"
                    disabled={!notifyEnabled}
                    onChange={(next) => {
                      void save("notifications.events.error", "出错停止", {
                        "notifications.events.error": next,
                      });
                    }}
                  >
                    出错停止
                  </Checkbox>
                  <Checkbox
                    checked={notifyEvents.done}
                    aria-label="完成"
                    disabled={!notifyEnabled}
                    onChange={(next) => {
                      void save("notifications.events.done", "完成", {
                        "notifications.events.done": next,
                      });
                    }}
                  >
                    完成
                  </Checkbox>
                </SettingsRow>
                <SettingsRow
                  label="提醒触发时长"
                  dimmed={!notifyEnabled || !notifyEvents.done}
                  marker={sourceMarker(item("notifications.doneAfterSeconds"))}
                  error={errs(...NOTIFY_THRESHOLD_KEYS)}
                >
                  <Dropdown
                    label="提醒触发时长"
                    value={String(notifyThreshold.seconds)}
                    options={notifyThreshold.options}
                    disabled={
                      !notifyEnabled
                        ? "通知已关闭"
                        : !notifyEvents.done
                          ? "未勾选「完成」"
                          : undefined
                    }
                    onChange={(value) => {
                      void save("notifications.doneAfterSeconds", "提醒触发时长", {
                        "notifications.doneAfterSeconds": Number(value),
                      });
                    }}
                  />
                </SettingsRow>
                <SettingsRow
                  label="提示音"
                  dimmed={!notifyEnabled}
                  marker={sourceMarker(item("notifications.sound"))}
                  error={errs("notifications.sound")}
                >
                  <Switch
                    checked={notifySound}
                    aria-label="提示音"
                    disabled={!notifyEnabled}
                    onChange={(next) => {
                      void save("notifications.sound", "提示音", {
                        "notifications.sound": next,
                      });
                    }}
                  />
                </SettingsRow>
                <SettingsRow
                  label="试一下"
                  dimmed={!notifyEnabled}
                  warning={
                    notifyTest?.blocked === true
                      ? "Windows 已关闭 Nocturne 的通知，请到 系统 › 通知 打开"
                      : undefined
                  }
                  error={errs(NOTIFY_TEST_KEY)}
                >
                  <Button
                    size="sm"
                    disabled={!notifyEnabled || notifyTest?.busy === true}
                    onClick={() => void runNotifyTest()}
                  >
                    {notifyTest?.busy === true ? "发送中…" : "发送测试通知"}
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            )}

            {section === "models" && items !== null && (
              <>
                <SettingsGroup title="默认">
                  <SettingsRow
                    label="默认模型与档位"
                    marker={sourceMarker(defaultModelItem)}
                    warning={
                      modelOff(defaultModelItem?.effective)
                        ? "已停用，按未设置处理：新会话需要先选模型"
                        : undefined
                    }
                    error={errs("defaultModel")}
                  >
                    {defaultModelItem?.effective === undefined ? (
                      <span className="val dim">未设置</span>
                    ) : (
                      <ModelValue
                        value={defaultModelItem.effective}
                        effort={effortItem?.effective}
                        off={modelOff(defaultModelItem.effective)}
                      />
                    )}
                    <Button
                      size="sm"
                      onClick={() => {
                        setDialog("defaultModel");
                      }}
                    >
                      选择
                    </Button>
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title="模型角色">
                  {ROLES.map(({ role, label, unset }) => {
                    const key = `modelRoles.${role}` as const;
                    const it = item(key);
                    return (
                      <SettingsRow
                        key={role}
                        label={label}
                        marker={sourceMarker(it)}
                        warning={modelOff(it?.effective) ? "已停用，按未设置处理" : undefined}
                        error={errs(key)}
                      >
                        {it?.effective === undefined ? (
                          <span className="val dim">{unset}</span>
                        ) : (
                          <ModelValue value={it.effective} off={modelOff(it.effective)} />
                        )}
                        <Button
                          size="sm"
                          onClick={() => {
                            if (role === "task") onOpenSubagents?.();
                            else setDialog({ role });
                          }}
                        >
                          {role === "task" ? "设置 › 子代理" : "选择"}
                        </Button>
                      </SettingsRow>
                    );
                  })}
                </SettingsGroup>
              </>
            )}

            {section === "appearance" && (
              <SettingsGroup title="主题">
                <div className="themes" role="radiogroup" aria-label="主题">
                  {THEMES.map(({ value, label, sub, cls }) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={theme === value}
                      className={`tcard${cls !== "" ? ` ${cls}` : ""}${theme === value ? " on" : ""}`}
                      onClick={() => {
                        if (theme === value) return;
                        const ok = onThemeChange(value);
                        setRowErr("theme", ok ? null : "本机存储不可写，主题只在本次运行内生效");
                        showToast(`已保存 主题 = ${label}`);
                      }}
                    >
                      <span className="pv" aria-hidden="true">
                        <i />
                        <i />
                      </span>
                      <span className="tlabel">{label}</span>
                      {sub !== undefined && <small className="tsub">{sub}</small>}
                    </button>
                  ))}
                </div>
                {rowError.theme !== undefined && (
                  <div className="desc err theme-err" role="alert">
                    {rowError.theme}
                  </div>
                )}
              </SettingsGroup>
            )}
          </div>
        </div>
      </div>

      {dialog === "defaultModel" && client !== undefined && (
        <DefaultModelDialog
          models={models}
          current={defaultModelItem?.effective}
          currentEffort={effortItem?.effective}
          onClose={() => {
            setDialog(null);
          }}
          onSave={async (model, effort) => {
            try {
              const next = await client.runtime.setDefaultModel(model, effort);
              setItems(next);
              onConfigSaved?.();
              setRowErr("defaultModel", null);
              setDialog(null);
              showToast(
                `已保存 默认模型与档位 = ${refText(model)}${effort !== null ? `（${effort}）` : ""}`,
              );
              return undefined;
            } catch (e) {
              return errText(e);
            }
          }}
        />
      )}
      {dialog === "reviewer" && client !== undefined && (
        <ReviewerDialog
          client={client}
          models={models}
          providers={reviewerProviders}
          current={reviewerItem?.reviewer?.saved ?? reviewerCfg}
          currentRules={reviewerRulesItem?.reviewerRules?.saved}
          onClose={() => {
            setDialog(null);
          }}
          onSave={async (patch, options) => {
            const err = await save("permission.reviewer", "安全审查", patch, options);
            if (err === undefined) setDialog(null);
            return err;
          }}
        />
      )}
      {dialog === "threshold" && (
        <ThresholdDialog
          current={thresholdItem?.saved ?? ""}
          effective={thresholdItem?.effective}
          pruneLimitCurrent={pruneLimitItem?.saved ?? ""}
          pruneLimitEffective={pruneLimitItem?.effective}
          onClose={() => {
            setDialog(null);
          }}
          onSave={async (threshold, pruneLimit) => {
            const err = await save("compaction.threshold", "压缩阈值", {
              "compaction.threshold": threshold,
              "compaction.pruneLimit": pruneLimit,
            });
            if (err === undefined) setDialog(null);
            return err;
          }}
        />
      )}
      {dialog !== null && typeof dialog === "object" && (
        <RoleDialog
          label={ROLES.find((r) => r.role === dialog.role)?.label ?? dialog.role}
          unset={ROLES.find((r) => r.role === dialog.role)?.unset ?? "跟随当前模型"}
          models={
            dialog.role === "vision" ? models.filter((m) => m.capabilities.imageInput) : models
          }
          current={item(`modelRoles.${dialog.role}`)?.saved}
          onClose={() => {
            setDialog(null);
          }}
          onSave={async (ref) => {
            const key = `modelRoles.${dialog.role}` as const;
            const label = ROLES.find((r) => r.role === dialog.role)?.label ?? dialog.role;
            const err = await save(key, label, { [key]: ref } as SettingsPatch);
            if (err === undefined) setDialog(null);
            return err;
          }}
        />
      )}
    </section>
  );
}

function thresholdText(value: string | undefined, pruneLimit?: string): string {
  if (value === undefined) return "默认";
  const base = value.endsWith("%")
    ? `上下文用到 ${value} 时自动压缩`
    : `上下文达到 ${value} token 时自动压缩`;
  if (pruneLimit === undefined || pruneLimit === "200000") return base;
  return pruneLimit === "0" ? `${base} · 不设修剪上限` : `${base} · 修剪上限 ${pruneLimit}`;
}

/* ---------------- 对话框外框 ---------------- */

function Dialog({
  title,
  width,
  error,
  busy,
  canSave = true,
  extra,
  onClose,
  onSave,
  children,
}: {
  title: string;
  width?: number;
  error: string | null;
  busy: boolean;
  canSave?: boolean;
  /** 左下角的次要按钮（如「恢复默认」） */
  extra?: React.ReactNode;
  onClose: () => void;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <Scrim onClose={onClose}>
      <div
        className="dlg"
        role="dialog"
        aria-label={title}
        style={width !== undefined ? { width } : undefined}
      >
        <div className="dh3">
          <b>{title}</b>
        </div>
        <div className="db">
          {children}
          {error !== null && <div className="errt">{error}</div>}
        </div>
        <div className="df">
          {extra}
          <span className="sp" />
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || !canSave} onClick={onSave}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

/** 对话框保存：onSave 返回错误文案（undefined 成功，由父级关闭对话框） */
function useDialogSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<string | undefined>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void fn()
      .then((err) => {
        if (err !== undefined) setError(err);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, setError, run };
}

function ModelPicker({
  models,
  picked,
  onPick,
  head,
}: {
  models: ModelInfo[];
  picked: string | null;
  onPick: (ref: string | null) => void;
  /** 列表顶部的「跟随」项 */
  head?: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = models.filter(
    (m) =>
      q === "" ||
      refKey(m.ref).toLowerCase().includes(q) ||
      (m.displayName ?? "").toLowerCase().includes(q),
  );
  return (
    <>
      <input
        className="input"
        placeholder="搜索模型"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        aria-label="搜索模型"
      />
      <div className="picklist" role="listbox" aria-label="模型列表">
        {head !== undefined && q === "" && (
          <button
            role="option"
            aria-selected={picked === null}
            className={picked === null ? "on" : undefined}
            onClick={() => {
              onPick(null);
            }}
          >
            <span className="pv">{head}</span>
          </button>
        )}
        {filtered.map((m) => {
          const key = refKey(m.ref);
          const label = m.displayName ?? m.ref.model;
          return (
            <button
              key={key}
              role="option"
              aria-selected={picked === key}
              className={picked === key ? "on" : undefined}
              title={m.ref.model}
              onClick={() => {
                onPick(key);
              }}
            >
              <span className="pv">{label}</span>
              <small>
                {m.displayName !== undefined && m.displayName !== m.ref.model
                  ? `${m.ref.provider} · ${m.ref.model}`
                  : m.ref.provider}
              </small>
            </button>
          );
        })}
        {filtered.length === 0 && <span className="fine pad">无匹配模型</span>}
      </div>
    </>
  );
}

/* ---------------- 默认模型 + 档位（ADR-0034 成对保存） ---------------- */

function DefaultModelDialog({
  models,
  current,
  currentEffort,
  onClose,
  onSave,
}: {
  models: ModelInfo[];
  current: string | undefined;
  currentEffort: string | undefined;
  onClose: () => void;
  onSave: (model: string, effort: ReasoningEffort | null) => Promise<string | undefined>;
}) {
  const [picked, setPicked] = useState<string | null>(
    current !== undefined && models.some((m) => refKey(m.ref) === current) ? current : null,
  );
  const levelsOf = (key: string | null): ReasoningEffort[] => {
    const info = key === null ? undefined : models.find((m) => refKey(m.ref) === key);
    const levels = info?.capabilities.reasoningEffort ?? [];
    return levels.length > 0 ? ["off", ...levels] : [];
  };
  /** 预选：当前默认档位在该模型可用就沿用，否则 off；模型无档位时为 null */
  const preselect = (key: string | null): ReasoningEffort | null => {
    const options = levelsOf(key);
    if (options.length === 0) return null;
    return options.find((x) => x === currentEffort) ?? "off";
  };
  const [effort, setEffort] = useState<ReasoningEffort | null>(() => preselect(picked));
  const { busy, error, run } = useDialogSave();
  const levels = levelsOf(picked);

  return (
    <Dialog
      title="默认模型与档位"
      error={error}
      busy={busy}
      canSave={picked !== null}
      onClose={onClose}
      onSave={() => {
        if (picked !== null) run(() => onSave(picked, effort));
      }}
    >
      <ModelPicker
        models={models}
        picked={picked}
        onPick={(key) => {
          setPicked(key);
          setEffort(preselect(key));
        }}
      />
      <Field
        label="思考档位"
        aside={
          levels.length === 0 ? <small className="desc">所选模型没有可用档位</small> : undefined
        }
      >
        {levels.length > 0 && (
          <div className="effs" role="group" aria-label="思考档位">
            {levels.map((lv) => (
              <button
                key={lv}
                className={effort === lv ? "on" : undefined}
                onClick={() => {
                  setEffort(lv);
                }}
              >
                {lv}
              </button>
            ))}
          </div>
        )}
      </Field>
    </Dialog>
  );
}

/* ---------------- 压缩阈值 ---------------- */

function parsePruneLimitInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/u.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

function ThresholdDialog({
  current,
  effective,
  pruneLimitCurrent = "",
  pruneLimitEffective,
  onClose,
  onSave,
}: {
  current: string;
  effective: string | undefined;
  pruneLimitCurrent?: string;
  pruneLimitEffective?: string | undefined;
  onClose: () => void;
  onSave: (threshold: string | null, pruneLimit: number | null) => Promise<string | undefined>;
}) {
  const [value, setValue] = useState(current);
  const [pruneLimit, setPruneLimit] = useState(pruneLimitCurrent);
  const { busy, error, run } = useDialogSave();
  const submit = (nextThreshold: string | null, nextPruneLimit: number | null) => {
    run(() => onSave(nextThreshold, nextPruneLimit));
  };
  const submitCurrent = () => {
    submit(value.trim() === "" ? null : value.trim(), parsePruneLimitInput(pruneLimit));
  };
  return (
    <Dialog
      title="压缩阈值"
      width={440}
      error={error}
      busy={busy}
      extra={
        <Button
          variant="ghost"
          disabled={busy || (current === "" && pruneLimitCurrent === "")}
          onClick={() => {
            submit(null, null);
          }}
        >
          恢复默认
        </Button>
      }
      onClose={onClose}
      onSave={submitCurrent}
    >
      <Field label="摘要阈值" htmlFor="th-val">
        <input
          id="th-val"
          className="input lg mono"
          value={value}
          placeholder={effective ?? "85% 或 120000"}
          autoFocus
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCurrent();
          }}
        />
      </Field>
      <Field label="修剪上限" htmlFor="th-prune">
        <input
          id="th-prune"
          className="input lg mono"
          value={pruneLimit}
          placeholder={pruneLimitEffective ?? "200000"}
          onChange={(e) => {
            setPruneLimit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCurrent();
          }}
        />
      </Field>
    </Dialog>
  );
}

/* ---------------- 模型角色 ---------------- */

function RoleDialog({
  label,
  unset,
  models,
  current,
  onClose,
  onSave,
}: {
  label: string;
  unset: string;
  models: ModelInfo[];
  current: string | undefined;
  onClose: () => void;
  onSave: (ref: string | null) => Promise<string | undefined>;
}) {
  const [picked, setPicked] = useState<string | null>(current ?? null);
  const { busy, error, run } = useDialogSave();
  return (
    <Dialog
      title={label}
      error={error}
      busy={busy}
      onClose={onClose}
      onSave={() => {
        run(() => onSave(picked));
      }}
    >
      <ModelPicker models={models} picked={picked} onPick={setPicked} head={unset} />
    </Dialog>
  );
}

/* ---------------- 安全审查 ---------------- */

const JEV_ENDPOINTS: { v: JevEndpoint; label: string }[] = [
  { v: "opencode-zen", label: "opencode-zen" },
  { v: "typesafe", label: "typesafe" },
  { v: "custom", label: "自定义地址" },
];

const RULES_LIMIT = 1000;

function ReviewerDialog({
  client,
  models,
  providers,
  current,
  currentRules,
  onClose,
  onSave,
}: {
  client: RpcClient;
  models: ModelInfo[];
  providers: string[];
  current: SecurityReviewerConfig | undefined;
  /** settings.json 里已保存的追加规则 */
  currentRules: ReviewerRules | undefined;
  onClose: () => void;
  onSave: (
    patch: SettingsPatch,
    options: { reviewerKey: string } | undefined,
  ) => Promise<string | undefined>;
}) {
  const [backend, setBackend] = useState<"off" | "model" | "jev">(current?.backend ?? "off");
  const [modelRef, setModelRef] = useState<string | null>(
    current?.backend === "model" ? refKey(current.model) : null,
  );
  const jev = current?.backend === "jev" ? current : undefined;
  const [endpoint, setEndpoint] = useState<JevEndpoint>(jev?.endpoint ?? "opencode-zen");
  const [baseURL, setBaseURL] = useState(jev?.baseURL ?? "");
  const [jevModel, setJevModel] = useState(jev?.model ?? "");
  const [credKind, setCredKind] = useState<"provider" | "env" | "stored">(() => {
    if (jev === undefined) return providers.length > 0 ? "provider" : "stored";
    if ("provider" in jev.credential) return "provider";
    if ("env" in jev.credential) return "env";
    return "stored";
  });
  const [credProvider, setCredProvider] = useState(
    jev !== undefined && "provider" in jev.credential
      ? jev.credential.provider
      : (providers[0] ?? ""),
  );
  const [credEnv, setCredEnv] = useState(
    jev !== undefined && "env" in jev.credential ? jev.credential.env : "",
  );
  /** 凭据库里的审查器密钥：只经 reviewerKey 提交，保存后清空，界面不留存 */
  const [reviewerKey, setReviewerKey] = useState("");
  const [minConfidence, setMinConfidence] = useState(
    jev?.minConfidence !== undefined ? String(jev.minConfidence) : "",
  );
  /** 首次启用 Jev 的数据外发说明（与 TUI 同一偏好 jevDisclosureAccepted） */
  const [disclosure, setDisclosure] = useState<"unknown" | "needed" | "shown" | "accepted">(
    "unknown",
  );
  const [rulesAsk, setRulesAsk] = useState(currentRules?.ask ?? "");
  const [rulesAllow, setRulesAllow] = useState(currentRules?.allow ?? "");
  const { busy, error, setError, run } = useDialogSave();

  useEffect(() => {
    let cancelled = false;
    client.runtime
      .getPreference("jevDisclosureAccepted")
      .then((v) => {
        if (!cancelled) setDisclosure(v === "yes" ? "accepted" : "needed");
      })
      .catch(() => {
        if (!cancelled) setDisclosure("needed");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // 切到 Jev 或换接入点时，模型为空就带出 Core 的默认模型
  const jevModelRef = useRef(jevModel);
  jevModelRef.current = jevModel;
  useEffect(() => {
    if (backend !== "jev" || (endpoint === "custom" && baseURL.trim() === "")) return;
    let cancelled = false;
    client.runtime
      .defaultReviewer(endpoint, endpoint === "custom" ? baseURL.trim() : undefined)
      .then((d: JevReviewerConfig) => {
        if (!cancelled && jevModelRef.current === "") setJevModel(d.model);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, backend, endpoint, baseURL]);

  /** 两段追加规则随审查器配置一起保存；全空表示清除 */
  const rulesPatch = (): SettingsPatch => {
    const ask = rulesAsk.trim();
    const allow = rulesAllow.trim();
    return {
      "permission.reviewerRules":
        ask === "" && allow === ""
          ? null
          : { ...(ask !== "" ? { ask } : {}), ...(allow !== "" ? { allow } : {}) },
    };
  };

  const build = ():
    { patch: SettingsPatch; options: { reviewerKey: string } | undefined } | string => {
    const built = buildReviewer();
    if (typeof built === "string") return built;
    return { patch: { ...built.patch, ...rulesPatch() }, options: built.options };
  };

  const buildReviewer = ():
    { patch: SettingsPatch; options: { reviewerKey: string } | undefined } | string => {
    if (backend === "off")
      return { patch: { "permission.reviewer": { backend: "off" } }, options: undefined };
    if (backend === "model") {
      const info = models.find((m) => refKey(m.ref) === modelRef);
      if (info === undefined) return "选择一个模型";
      return {
        patch: { "permission.reviewer": { backend: "model", model: info.ref } },
        options: undefined,
      };
    }
    if (endpoint === "custom" && baseURL.trim() === "") return "自定义地址必填";
    if (jevModel.trim() === "") return "模型必填";
    const confidence = minConfidence.trim() === "" ? undefined : Number(minConfidence);
    if (confidence !== undefined && !(confidence >= 0 && confidence <= 1))
      return "置信度阈值应在 0–1 之间";
    let credential: JevReviewerConfig["credential"];
    if (credKind === "provider") {
      if (credProvider === "") return "选择沿用哪个服务商的凭据";
      credential = { provider: credProvider };
    } else if (credKind === "env") {
      if (credEnv.trim() === "") return "填写环境变量名";
      credential = { env: credEnv.trim() };
    } else {
      credential = { stored: true };
    }
    const cfg: JevReviewerConfig = {
      backend: "jev",
      endpoint,
      ...(endpoint === "custom" ? { baseURL: baseURL.trim() } : {}),
      model: jevModel.trim(),
      credential,
      ...(confidence !== undefined ? { minConfidence: confidence } : {}),
    };
    const key = reviewerKey.trim();
    return {
      patch: { "permission.reviewer": cfg },
      options: credKind === "stored" && key !== "" ? { reviewerKey: key } : undefined,
    };
  };

  const submit = () => {
    const built = build();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    if (backend === "jev" && disclosure !== "accepted" && disclosure !== "shown") {
      setDisclosure("shown");
      return;
    }
    const accepting = backend === "jev" && disclosure === "shown";
    run(async () => {
      const err = await onSave(built.patch, built.options);
      if (err === undefined) {
        setReviewerKey("");
        if (accepting)
          await client.runtime.setPreference("jevDisclosureAccepted", "yes").catch(() => undefined);
      }
      return err;
    });
  };

  const seg = <V extends string>(
    label: string,
    value: V,
    options: readonly (readonly [V, string])[],
    onPick: (v: V) => void,
  ) => (
    <SegmentedControl
      aria-label={label}
      value={value}
      options={options.map(([v, text]) => ({ value: v, label: text }))}
      onChange={onPick}
    />
  );

  return (
    <Dialog
      title="安全审查"
      width={600}
      error={error}
      busy={busy}
      onClose={onClose}
      onSave={submit}
    >
      {disclosure === "shown" ? (
        <div className="pbanner">
          首次启用 Jev
          <span>
            将把待确认操作的类别、目标或命令、工作目录、全部用户消息（约 8000 字内）、项目说明前
            2000 字和 git remote 地址发送给 {endpoint === "custom" ? baseURL.trim() : endpoint}
            ，可能包含任务代码或命令文本。点「保存」表示同意。
          </span>
        </div>
      ) : (
        <>
          <Field label="审查器">
            {seg(
              "审查器",
              backend,
              [
                ["off", "关闭"],
                ["jev", "Jev"],
                ["model", "小模型"],
              ] as const,
              (v) => {
                setBackend(v);
                setError(null);
              },
            )}
          </Field>
          {backend === "model" && (
            <ModelPicker models={models} picked={modelRef} onPick={setModelRef} />
          )}
          {backend === "jev" && (
            <>
              <Field label="接入点">
                {seg(
                  "接入点",
                  endpoint,
                  JEV_ENDPOINTS.map((e) => [e.v, e.label] as const),
                  setEndpoint,
                )}
              </Field>
              {endpoint === "custom" && (
                <Field label="地址" htmlFor="rv-url">
                  <input
                    id="rv-url"
                    className="input lg mono"
                    spellCheck={false}
                    value={baseURL}
                    placeholder="https://"
                    onChange={(e) => {
                      setBaseURL(e.target.value);
                    }}
                  />
                </Field>
              )}
              <Field label="模型" htmlFor="rv-model">
                <input
                  id="rv-model"
                  className="input lg mono"
                  spellCheck={false}
                  value={jevModel}
                  onChange={(e) => {
                    setJevModel(e.target.value);
                  }}
                />
              </Field>
              <Field label="凭据">
                {seg(
                  "凭据",
                  credKind,
                  [
                    ...(providers.length > 0 ? [["provider", "沿用服务商"] as const] : []),
                    ["env", "环境变量"] as const,
                    ["stored", "单独密钥"] as const,
                  ],
                  setCredKind,
                )}
                {credKind === "provider" && (
                  <Dropdown
                    label="沿用的服务商"
                    appearance="lg"
                    value={credProvider}
                    options={providers.map((p) => ({ value: p, label: p }))}
                    onChange={setCredProvider}
                  />
                )}
                {credKind === "env" && (
                  <input
                    className="input lg mono"
                    spellCheck={false}
                    value={credEnv}
                    aria-label="环境变量名"
                    placeholder="环境变量名"
                    onChange={(e) => {
                      setCredEnv(e.target.value);
                    }}
                  />
                )}
                {credKind === "stored" && (
                  <input
                    className="input lg"
                    type="password"
                    autoComplete="off"
                    value={reviewerKey}
                    aria-label="审查器密钥"
                    placeholder="留空则沿用已保存的密钥"
                    onChange={(e) => {
                      setReviewerKey(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="置信度阈值" htmlFor="rv-conf">
                <input
                  id="rv-conf"
                  className="input mono sm-w"
                  value={minConfidence}
                  placeholder="0.7"
                  onChange={(e) => {
                    setMinConfidence(e.target.value);
                  }}
                />
              </Field>
            </>
          )}
          <Field label="额外交人" htmlFor="rv-rules-ask">
            <textarea
              id="rv-rules-ask"
              className="textarea"
              rows={3}
              maxLength={RULES_LIMIT}
              spellCheck={false}
              value={rulesAsk}
              onChange={(e) => {
                setRulesAsk(e.target.value);
              }}
            />
          </Field>
          <Field label="额外放行" htmlFor="rv-rules-allow">
            <textarea
              id="rv-rules-allow"
              className="textarea"
              rows={3}
              maxLength={RULES_LIMIT}
              spellCheck={false}
              value={rulesAllow}
              onChange={(e) => {
                setRulesAllow(e.target.value);
              }}
            />
          </Field>
          <ReviewerSampleCheck
            client={client}
            enabled={current !== undefined && current.backend !== "off"}
          />
        </>
      )}
    </Dialog>
  );
}

const EXPECT_TEXT = { allow: "放行", ask: "交人" } as const;

type SampleRun =
  | { state: "idle" }
  | { state: "running"; total: number | undefined }
  | { state: "done" | "cancelled"; total: number }
  | { state: "error"; message: string };

/**
 * 审查器样例检查（ADR-0057 §8）：用当前**已保存**的审查器配置逐条跑内置样例，
 * 逐行显示说明、期望、实际与用时，不一致的行标红，最后给出命中率。
 * 一条一次 RPC，取消即停止后续条目并丢弃在途结果。
 */
function ReviewerSampleCheck({ client, enabled }: { client: RpcClient; enabled: boolean }) {
  const [run, setRun] = useState<SampleRun>({ state: "idle" });
  const [rows, setRows] = useState<ReviewerSampleResult[]>([]);
  const token = useRef<{ cancelled: boolean } | null>(null);

  useEffect(
    () => () => {
      if (token.current !== null) token.current.cancelled = true;
    },
    [],
  );

  const start = () => {
    const mine = { cancelled: false };
    // 取消发生在 await 之间：经函数读取，避免属性收窄把检查误判为恒假
    const isCancelled = () => mine.cancelled;
    token.current = mine;
    setRows([]);
    setRun({ state: "running", total: undefined });
    void (async () => {
      try {
        const list = await client.runtime.listReviewerSamples();
        if (isCancelled()) return;
        setRun({ state: "running", total: list.length });
        for (const sample of list) {
          const result = await client.runtime.testReviewerSample(sample.id);
          if (isCancelled()) return;
          setRows((prev) => [...prev, result]);
        }
        setRun({ state: "done", total: list.length });
      } catch (e) {
        if (!isCancelled()) setRun({ state: "error", message: errText(e) });
      }
    })();
  };
  const cancel = () => {
    if (token.current !== null) token.current.cancelled = true;
    setRun((prev) =>
      prev.state === "running" ? { state: "cancelled", total: prev.total ?? rows.length } : prev,
    );
  };

  const matched = rows.filter((row) => row.match).length;
  const rate = rows.length === 0 ? 0 : Math.round((matched / rows.length) * 100);
  const running = run.state === "running";
  return (
    <Field
      label="样例检查"
      className="samples"
      error={run.state === "error" ? `测试失败：${run.message}` : undefined}
    >
      <div className="srun">
        {running ? (
          <Button onClick={cancel}>取消测试</Button>
        ) : (
          <Button
            disabled={!enabled}
            title={enabled ? undefined : "审查器为关闭时不可用"}
            onClick={start}
          >
            测试
          </Button>
        )}
        {!enabled && <span className="desc">审查器已关闭：先选择后端并保存</span>}
        {running && (
          <span className="desc">
            已跑 {rows.length}/{run.total ?? "?"} 条
          </span>
        )}
      </div>
      {rows.length > 0 && (
        <DataTable
          aria-label="样例检查结果"
          rows={rows}
          rowKey={(row) => row.id}
          rowClassName={(row) => (row.match ? undefined : "bad")}
          rowTitle={(row) => row.reason}
          columns={[
            { key: "title", header: "样例", render: (row) => row.title },
            { key: "expected", header: "期望", render: (row) => EXPECT_TEXT[row.expected] },
            {
              key: "actual",
              header: "实际",
              render: (row) => `${EXPECT_TEXT[row.actual]}${row.match ? "" : " ✗"}`,
            },
            {
              key: "time",
              header: "用时",
              numeric: true,
              render: (row) => `${(row.durationMs / 1000).toFixed(1)}s`,
            },
          ]}
        />
      )}
      {(run.state === "done" || run.state === "cancelled") && (
        <div className="desc" role="status">
          {run.state === "cancelled" ? `已取消，已跑 ${rows.length}/${run.total} 条，` : ""}
          命中率 {matched}/{rows.length}（{rate}%）
        </div>
      )}
    </Field>
  );
}

function AgentBrowserRows({
  host,
  prefs,
  onToast,
}: {
  host: AgentBrowserHost;
  prefs: PrefsStore;
  onToast: (text: string) => void;
}) {
  const [enabled, setEnabled] = useState(() => prefs.get().agentBrowserEnabled === true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await host.setEnabled(next);
      prefs.update({ agentBrowserEnabled: result.enabled });
      setEnabled(result.enabled);
      onToast(result.enabled ? "已开启" : "已关闭；已有绑定和标签已撤销");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const onToggle = (next: boolean) => {
    if (next && prefs.get().agentBrowserRiskAccepted !== true) {
      setConfirming(true);
      return;
    }
    void apply(next);
  };
  return (
    <>
      <SettingsRow label="面板浏览器" error={error ?? undefined}>
        <Switch aria-label="面板浏览器" checked={enabled} disabled={busy} onChange={onToggle} />
      </SettingsRow>
      {confirming && (
        <div className="agent-browser-risk" role="alertdialog" aria-label="启用面板浏览器">
          <p>网页内容不可信，可能诱导它操作其他页面。</p>
          <div className="agent-browser-risk-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                prefs.update({ agentBrowserRiskAccepted: true });
                setConfirming(false);
                void apply(true);
              }}
            >
              仍然启用
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
