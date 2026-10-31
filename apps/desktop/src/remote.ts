import { useEffect, useState } from "react";
import type { RemoteStatus, RpcClient } from "@nocturne/rpc/client";

export const REMOTE_CONNECTION_TEXT: Record<RemoteStatus["connection"], string> = {
  off: "已关闭",
  connecting: "连接中",
  online: "在线",
  offline: "离线",
  revoked: "已被吊销",
  replaced: "已在别处上线",
};
export function useRemoteStatus(client: RpcClient | undefined): RemoteStatus | undefined {
  const [status, setStatus] = useState<RemoteStatus>();
  useEffect(() => {
    let alive = true,
      updated = false;
    setStatus(undefined);
    if (!client) return;
    const unsubscribe = client.onNotification("remote.statusChanged", ({ status }) => {
      updated = true;
      if (alive) setStatus(status);
    });
    const offAgentStatus = client.onNotification("agent.statusChanged", (agentStatus) => {
      if (!alive) return;
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              agents: agentStatus.agents,
              pendingAgentPairings: agentStatus.pendingPairings,
              ...(agentStatus.pipe !== undefined ? { agentPipe: agentStatus.pipe } : {}),
            }
          : prev,
      );
    });
    const offAgentPair = client.onNotification("agent.pairingRequested", (req) => {
      if (!alive) return;
      setStatus((prev) => {
        if (!prev) return prev;
        const list = prev.pendingAgentPairings ?? [];
        if (list.some((item) => item.requestId === req.requestId)) return prev;
        return {
          ...prev,
          pendingAgentPairings: [...list, req],
        };
      });
    });
    void client
      .call("remote.describe", {})
      .then((status) => {
        if (alive && !updated) setStatus(status);
      })
      .catch(() => undefined);
    void client.closed.then(() => {
      if (alive) setStatus(undefined);
    });
    return () => {
      alive = false;
      unsubscribe();
      offAgentStatus();
      offAgentPair();
    };
  }, [client]);
  return status;
}
