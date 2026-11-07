import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationTarget } from "@nocturne/core/protocol";
import type { RpcRuntimeHandle } from "@nocturne/rpc/server";
import type { ComputerDriverState } from "@nocturne/rpc/client";
import { cleanupTmp, connect } from "./harness.js";

afterEach(cleanupTmp);

function fakeComputer(state: Partial<ComputerDriverState>) {
  const resolveIcon = vi.fn(async (_app: ApplicationTarget, _identity?: string) => "SUNPTg==");
  const computer: NonNullable<RpcRuntimeHandle["computer"]> = {
    getState: () => ({
      enabled: true,
      cursor: true,
      state: "running",
      version: "test",
      ...state,
    }),
    setEnabled: async () => undefined,
    setCursor: async () => undefined,
    restart: async () => undefined,
    runningApps: vi.fn(async () => []),
    resolveIcon,
    subscribe: () => () => undefined,
  };
  return { computer, resolveIcon };
}

describe("computer.appIcon", () => {
  it("转到 hub 的 resolveIcon，参数带 pid、windowId、identity", async () => {
    const { computer, resolveIcon } = fakeComputer({});
    const h = await connect({ computer });
    const icon = await h.client.computer.appIcon({
      pid: 20,
      windowId: 100,
      identity: "excel.exe",
    });
    expect(icon).toBe("SUNPTg==");
    expect(resolveIcon).toHaveBeenCalledWith(
      { pid: 20, windowId: 100, identity: "excel.exe" },
      "excel.exe",
    );
    expect(computer.runningApps).not.toHaveBeenCalled();
  });

  it("电脑操控关闭、驱动未启动或没有电脑来源时返回空，不报错", async () => {
    const off = fakeComputer({ enabled: false });
    const offHarness = await connect({ computer: off.computer });
    expect(await offHarness.client.computer.appIcon({ pid: 20 })).toBeNull();
    expect(off.resolveIcon).not.toHaveBeenCalled();

    const stopped = fakeComputer({ state: "stopped" });
    const stoppedHarness = await connect({ computer: stopped.computer });
    expect(await stoppedHarness.client.computer.appIcon({ pid: 20 })).toBeNull();
    expect(stopped.resolveIcon).not.toHaveBeenCalled();

    const none = await connect();
    expect(await none.client.computer.appIcon({ pid: 20, identity: "excel.exe" })).toBeNull();
  });
});
