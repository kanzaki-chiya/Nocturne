import { useEffect, useState } from "react";
import { Text } from "ink";
import type { Runtime } from "@nocturne/core";
import type { SubagentSummary } from "@nocturne/core/protocol";
import { PickList } from "./pick-list.js";

export function Subagents({
  runtime,
  sessionId,
  width,
  onClose,
}: {
  runtime: Runtime;
  sessionId: string;
  width: number;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SubagentSummary[]>([]);
  const [selected, setSelected] = useState<SubagentSummary>();
  const [worktrees, setWorktrees] = useState<Awaited<ReturnType<Runtime["listSubagentWorktrees"]>>>(
    [],
  );
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void runtime
        .listSubagentWorktrees({ parentSessionId: sessionId })
        .then((records) => {
          if (active) setWorktrees(records);
        })
        // 保留副本列表失败不挡住运行中的子代理
        .catch(() => undefined);
      void runtime
        .listSubagents({ parentSessionId: sessionId })
        .then((list) => {
          if (active) {
            setItems(list.filter((item) => item.background && item.state === "running"));
            setNow(Date.now());
          }
        })
        .catch((cause: unknown) => {
          if (active) setError(String(cause));
        });
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runtime, sessionId]);
  if (error) return <Text>{error}</Text>;
  const isolated = new Set(worktrees.map((record) => record.childSessionId));
  const retained = worktrees.filter(
    (record) =>
      record.changes !== undefined &&
      !items.some((item) => item.childSessionId === record.childSessionId),
  );
  if (deleting)
    return (
      // 各弹层用不同 key：同位置的 PickList 会沿用上一层的光标
      <PickList
        key="delete"
        title="删除副本与分支？其中的改动会丢失"
        items={[
          { label: "返回", value: false },
          { label: "删除", value: true },
        ]}
        active
        width={width}
        onCancel={() => {
          setDeleting(undefined);
        }}
        onPick={(confirmed) => {
          if (!confirmed) {
            setDeleting(undefined);
            return;
          }
          void runtime
            .deleteSubagentWorktree({ parentSessionId: sessionId, childSessionId: deleting })
            .then(onClose)
            .catch((cause: unknown) => {
              setError(String(cause));
            });
        }}
      />
    );
  if (selected)
    return (
      <PickList
        key="cancel"
        title={`取消 ${selected.profile}？`}
        items={[
          { label: "返回", value: false },
          { label: "取消子代理", value: true },
        ]}
        active
        width={width}
        onCancel={() => {
          setSelected(undefined);
        }}
        onPick={(cancel) => {
          if (!cancel) {
            setSelected(undefined);
            return;
          }
          void runtime
            .cancelSubagent({ parentSessionId: sessionId, childSessionId: selected.childSessionId })
            .then(onClose)
            .catch((cause: unknown) => {
              setError(String(cause));
            });
        }}
      />
    );
  return (
    <PickList
      key="list"
      title="后台子代理"
      items={[
        ...items.map((item) => ({
          label: `${item.profile}${isolated.has(item.childSessionId) ? " · 隔离" : ""} · ${Math.max(0, Math.floor((now - Date.parse(item.startedAt)) / 1000))}s · ${item.taskSummary}`,
          value: item.childSessionId,
        })),
        ...retained.map((record) => ({
          label: `${record.branch} · 改动 ${record.changes?.files.length ?? 0} 个文件`,
          value: record.childSessionId,
        })),
      ]}
      active
      width={width}
      onCancel={onClose}
      onPick={(id) => {
        const running = items.find((item) => item.childSessionId === id);
        if (running) setSelected(running);
        else setDeleting(id);
      }}
    />
  );
}
