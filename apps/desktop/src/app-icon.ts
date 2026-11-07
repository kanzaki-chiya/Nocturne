import type { ApplicationTarget } from "@nocturne/core/protocol";
import type { RpcComputer } from "@nocturne/rpc/client";

/** 确认卡按主体自己的 app（pid / windowId / identity）取单个软件图标；失败视为没有图标 */
export function appIconResolver(
  computer: Pick<RpcComputer, "appIcon">,
): (app: ApplicationTarget) => Promise<string | undefined> {
  return async (app) => {
    const icon = await computer
      .appIcon({
        ...(app.pid !== undefined ? { pid: app.pid } : {}),
        ...(app.windowId !== undefined ? { windowId: app.windowId } : {}),
        ...(app.identity !== undefined ? { identity: app.identity } : {}),
      })
      .catch(() => null);
    return icon ?? undefined;
  };
}
