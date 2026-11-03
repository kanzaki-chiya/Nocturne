/**
 * 设置 › 浏览器（ADR-0078）：Agent 浏览器开关、模型回复里链接的打开方式、两份浏览数据、
 * 用户标签的下载。
 * 只有桌面端有这一页。
 */
import { Fragment, useEffect, useState } from "react";

import { Dropdown } from "./Dropdown";
import type { AgentBrowserHost } from "./host";
import type { LinkOpener, Prefs, PrefsStore } from "./prefs";
import { Button } from "./ui/Button";
import { PageHeader } from "./ui/PageHeader";
import { SettingsGroup } from "./ui/SettingsGroup";
import { SettingsRow } from "./ui/SettingsRow";
import { Switch } from "./ui/Switch";

const LINK_OPENERS = [
  { value: "system", label: "系统浏览器" },
  { value: "panel", label: "Nocturne 面板" },
] as const;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 同步给外壳的下载设置：询问缺省开；dir 为 null = 系统「下载」文件夹 */
export function downloadSettings(prefs: Prefs): { ask: boolean; dir: string | null } {
  return { ask: prefs.downloadAsk !== false, dir: prefs.downloadDir ?? null };
}

/** 占用大小：B / KB / MB 取整，GB 留一位小数 */
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** 两份浏览数据的大小与清除；没有内置浏览器的宿主不给 */
export interface BrowsingDataHost {
  sizes: () => Promise<{ user: number; agent: number }>;
  /** 返回清除后的实际字节数 */
  clear: (which: "user" | "agent") => Promise<number>;
}

/** 下载设置同步给外壳、选目录；没有内置浏览器的宿主不给 */
export interface DownloadsHost {
  set: (ask: boolean, dir: string | null) => Promise<{ defaultDir: string | null }>;
  pickFolder: () => Promise<string | null>;
}

export function BrowserSettingsPage({
  prefs,
  agentBrowser,
  browsingData,
  downloads,
  relaunch,
  version,
}: {
  prefs: PrefsStore;
  /** 没有内置浏览器时不显示「浏览数据」 */
  browsingData?: BrowsingDataHost | undefined;
  /** 没有内置浏览器时不显示「下载」 */
  downloads?: DownloadsHost | undefined;
  /** 没有外壳时不显示「Agent 浏览器」 */
  agentBrowser?: AgentBrowserHost | undefined;
  /** 「重启应用」 */
  relaunch: () => Promise<void>;
  /** 进入页面时递增：重新读外壳状态 */
  version: number;
}) {
  return (
    <section className="page3" aria-label="浏览器">
      <div className="spage">
        <div className="readable">
          <PageHeader title="浏览器" />
          <div className="sbody">
            {agentBrowser !== undefined && (
              <SettingsGroup title="Agent 浏览器">
                <AgentBrowserRow
                  host={agentBrowser}
                  prefs={prefs}
                  relaunch={relaunch}
                  version={version}
                />
              </SettingsGroup>
            )}
            <SettingsGroup title="打开方式">
              <LinkOpenerRow label="网页链接" field="webLinkOpener" prefs={prefs} />
              <LinkOpenerRow label="本地网址" field="localLinkOpener" prefs={prefs} />
            </SettingsGroup>
            {browsingData !== undefined && (
              <SettingsGroup title="浏览数据">
                <BrowsingDataRows host={browsingData} version={version} />
              </SettingsGroup>
            )}
            {downloads !== undefined && (
              <SettingsGroup title="下载">
                <DownloadRows host={downloads} prefs={prefs} />
              </SettingsGroup>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * 「模型操作网页」：存 prefs.agentBrowserEnabled（字段名沿用），外壳另存开关标记。
 * 正在运行的后台和开关不一致时（外壳判断，见 desktop-browser.md 第 1 节）左边出现「重启应用」。
 */
function AgentBrowserRow({
  host,
  prefs,
  relaunch,
  version,
}: {
  host: AgentBrowserHost;
  prefs: PrefsStore;
  relaunch: () => Promise<void>;
  version: number;
}) {
  const [enabled, setEnabled] = useState(() => prefs.get().agentBrowserEnabled === true);
  const [restartRequired, setRestartRequired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (host.status === undefined) return;
    let live = true;
    host.status().then(
      (status) => {
        if (!live) return;
        setEnabled(status.enabled);
        setRestartRequired(status.restartRequired);
        if ((prefs.get().agentBrowserEnabled === true) !== status.enabled) {
          prefs.update({ agentBrowserEnabled: status.enabled });
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host, prefs, version]);

  const apply = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await host.setEnabled(next);
      prefs.update({ agentBrowserEnabled: result.enabled });
      setEnabled(result.enabled);
      setRestartRequired(result.restartRequired);
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
  const restart = async () => {
    setError(null);
    try {
      await relaunch();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <>
      <SettingsRow label="模型操作网页" error={error ?? undefined}>
        {restartRequired && (
          <Button size="sm" onClick={() => void restart()}>
            重启应用
          </Button>
        )}
        <Switch aria-label="模型操作网页" checked={enabled} disabled={busy} onChange={onToggle} />
      </SettingsRow>
      {confirming && (
        <SettingsRow
          label="网页内容不可信，可能诱导它操作其他页面。"
          role="alertdialog"
          ariaLabel="启用模型操作网页"
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
            disabled={busy}
            onClick={() => {
              prefs.update({ agentBrowserRiskAccepted: true });
              setConfirming(false);
              void apply(true);
            }}
          >
            仍然启用
          </Button>
        </SettingsRow>
      )}
    </>
  );
}

/** 缺省系统浏览器：选回系统浏览器时清掉字段，不写入缺省值 */
function LinkOpenerRow({
  label,
  field,
  prefs,
}: {
  label: string;
  field: "webLinkOpener" | "localLinkOpener";
  prefs: PrefsStore;
}) {
  const [value, setValue] = useState<LinkOpener>(() => prefs.get()[field] ?? "system");
  return (
    <SettingsRow label={label}>
      <Dropdown
        label={label}
        value={value}
        options={LINK_OPENERS}
        onChange={(next) => {
          const opener: LinkOpener = next === "panel" ? "panel" : "system";
          prefs.update({ [field]: opener === "panel" ? "panel" : undefined });
          setValue(opener);
        }}
      />
    </SettingsRow>
  );
}

/**
 * 「每次询问保存位置」「保存位置」：写 prefs（缺省值不写），再同步给外壳。
 * 没设保存位置时显示系统「下载」文件夹（外壳给的路径）。
 */
function DownloadRows({ host, prefs }: { host: DownloadsHost; prefs: PrefsStore }) {
  const [settings, setSettings] = useState(() => downloadSettings(prefs.get()));
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = async (next: { ask: boolean; dir: string | null }) => {
    setError(null);
    try {
      const result = await host.set(next.ask, next.dir);
      setDefaultDir(result.defaultDir);
    } catch (e) {
      setError(errText(e));
    }
  };
  // 进入页面时取系统「下载」文件夹（同步一次当前设置）
  useEffect(() => {
    let live = true;
    const { ask, dir } = downloadSettings(prefs.get());
    host.set(ask, dir).then(
      (result) => {
        if (live) setDefaultDir(result.defaultDir);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host, prefs]);

  const apply = (next: { ask: boolean; dir: string | null }) => {
    prefs.update({
      downloadAsk: next.ask ? undefined : false,
      downloadDir: next.dir ?? undefined,
    });
    setSettings(next);
    void sync(next);
  };
  const shown = settings.dir ?? defaultDir ?? "";
  return (
    <>
      <SettingsRow label="每次询问保存位置">
        <Switch
          aria-label="每次询问保存位置"
          checked={settings.ask}
          onChange={(ask) => {
            apply({ ...settings, ask });
          }}
        />
      </SettingsRow>
      <SettingsRow label="保存位置" error={error ?? undefined}>
        <span className="val mono" title={shown}>
          {shown}
        </span>
        <Button
          size="sm"
          onClick={() => {
            void host.pickFolder().then(
              (dir) => {
                if (dir !== null) apply({ ...settings, dir });
              },
              (e: unknown) => {
                setError(errText(e));
              },
            );
          }}
        >
          更改…
        </Button>
      </SettingsRow>
    </>
  );
}

const DATA_ROWS = [
  {
    which: "user",
    label: "我的浏览",
    confirm: "面板里登录过的网站都要重新登录。",
    dialog: "清除我的浏览数据",
  },
  {
    which: "agent",
    label: "Agent 浏览",
    confirm: "Agent 登录过的网站都要重新登录。",
    dialog: "清除 Agent 浏览数据",
  },
] as const;

/** 「我的浏览」「Agent 浏览」：进入页面时刷新大小；「清除…」在行下展开内联确认 */
function BrowsingDataRows({ host, version }: { host: BrowsingDataHost; version: number }) {
  const [sizes, setSizes] = useState<{ user: number; agent: number } | null>(null);
  const [confirming, setConfirming] = useState<"user" | "agent" | null>(null);
  const [clearing, setClearing] = useState<"user" | "agent" | null>(null);
  const [errors, setErrors] = useState<{ user?: string; agent?: string }>({});

  useEffect(() => {
    let live = true;
    host.sizes().then(
      (next) => {
        if (live) setSizes(next);
      },
      (e: unknown) => {
        if (live) setErrors({ user: errText(e), agent: errText(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [host, version]);

  const clear = async (which: "user" | "agent") => {
    setConfirming(null);
    setClearing(which);
    setErrors((prev) => ({ ...prev, [which]: undefined }));
    try {
      const size = await host.clear(which);
      setSizes((prev) => (prev === null ? prev : { ...prev, [which]: size }));
    } catch (e) {
      setErrors((prev) => ({ ...prev, [which]: errText(e) }));
    } finally {
      setClearing(null);
    }
  };

  return (
    <>
      {DATA_ROWS.map((row) => (
        <Fragment key={row.which}>
          <SettingsRow label={row.label} error={errors[row.which]}>
            {sizes !== null && <span className="val">{formatSize(sizes[row.which])}</span>}
            <Button
              size="sm"
              disabled={clearing !== null}
              aria-expanded={confirming === row.which}
              onClick={() => {
                setConfirming(confirming === row.which ? null : row.which);
              }}
            >
              清除…
            </Button>
          </SettingsRow>
          {confirming === row.which && (
            <SettingsRow label={row.confirm} role="alertdialog" ariaLabel={row.dialog}>
              <Button
                size="sm"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                取消
              </Button>
              <Button size="sm" variant="danger-solid" onClick={() => void clear(row.which)}>
                清除
              </Button>
            </SettingsRow>
          )}
        </Fragment>
      ))}
    </>
  );
}
