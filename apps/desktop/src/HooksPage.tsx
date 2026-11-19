import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOOK_POINTS,
  isToolHookPoint,
  type HookOverview,
  type HooksDescription,
} from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { Badge, EmptyState, PageHeader, SettingsGroup } from "./ui";
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
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
}) {
  const [data, setData] = useState<HooksDescription>();
  const [error, setError] = useState("");
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!client) return;
    const generation = ++refreshGeneration.current;
    try {
      const result = await client.runtime.describeHooks({ workspaceRoot });
      if (generation !== refreshGeneration.current) return;
      setData(result);
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
  const empty = data !== undefined && hooks.length === 0;

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
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
