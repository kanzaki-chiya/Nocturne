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
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const refresh = () => {
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
  if (selected)
    return (
      <PickList
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
      title="后台子代理"
      items={items.map((item) => ({
        label: `${item.profile} · ${Math.max(0, Math.floor((now - Date.parse(item.startedAt)) / 1000))}s · ${item.taskSummary}`,
        value: item,
      }))}
      active
      width={width}
      onCancel={onClose}
      onPick={setSelected}
    />
  );
}
