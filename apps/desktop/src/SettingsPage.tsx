/**
 * 设置区的常规 / 模型 / 外观三页（desktop-v4.html A、B、E 屏；服务商页在
 * ProvidersPage.tsx）：逐项保存（ADR-0045 第 7 节）。单值项改完立即写
 * settings.json；复合项开对话框，对话框里「保存」才落盘；失败时值回到原样，
 * 这一行下面写红字。主题与普通对话工作区只写本机 prefs，不进 Core。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionPresetName, ReasoningEffort } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { presetOptions } from "./choice-info";
import { Dropdown } from "./Dropdown";
import { Scrim } from "./ProvidersPage";
import { refKey } from "./session-controls";
import type {
  JevEndpoint,
  JevReviewerConfig,
  ModelInfo,
  SecurityReviewerConfig,
  SettingItem,
  SettingsPatch,
} from "./rpc-types";
import { describeUpdateError, type CheckResult } from "./updater";

export type ThemePref = "system" | "light" | "dark";

/** 设置区里由本组件渲染的导航项（服务商页另见 ProvidersPage） */
export type SettingsPageSection = "general" | "models" | "appearance";

const SECTION_HEAD: Record<SettingsPageSection, { title: string; sub: string }> = {
  general: {
    title: "常规",
    sub: "默认值对新会话生效；当前会话在状态栏切换模型、思考档位和权限",
  },
  models: { title: "模型", sub: "新会话默认用哪个模型，以及子任务用哪些模型" },
  appearance: { title: "外观", sub: "只影响这台电脑上的桌面端" },
};

const THEMES: { value: ThemePref; label: string; cls: string }[] = [
  { value: "system", label: "跟随系统", cls: "sys" },
  { value: "light", label: "浅色", cls: "" },
  { value: "dark", label: "深色", cls: "dk" },
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const LAYER_TEXT: Record<SettingItem["source"], string> = {
  default: "默认",
  setup: "providers.json",
  settings: "settings.json",
  user: "config.json",
  project: "项目配置",
  env: "环境变量",
  cli: "命令行参数",
};

type RoleKey = "task" | "vision" | "smol";
const ROLES: { role: RoleKey; label: string; hint?: string; unset: string }[] = [
  { role: "task", label: "子代理模型", unset: "跟随当前模型" },
  { role: "vision", label: "看图模型", hint: "当前模型不支持图片时使用", unset: "未设置" },
  { role: "smol", label: "轻量模型", hint: "生成标题等小任务", unset: "跟随当前模型" },
];

/** "provider/model" → "provider · model" */
function refText(ref: string): string {
  const at = ref.indexOf("/");
  return at < 0 ? ref : `${ref.slice(0, at)} · ${ref.slice(at + 1)}`;
}

/** 模型名与档位优先展示，服务商单独一行允许省略。 */
function ModelValue({ value, effort }: { value: string; effort?: string | undefined }) {
  const at = value.indexOf("/");
  const provider = at < 0 ? "" : value.slice(0, at);
  const model = at < 0 ? value : value.slice(at + 1);
  return (
    <span className="model-value" title={refText(value)}>
      <span className="model-primary">
        {model}
        {effort !== undefined ? ` · ${effort}` : ""}
      </span>
      {provider !== "" && <span className="model-provider">{provider}</span>}
    </span>
  );
}

function reviewerText(cfg: SecurityReviewerConfig | undefined): string {
  if (cfg === undefined || cfg.backend === "off") return "关闭";
  if (cfg.backend === "model") return `模型 · ${refText(refKey(cfg.model))}`;
  return `Jev · ${cfg.endpoint === "custom" ? (cfg.baseURL ?? "自定义地址") : cfg.endpoint} · ${cfg.model}`;
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
  onConfigSaved,
  onOpenProviders,
}: {
  section: SettingsPageSection;
  client: RpcClient | undefined;
  theme: ThemePref;
  /** 回答内文件引用"打开文件用"（本机 prefs，不进 Core） */
  fileOpener: "system" | "vscode" | "cursor";
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
  onFileOpenerChange: (opener: "system" | "vscode" | "cursor") => boolean;
  /** 切换普通对话工作区（null = 恢复默认）；返回错误文案或 undefined（成功） */
  onWorkspaceChange: (dir: string | null) => Promise<string | undefined>;
  pickFolder: () => Promise<string | null>;
  providersVersion: number;
  /** 写设置成功后调用：桌面端据此让其他后台 reloadConfig */
  onConfigSaved?: () => void;
  /** 「模型」页尾的链接：进入设置 › 服务商 */
  onOpenProviders?: () => void;
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
  const defaultModelItem = item("defaultModel");
  const effortItem = item("reasoningEffort");
  const presetItem = item("permissions.preset");
  const reviewerItem = item("permission.reviewer");
  const thresholdItem = item("compaction.threshold");
  const shellItem = item("shell");
  const reviewerCfg = reviewerItem?.reviewer?.effective;

  const src = (it: SettingItem | undefined) => {
    if (it === undefined) return <span className="src" />;
    return (
      <span
        className={`src${it.overridden ? " ov" : ""}`}
        title={it.overridden ? "保存的值被更高层覆盖，改了也不生效" : undefined}
      >
        {it.overridden ? `已被覆盖 · ${LAYER_TEXT[it.source]}` : LAYER_TEXT[it.source]}
      </span>
    );
  };
  const errLine = (key: string) =>
    rowError[key] !== undefined ? <span className="errl">{rowError[key]}</span> : null;
  const rowClass = (key: string) => `s3${rowError[key] !== undefined ? " bad" : ""}`;

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
  return (
    <section className="page3" data-testid="settings-page" aria-label={head.title}>
      <div className="ph3">
        <div className="grow">
          <h3>{head.title}</h3>
          <span className="sub">{head.sub}</span>
        </div>
      </div>
      {toast !== null && (
        <div className="toast3" role="status">
          <b>✓</b>
          {toast}
        </div>
      )}
      <div className="sets3">
        {needsCore && client === undefined && (
          <span className="fine">后台尚未就绪，稍后自动刷新。</span>
        )}
        {needsCore && loadError !== null && <div className="errt">{loadError}</div>}
        {needsCore && client !== undefined && items === null && loadError === null && (
          <span className="fine">加载中…</span>
        )}
        {section === "general" && items !== null && (
          <>
            <h5>权限</h5>
            <div className={rowClass("permissions.preset")}>
              <span className="n">默认权限预设</span>
              <span className="v sans">
                <Dropdown
                  label="默认权限预设"
                  value={pendingPreset ?? presetItem?.saved ?? ""}
                  options={[
                    {
                      value: "",
                      label: "跟随默认",
                      tag: presetItem?.effective ?? "—",
                      description: "不单独保存，使用更低层或内置的默认预设",
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
              </span>
              {src(presetItem)}
              {errLine("permissions.preset")}
            </div>
            <div className={rowClass("permission.reviewer")}>
              <span className="n">
                安全审查<small>规则拦下的操作先交给它判断</small>
              </span>
              <span className="v">
                <span className="t">{reviewerText(reviewerCfg)}</span>
                <button
                  className="btn"
                  onClick={() => {
                    setDialog("reviewer");
                  }}
                >
                  编辑
                </button>
              </span>
              {src(reviewerItem)}
              {errLine("permission.reviewer")}
            </div>

            <h5>执行</h5>
            {shellItem !== undefined && (
              <div className="s3">
                <span className="n">
                  Shell<small>会话内在状态栏切换</small>
                </span>
                <span className="v">
                  <span className="t">{shellItem.effective ?? "自动"}</span>
                  {(shellItem.source === "env" ||
                    shellItem.source === "user" ||
                    shellItem.source === "project") && (
                    <span className="ro">
                      {shellItem.source === "env"
                        ? "由环境变量 NOCTURNE_SHELL 指定"
                        : `由${LAYER_TEXT[shellItem.source]}指定`}
                    </span>
                  )}
                </span>
                {src(shellItem)}
              </div>
            )}
            <div className={rowClass("compaction.threshold")}>
              <span className="n">压缩阈值</span>
              <span className="v sans">
                <span className="t">{thresholdText(thresholdItem?.effective)}</span>
                <button
                  className="btn"
                  onClick={() => {
                    setDialog("threshold");
                  }}
                >
                  编辑
                </button>
              </span>
              {src(thresholdItem)}
              {errLine("compaction.threshold")}
            </div>
          </>
        )}
        {section === "general" && (
          <>
            <h5>普通对话</h5>
            <div className={rowClass("workspace")}>
              <span className="n">
                工作区<small>换位置后，旧位置的对话仍显示在「对话」</small>
              </span>
              <span className="v">
                <span className="t" title={workspace ?? ""}>
                  {workspace ?? "未就绪"}
                </span>
                <button
                  className="btn"
                  disabled={wsBusy || workspace === null}
                  onClick={() => {
                    void pickFolder().then((dir) => {
                      if (dir !== null) void changeWorkspace(dir);
                    });
                  }}
                >
                  {wsBusy ? "切换中…" : "更改…"}
                </button>
                {workspaceOverridden && (
                  <button
                    className="btn ghost"
                    disabled={wsBusy}
                    title={defaultWorkspace ?? undefined}
                    onClick={() => void changeWorkspace(null)}
                  >
                    恢复默认
                  </button>
                )}
              </span>
              <span className="src">本机</span>
              {errLine("workspace")}
            </div>
            <h5>文件</h5>
            <div className={rowClass("fileOpener")}>
              <span className="n">
                打开文件用<small>回答里的文件引用点开时用哪个程序</small>
              </span>
              <span className="v">
                <Dropdown
                  label="打开文件用"
                  value={fileOpener}
                  options={[
                    { value: "system", label: "系统默认程序", description: "不带行号" },
                    ...(editors.vscode
                      ? [{ value: "vscode", label: "VS Code", description: "带行号跳转" }]
                      : []),
                    ...(editors.cursor
                      ? [{ value: "cursor", label: "Cursor", description: "带行号跳转" }]
                      : []),
                  ]}
                  onChange={(value) => {
                    if (value !== "system" && value !== "vscode" && value !== "cursor") return;
                    const ok = onFileOpenerChange(value);
                    setRowErr("fileOpener", ok ? null : "本机存储不可写，设置只在本次运行内生效");
                    showToast(`已保存 打开文件用 = ${value}`);
                  }}
                />
              </span>
              <span className="src">本机</span>
              {errLine("fileOpener")}
            </div>
          </>
        )}
        {section === "general" && update !== undefined && (
          <>
            <h5>更新</h5>
            <div className={rowClass("autoUpdate")}>
              <span className="n">
                自动检查更新<small>每 24 小时最多一次，失败不会打扰使用</small>
              </span>
              <span className="v">
                <button
                  role="switch"
                  aria-checked={update.autoUpdate}
                  aria-label="自动检查更新"
                  className={`mcp-switch ${update.autoUpdate ? "on" : ""}`}
                  onClick={() => {
                    const ok = update.onAutoUpdateChange(!update.autoUpdate);
                    setRowErr("autoUpdate", ok ? null : "本机存储不可写，开关只在本次运行内生效");
                  }}
                />
              </span>
              <span className="src">本机</span>
              {errLine("autoUpdate")}
            </div>
            <div className={rowClass("updateCheck")}>
              <span className="n">
                检查更新<small>发现新版本时会在窗口底部提示</small>
              </span>
              <span className="v">
                <button className="btn" disabled={updBusy} onClick={() => void runUpdateCheck()}>
                  {updBusy ? "检查中…" : "检查更新"}
                </button>
              </span>
              <span className="src" />
              {errLine("updateCheck")}
            </div>
          </>
        )}

        {section === "models" && items !== null && (
          <>
            <h5>默认</h5>
            <div className={`${rowClass("defaultModel")} model-setting`}>
              <span className="n">默认模型与档位</span>
              <span className="v">
                {defaultModelItem?.effective === undefined ? (
                  <span className="ro">未设置</span>
                ) : (
                  <ModelValue value={defaultModelItem.effective} effort={effortItem?.effective} />
                )}
                <button
                  className="btn"
                  onClick={() => {
                    setDialog("defaultModel");
                  }}
                >
                  选择
                </button>
              </span>
              {src(defaultModelItem)}
              {errLine("defaultModel")}
            </div>

            <h5>模型角色</h5>
            {ROLES.map(({ role, label, hint, unset }) => {
              const key = `modelRoles.${role}` as const;
              const it = item(key);
              return (
                <div key={role} className={`${rowClass(key)} model-setting`}>
                  <span className="n">
                    {label}
                    {hint !== undefined && <small>{hint}</small>}
                  </span>
                  <span className="v">
                    {it?.effective === undefined ? (
                      <span className="ro">{unset}</span>
                    ) : (
                      <ModelValue value={it.effective} />
                    )}
                    <button
                      className="btn"
                      onClick={() => {
                        setDialog({ role });
                      }}
                    >
                      选择
                    </button>
                  </span>
                  {src(it)}
                  {errLine(key)}
                </div>
              );
            })}
            <div className="fine sets-foot">
              要改某个模型的上下文、最大输出、思考档位，到{" "}
              <button type="button" className="lk" onClick={onOpenProviders}>
                服务商 › 模型表
              </button>{" "}
              里点「设置」。
            </div>
          </>
        )}

        {section === "appearance" && (
          <>
            <h5>主题</h5>
            <div className={`${rowClass("theme")} s3-themes`}>
              <div className="themes" role="radiogroup" aria-label="主题">
                {THEMES.map(({ value, label, cls }) => (
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
                    {label}
                  </button>
                ))}
              </div>
              <span className="src">本机</span>
              {errLine("theme")}
            </div>
          </>
        )}
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
                `已保存 默认模型与档位 = ${refText(model)}${effort !== null ? ` · ${effort}` : ""}`,
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
          onClose={() => {
            setDialog(null);
          }}
          onSave={async (v) => {
            const err = await save("compaction.threshold", "压缩阈值", {
              "compaction.threshold": v,
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
            const err = await save(key, label, { [key]: ref });
            if (err === undefined) setDialog(null);
            return err;
          }}
        />
      )}
    </section>
  );
}

function thresholdText(value: string | undefined): string {
  if (value === undefined) return "默认";
  return value.endsWith("%")
    ? `上下文用到 ${value} 时自动压缩`
    : `上下文达到 ${value} token 时自动压缩`;
}

/* ---------------- 对话框外框 ---------------- */

function Dialog({
  title,
  sub,
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
  sub: string;
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
          <span>{sub}</span>
        </div>
        <div className="db">
          {children}
          {error !== null && <div className="errt">{error}</div>}
        </div>
        <div className="df">
          {extra}
          <span className="sp" />
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !canSave} onClick={onSave}>
            {busy ? "保存中…" : "保存"}
          </button>
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
          return (
            <button
              key={key}
              role="option"
              aria-selected={picked === key}
              className={picked === key ? "on" : undefined}
              onClick={() => {
                onPick(key);
              }}
            >
              <span className="pv">{refText(key)}</span>
              {m.displayName !== undefined && m.displayName !== m.ref.model && (
                <small>{m.displayName}</small>
              )}
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
      sub="成对保存到 settings.json，对之后新建的会话生效"
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
      <div className="field">
        <div className="lab">
          <label>思考档位</label>
          <small>{levels.length === 0 ? "所选模型没有可用档位" : "可选值随所选模型变化"}</small>
        </div>
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
      </div>
    </Dialog>
  );
}

/* ---------------- 压缩阈值 ---------------- */

function ThresholdDialog({
  current,
  effective,
  onClose,
  onSave,
}: {
  current: string;
  effective: string | undefined;
  onClose: () => void;
  onSave: (value: string | null) => Promise<string | undefined>;
}) {
  const [value, setValue] = useState(current);
  const { busy, error, run } = useDialogSave();
  const submit = (v: string | null) => {
    run(() => onSave(v));
  };
  return (
    <Dialog
      title="压缩阈值"
      sub="上下文用到这个比例或 token 数时自动压缩"
      width={440}
      error={error}
      busy={busy}
      extra={
        <button
          className="btn ghost"
          disabled={busy || current === ""}
          onClick={() => {
            submit(null);
          }}
        >
          恢复默认
        </button>
      }
      onClose={onClose}
      onSave={() => {
        submit(value.trim() === "" ? null : value.trim());
      }}
    >
      <input
        className="input mono"
        value={value}
        placeholder={effective ?? "如 85% 或 120000"}
        aria-label="压缩阈值"
        autoFocus
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(value.trim() === "" ? null : value.trim());
        }}
      />
      <div className="hint">填百分比（如 85%）或 token 数（如 120000）；留空保存即恢复默认</div>
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
      sub="保存到 settings.json；选第一项清除设置"
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

function ReviewerDialog({
  client,
  models,
  providers,
  current,
  onClose,
  onSave,
}: {
  client: RpcClient;
  models: ModelInfo[];
  providers: string[];
  current: SecurityReviewerConfig | undefined;
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

  const build = ():
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
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          className={value === v ? "on" : undefined}
          onClick={() => {
            onPick(v);
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );

  return (
    <Dialog
      title="安全审查"
      sub="规则拦下的操作先交给审查器判断；保存到 settings.json"
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
            将把待确认操作的类别、目标或命令、工作目录和最近三条用户消息发送给{" "}
            {endpoint === "custom" ? baseURL.trim() : endpoint}
            ，可能包含任务代码或命令文本。点「保存」表示同意。
          </span>
        </div>
      ) : (
        <>
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
          {backend === "model" && (
            <ModelPicker models={models} picked={modelRef} onPick={setModelRef} />
          )}
          {backend === "jev" && (
            <>
              <div className="field">
                <div className="lab">
                  <label>接入点</label>
                </div>
                {seg(
                  "接入点",
                  endpoint,
                  JEV_ENDPOINTS.map((e) => [e.v, e.label] as const),
                  setEndpoint,
                )}
              </div>
              {endpoint === "custom" && (
                <div className="field">
                  <div className="lab">
                    <label htmlFor="rv-url">地址</label>
                  </div>
                  <input
                    id="rv-url"
                    className="input mono"
                    spellCheck={false}
                    value={baseURL}
                    placeholder="https://"
                    onChange={(e) => {
                      setBaseURL(e.target.value);
                    }}
                  />
                </div>
              )}
              <div className="field">
                <div className="lab">
                  <label htmlFor="rv-model">模型</label>
                </div>
                <input
                  id="rv-model"
                  className="input mono"
                  spellCheck={false}
                  value={jevModel}
                  onChange={(e) => {
                    setJevModel(e.target.value);
                  }}
                />
              </div>
              <div className="field">
                <div className="lab">
                  <label>凭据</label>
                </div>
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
                    value={credProvider}
                    options={providers.map((p) => ({ value: p, label: p }))}
                    onChange={setCredProvider}
                  />
                )}
                {credKind === "env" && (
                  <input
                    className="input mono"
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
                  <>
                    <input
                      className="input"
                      type="password"
                      autoComplete="off"
                      value={reviewerKey}
                      aria-label="审查器密钥"
                      placeholder="留空则沿用已保存的密钥"
                      onChange={(e) => {
                        setReviewerKey(e.target.value);
                      }}
                    />
                    <div className="hint">密钥交给系统凭据存储，界面不留存</div>
                  </>
                )}
              </div>
              <div className="field">
                <div className="lab">
                  <label htmlFor="rv-conf">置信度阈值</label>
                  <small>可选，0–1</small>
                </div>
                <input
                  id="rv-conf"
                  className="input mono narrow"
                  value={minConfidence}
                  placeholder="0.7"
                  onChange={(e) => {
                    setMinConfidence(e.target.value);
                  }}
                />
              </div>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
