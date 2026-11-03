/**
 * 设置 › 浏览器（ADR-0078）：Agent 浏览器开关。只有桌面端有这一页。
 */
import { useEffect, useState } from "react";

import type { AgentBrowserHost } from "./host";
import type { PrefsStore } from "./prefs";
import { Button } from "./ui/Button";
import { PageHeader } from "./ui/PageHeader";
import { SettingsGroup } from "./ui/SettingsGroup";
import { SettingsRow } from "./ui/SettingsRow";
import { Switch } from "./ui/Switch";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function BrowserSettingsPage({
  prefs,
  agentBrowser,
  relaunch,
  version,
}: {
  prefs: PrefsStore;
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
        if (live) setRestartRequired(status.restartRequired);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host, version]);

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
        <div className="agent-browser-risk" role="alertdialog" aria-label="启用模型操作网页">
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
