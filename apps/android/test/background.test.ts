import { beforeEach, describe, expect, it, vi } from "vitest";
import { Background, connectedText } from "../src/background";
import { shellHost, type AppHost } from "../src/host";
import { ProbeLog } from "../src/probe";

const computer = { hostId: "h", hostPub: "p", name: "电脑 1", pairedAt: 1 };

function fixture(overrides: Partial<AppHost> = {}) {
  const calls: string[] = [];
  const host: AppHost = {
    ...shellHost,
    startService: (text) => {
      calls.push(`start ${text}`);
      return Promise.resolve();
    },
    updateService: (text) => {
      calls.push(`update ${text}`);
      return Promise.resolve();
    },
    stopService: () => {
      calls.push("stop");
      return Promise.resolve();
    },
    ...overrides,
  };
  const probe = new ProbeLog(() => true);
  const background = new Background(host, probe);
  const settle = () => new Promise((done) => setTimeout(done, 0));
  return { calls, probe, background, settle };
}

beforeEach(() => {
  localStorage.clear();
});

describe("常驻通知文案", () => {
  it("已连接显示电脑名，其余为正在连接", () => {
    expect(connectedText(computer, "online")).toBe("Nocturne 远程：已连接 电脑 1");
    for (const state of ["connecting", "offline", "revoked", "incompatible"] as const)
      expect(connectedText(computer, state)).toBe("Nocturne 远程：正在连接…");
    expect(connectedText(undefined, "online")).toBe("Nocturne 远程：正在连接…");
  });
});

describe("Background", () => {
  it("没有已配对电脑时不启动；有电脑后启动，文案随连接状态更新", async () => {
    const { calls, background, settle } = fixture();
    background.observer.hosts?.([]);
    await settle();
    expect(calls).toEqual([]);
    background.observer.hosts?.([computer]);
    await settle();
    expect(calls).toEqual(["start Nocturne 远程：正在连接…"]);
    background.observer.state?.(computer, "online", "");
    await settle();
    expect(calls.at(-1)).toBe("update Nocturne 远程：已连接 电脑 1");
    background.observer.state?.(computer, "offline", "电脑已离线");
    await settle();
    expect(calls.at(-1)).toBe("update Nocturne 远程：正在连接…");
  });

  it("开关默认开，关闭后停止服务，再打开重新启动；设置存在本地", async () => {
    const { calls, background, settle } = fixture();
    expect(background.enabled).toBe(true);
    background.observer.hosts?.([computer]);
    await settle();
    background.enabled = false;
    await settle();
    expect(calls).toEqual(["start Nocturne 远程：正在连接…", "stop"]);
    expect(new Background(shellHost, new ProbeLog(() => true)).enabled).toBe(false);
    background.enabled = true;
    await settle();
    expect(calls.at(-1)).toBe("start Nocturne 远程：正在连接…");
  });

  it("移除最后一台电脑后停止服务", async () => {
    const { calls, background, settle } = fixture();
    background.observer.hosts?.([computer]);
    await settle();
    background.observer.hosts?.([]);
    await settle();
    expect(calls.at(-1)).toBe("stop");
  });

  it("服务启动失败只记入探针，不影响连接，之后可以重试", async () => {
    let fail = true;
    const { probe, background, settle, calls } = fixture({
      startService: () => {
        if (fail) return Promise.reject(new Error("无权限"));
        calls.push("start ok");
        return Promise.resolve();
      },
    });
    background.observer.hosts?.([computer]);
    await settle();
    expect(
      probe.all().some((entry) => entry[1] === "service" && entry[2].includes("error 无权限")),
    ).toBe(true);
    fail = false;
    background.observer.state?.(computer, "online", "");
    await settle();
    expect(calls).toContain("start ok");
  });

  it("探针记录事件与断线：只有类型、会话 id、序号", () => {
    const { probe, background } = fixture();
    background.observer.event?.("s1", "message.delta", 3, true);
    background.observer.disconnected?.(computer, "网络断开");
    background.observer.state?.(computer, "online", "");
    const kinds = probe.all().map((entry) => entry[1]);
    expect(kinds).toContain("event");
    expect(kinds).toContain("disconnect");
    expect(kinds).toContain("connect");
    expect(probe.all().find((entry) => entry[1] === "event")?.[2]).toBe(
      "fg live s1 message.delta 3",
    );
  });
});

describe("tauriHost 经白名单命令调用插件", () => {
  it("每个方法都转成 plugin:background|call 的一个命令", async () => {
    const invoke = vi.fn((_cmd: string, args?: { command: string }) =>
      Promise.resolve(
        args?.command === "status"
          ? { running: true, ignoringBatteryOptimizations: false }
          : { text: "x" },
      ),
    );
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.resetModules();
    const { tauriHost } = await import("../src/host");
    await tauriHost.startService("a");
    await tauriHost.updateService("b");
    await tauriHost.stopService();
    await tauriHost.openSettings("autostart");
    expect(await tauriHost.backgroundStatus()).toEqual({
      supported: true,
      running: true,
      ignoringBatteryOptimizations: false,
    });
    expect(await tauriHost.nativeLog()).toBe("x");
    await tauriHost.clearNativeLog();
    expect(invoke.mock.calls.map(([name, args]) => [name, args?.command])).toEqual([
      ["plugin:background|call", "start"],
      ["plugin:background|call", "update"],
      ["plugin:background|call", "stop"],
      ["plugin:background|call", "open_settings"],
      ["plugin:background|call", "status"],
      ["plugin:background|call", "log"],
      ["plugin:background|call", "clear_log"],
    ]);
    vi.doUnmock("@tauri-apps/api/core");
  });
});
