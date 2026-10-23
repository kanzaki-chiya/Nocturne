import { useEffect, useMemo, useRef } from "react";

/**
 * 同一会话 single-flight：已有请求在飞时，后续变化只标记为脏，
 * 等这次返回后再补一次。禁用、卸载或换成另一个会话后，旧响应不再提交。
 */
export function useSessionRefresh(
  session: object,
  enabled: boolean,
  run: (isCurrent: () => boolean) => Promise<void>,
): () => Promise<void> {
  const owner = useRef(session);
  owner.current = session;
  const state = useMemo(() => {
    const flight = {
      active: true,
      enabled,
      dirty: false,
      run,
      pending: undefined as Promise<void> | undefined,
      request: (): Promise<void> => {
        if (!flight.active || !flight.enabled) return Promise.resolve();
        flight.dirty = true;
        if (flight.pending) return flight.pending;
        const current = () =>
          flight.active && flight.enabled && owner.current === session && !flight.dirty;
        const again = () =>
          flight.dirty && flight.active && flight.enabled && owner.current === session;
        flight.pending = (async () => {
          do {
            flight.dirty = false;
            await flight.run(current);
          } while (again());
        })().finally(() => {
          flight.pending = undefined;
        });
        return flight.pending;
      },
    };
    return flight;
  }, [session]);
  state.enabled = enabled;
  state.run = run;
  if (!enabled) state.dirty = false;
  useEffect(() => {
    state.active = true;
    return () => {
      state.active = false;
    };
  }, [state]);
  return state.request;
}
