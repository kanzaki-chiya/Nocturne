import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";
import type { Grant } from "@nocturne/core/protocol";
import { grantKind } from "./GrantsPage";
import "./grants.css";

export function useSessionGrants(session: RpcSession | undefined, client: RpcClient | undefined) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!session) return;
    const version = ++generation.current;
    try {
      const entries = await session.listGrants();
      if (version !== generation.current) return;
      setGrants(entries);
      setError("");
    } catch (reason) {
      if (version === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [session]);
  useEffect(() => {
    setGrants([]);
    void refresh();
    const unsubscribe = client?.onNotification("grants.changed", () => {
      void refresh();
    });
    return () => {
      generation.current++;
      unsubscribe?.();
    };
  }, [client, refresh]);
  return { grants, error, refresh };
}
export function SessionGrants({
  grants,
  session,
  onManage,
}: {
  grants: Grant[];
  session: RpcSession;
  onManage?: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  if (grants.length === 0) return null;
  const revoke = async (grant?: Grant) => {
    setBusy(true);
    setError("");
    try {
      if (grant) await session.revokeGrant({ kind: grant.kind, target: grant.target });
      else await session.revokeAllGrants();
      setConfirm(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="session-grants" aria-label="本会话授权">
      <h4>本会话已允许 {grants.length} 项</h4>
      {grants.map((grant) => (
        <div className="session-grant" key={`${grant.kind}:${grant.target}`}>
          <span>{grantKind(grant.kind)}</span>
          <code title={grant.target}>
            {grant.target.length > 90 ? `${grant.target.slice(0, 86)}…` : grant.target}
          </code>
          <button
            disabled={busy}
            onClick={() => {
              void revoke(grant);
            }}
          >
            撤销
          </button>
        </div>
      ))}
      <div className="session-grants-actions">
        <button
          disabled={busy}
          onClick={() => {
            if (confirm) void revoke();
            else setConfirm(true);
          }}
        >
          {confirm ? "确认全部撤销" : "全部撤销"}
        </button>
        {onManage && <button onClick={onManage}>管理项目授权 →</button>}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
