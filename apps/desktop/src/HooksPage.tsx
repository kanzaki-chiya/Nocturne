import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOOK_POINTS,
  isToolHookPoint,
  type HookOverview,
  type HooksDescription,
  type PluginsDescription,
} from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { PluginIcon } from "./PluginsPage";
import { Badge, EmptyState, PageHeader, SettingsGroup, SettingsListRow } from "./ui";
import "./pages.css";
import "./hooks.css";

function formatCommand(command: string, args: readonly string[]): string {
  const quote = (part: string) => (/\s/.test(part) ? JSON.stringify(part) : part);
  return [command, ...args].map(quote).join(" ");
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs >= 1000 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} ms`;
}

function HookList({ hooks }: { hooks: readonly HookOverview[] }) {
  return (
    <div className="hooks-list">
      {hooks.map((hook, i) => {
        const untrusted = hook.origin === "project" && !hook.trusted;
        return (
          <div
            key={`${hook.point}-${hook.origin}-${hook.path}-${hook.command}-${i}`}
            className={`hook-item${untrusted ? " untrusted" : ""}`}
          >
            <div className="hook-head">
              <code className="hook-cmd">{formatCommand(hook.command, hook.args)}</code>
              {isToolHookPoint(hook.point) && hook.matcher !== undefined && hook.matcher !== "" && (
                <Badge className="hook-matcher">{hook.matcher}</Badge>
              )}
              {hook.origin === "project" && (
                <Badge variant={hook.trusted ? "ok" : "warn"}>
                  {hook.trusted ? "已信任" : "未信任"}
                </Badge>
              )}
            </div>
            <div className="hook-meta">
              <span className="hook-timeout">{formatTimeout(hook.timeoutMs)}</span>
              <span aria-hidden="true">·</span>
              <span className="hook-source" title={hook.path}>
                {hook.path}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function HooksPage({
  client,
  workspaceRoot,
  version,
  onOpenPlugin,
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
  onOpenPlugin?: ((id: string) => void) | undefined;
}) {
  const [data, setData] = useState<HooksDescription>();
  const [pluginsData, setPluginsData] = useState<PluginsDescription>();
  const [error, setError] = useState("");
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!client) return;
    const generation = ++refreshGeneration.current;
    try {
      const [hooksResult, pluginsResult] = await Promise.all([
        client.runtime.describeHooks({ workspaceRoot }),
        client.runtime.describePlugins(),
      ]);
      if (generation !== refreshGeneration.current) return;
      setData(hooksResult);
      setPluginsData(pluginsResult);
      setError("");
    } catch (e) {
      if (generation === refreshGeneration.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [client, workspaceRoot]);

  useEffect(() => {
    void refresh();
    const offProviders = client?.onProvidersChanged(() => {
      void refresh();
    });
    const offGrants = client?.onNotification("grants.changed", () => {
      void refresh();
    });
    return () => {
      refreshGeneration.current++;
      offProviders?.();
      offGrants?.();
    };
  }, [client, refresh, version]);

  const hooks = data?.hooks ?? [];
  const pluginHooks = (pluginsData?.plugins ?? []).filter(
    (p) => p.state === "on" && p.hooks.length > 0,
  );
  const empty =
    data !== undefined &&
    pluginsData !== undefined &&
    hooks.length === 0 &&
    pluginHooks.length === 0;

  return (
    <section className="page3 hooks-page" aria-label="Hook">
      <div className="spage">
        <div className="readable">
          <PageHeader title="Hook" />
          {error && (
            <div className="errt" role="alert">
              {error}
            </div>
          )}
          {empty ? (
            <EmptyState>没有 Hook</EmptyState>
          ) : (
            <div className="sbody">
              {HOOK_POINTS.map((point) => {
                const items = hooks.filter((h) => h.point === point);
                if (items.length === 0) return null;
                return (
                  <SettingsGroup key={point} plain title={point} count={items.length}>
                    <HookList hooks={items} />
                  </SettingsGroup>
                );
              })}
              {pluginHooks.length > 0 && (
                <SettingsGroup plain title="来自插件" count={pluginHooks.length}>
                  {pluginHooks.map((plugin) => (
                    <SettingsListRow
                      key={plugin.id}
                      leading={<PluginIcon icon={plugin.icon} />}
                      name={plugin.displayName ?? plugin.name}
                      description={`${plugin.hooks.length} 个 Hook`}
                      onOpen={() => {
                        onOpenPlugin?.(plugin.id);
                      }}
                    />
                  ))}
                </SettingsGroup>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
