import path from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Runtime, RuntimeSession } from "@nocturne/core";
import type { Grant, GrantWorkspace } from "@nocturne/core/protocol";
import type { DialogMouseFrame } from "./dialog/mouse.js";
import { PageShell, type ShellNotice, type ShellRow } from "./page/page-shell.js";

export function GrantsPage({
  runtime,
  session,
  width,
  height,
  onClose,
  onMouseFrame,
}: {
  runtime: Runtime;
  session: RuntimeSession;
  width: number;
  height: number;
  onClose: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}) {
  const [workspaces, setWorkspaces] = useState<GrantWorkspace[]>([]);
  const [selected, setSelected] = useState(session.state().meta.workspaceRoot);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [notice, setNotice] = useState<ShellNotice>();
  const [confirmation, setConfirmation] = useState<{ text: string; run: () => Promise<void> }>();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const refresh = useCallback(async () => {
    const [list, entries] = await Promise.all([
      runtime.listGrantWorkspaces(),
      runtime.listGrants({ workspace: selected }),
    ]);
    setWorkspaces(list);
    setGrants(entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, [runtime, selected]);
  useEffect(() => {
    void refresh().catch((e: unknown) => {
      setNotice({ text: String(e), tone: "error" });
    });
    return runtime.onGrantsChanged(() => {
      void refresh().catch((e: unknown) => {
        setNotice({ text: String(e), tone: "error" });
      });
    });
  }, [runtime, refresh]);
  const run = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await action();
      setConfirmation(undefined);
      setNotice({
        text: "已更新。撤销从下一次调用生效；信任变更新开或重新打开会话生效。",
        tone: "accent",
      });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), tone: "error" });
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const current = workspaces.find((entry) => entry.workspace === selected);
  const rows: ShellRow[] = confirmation
    ? [
        { id: "confirm", cells: [{ text: "确认执行", tone: "warning" }] },
        { id: "cancel", cells: [{ text: "取消" }] },
        ...confirmation.text
          .split("\n")
          .map((text, i) => ({ id: `description:${i}`, cells: [{ text }] })),
      ]
    : grants.map((grant, i) => ({
        id: String(i),
        cells: [{ text: grant.kind }, { text: grant.target }],
        trail: [{ text: grant.createdAt, tone: "muted" }],
      }));
  return (
    <PageShell
      title={["授权", confirmation ? "确认" : path.basename(selected)]}
      subtitle={
        current
          ? `${current.trusted ? "已信任" : "未信任"} · ${current.hasProjectConfig ? "有项目配置" : "没有项目配置"} · ${grants.length} 项授权`
          : selected
      }
      rows={rows}
      sidebar={
        confirmation
          ? undefined
          : {
              items: workspaces.map((entry) => ({
                id: entry.workspace,
                label: path.basename(entry.workspace),
                count: entry.grantCount,
              })),
              mode: "filter",
              activeId: selected,
            }
      }
      arrows="focus"
      initialFocus="list"
      width={width}
      height={height}
      active={!busy}
      notice={notice}
      onMouseFrame={onMouseFrame}
      emptyText="还没有项目授权。确认时选『本项目允许』会出现在这里。"
      resetToken={`${selected}:${Boolean(confirmation)}`}
      describe={() =>
        (
          confirmation?.text ??
          "规则写在 config.json 的 permissions.rules；这里只管理确认时点出来的授权。"
        )
          .split("\n")
          .map((text) => [{ text }])
      }
      hints={
        confirmation
          ? [
              ["Enter", "确认"],
              ["Esc", "取消"],
            ]
          : [
              ["d", "撤销"],
              ["D", "全部撤销"],
              ["t", "切换信任"],
              ["Esc", "返回"],
            ]
      }
      onClose={() => {
        if (confirmation) setConfirmation(undefined);
        else onClose();
      }}
      onSideActivate={(id) => {
        setSelected(id);
        setConfirmation(undefined);
        return "list";
      }}
      onActivate={(id) => {
        if (!confirmation) return;
        if (id === "cancel") setConfirmation(undefined);
        else if (id === "confirm") void run(confirmation.run);
      }}
      onKey={(input, _key, context) => {
        if (confirmation) return false;
        if (input === "d") {
          const grant = grants[Number(context.rowId)];
          if (grant)
            void run(() =>
              runtime.revokeGrant({ workspace: selected, kind: grant.kind, target: grant.target }),
            );
          return true;
        }
        if (input === "D") {
          if (grants.length)
            setConfirmation({
              text: "撤销这个工作区的全部授权？下一次调用会重新询问。",
              run: () => runtime.revokeAllGrants({ workspace: selected }),
            });
          return true;
        }
        if (input === "t") {
          if (current?.trusted)
            void run(() => runtime.setWorkspaceTrusted({ workspace: selected, trusted: false }));
          else if (current?.hasProjectConfig) {
            void runtime
              .describeProject({ workspace: selected })
              .then((description) => {
                setConfirmation({
                  text: [
                    `信任 ${selected}？`,
                    ...description.mcpServers.map((entry) => `MCP ${entry.name}: ${entry.command}`),
                    ...description.hooks.map((entry) => `Hook ${entry.event}: ${entry.count} 条`),
                    `放宽规则 ${description.relaxedRuleCount} 条。配置来自仓库，打开会话时执行。`,
                  ].join("\n"),
                  run: () => runtime.setWorkspaceTrusted({ workspace: selected, trusted: true }),
                });
              })
              .catch((e: unknown) => {
                setNotice({ text: String(e), tone: "error" });
              });
          }
          return true;
        }
        return false;
      }}
    />
  );
}
