import { describe, expect, it } from "vitest";

import { createPrefsStore, PREFS_KEY } from "../src/prefs";
import { AUTO_CHECK_INTERVAL_MS, createUpdateService } from "../src/updater";
import type { AvailableUpdate } from "../src/host";

function memoryStorage(initial?: Record<string, string>): Storage {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

function fakeUpdate(
  version: string,
  notes: string | null = null,
): AvailableUpdate & {
  installs: number;
  failInstall?: (e: unknown) => void;
} {
  const update = {
    version,
    notes,
    installs: 0,
    failInstall: undefined as ((e: unknown) => void) | undefined,
    downloadAndInstall(onProgress?: (d: number, t: number | undefined) => void) {
      update.installs += 1;
      onProgress?.(1024, 2048);
      if (update.failInstall !== undefined) return Promise.reject(update.failInstall);
      return Promise.resolve();
    },
  };
  return update;
}

function harness(opts?: {
  update?: AvailableUpdate | null;
  checkError?: unknown;
  prefs?: Record<string, string>;
  version?: string;
  now?: () => number;
}) {
  const notes: string[] = [];
  let checks = 0;
  let relaunches = 0;
  const host = {
    checkUpdate: () => {
      checks += 1;
      if (opts?.checkError !== undefined) return Promise.reject(opts.checkError);
      return Promise.resolve(opts?.update ?? null);
    },
    relaunch: () => {
      relaunches += 1;
      return Promise.resolve();
    },
    note: (line: string) => {
      notes.push(line);
    },
  };
  const prefs = createPrefsStore(memoryStorage(opts?.prefs));
  const svc = createUpdateService({
    host,
    prefs,
    currentVersion: () => opts?.version ?? "0.5.0",
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    svc,
    prefs,
    notes,
    get checks() {
      return checks;
    },
    get relaunches() {
      return relaunches;
    },
  };
}

describe("update service", () => {
  it("24 小时内最多自动检查一次；开关关闭时完全不检查", async () => {
    let now = 1_000_000_000_000;
    const h = harness({ now: () => now });
    expect(await h.svc.autoCheck()).toBeUndefined();
    expect(h.checks).toBe(1);

    // 24h 内第二次：不再访问网络
    now += AUTO_CHECK_INTERVAL_MS - 1;
    expect(await h.svc.autoCheck()).toBeUndefined();
    expect(h.checks).toBe(1);

    // 超过 24h：再次检查
    now += 2;
    expect(await h.svc.autoCheck()).toBeUndefined();
    expect(h.checks).toBe(2);
  });

  it("autoUpdate 为 false 时跳过自动检查", async () => {
    const h = harness({
      prefs: { [PREFS_KEY]: JSON.stringify({ autoUpdate: false }) },
    });
    expect(await h.svc.autoCheck()).toBeUndefined();
    expect(h.checks).toBe(0);
  });

  it("自动检查失败只写外壳日志，不抛错、不写 pendingUpdate", async () => {
    const h = harness({ checkError: new Error("network unreachable") });
    expect(await h.svc.autoCheck()).toBeUndefined();
    expect(h.checks).toBe(1);
    expect(h.prefs.get().pendingUpdate).toBeUndefined();
    expect(h.notes.some((line) => line.includes("network unreachable"))).toBe(true);
  });

  it("发现新版本时写 pendingUpdate 并返回提示", async () => {
    const h = harness({ update: fakeUpdate("0.6.0", "修复若干问题") });
    const notice = await h.svc.autoCheck();
    expect(notice).toEqual({ version: "0.6.0", notes: "修复若干问题" });
    expect(h.prefs.get().pendingUpdate).toEqual({
      version: "0.6.0",
      notes: "修复若干问题",
    });
  });

  it("手动检查：失败把原因交回界面；无更新时回报 latest", async () => {
    const bad = harness({ checkError: "endpoint 404" });
    const failed = await bad.svc.manualCheck();
    expect(failed).toEqual({ kind: "error", message: "endpoint 404" });
    expect(bad.notes.some((line) => line.includes("手动检查更新失败"))).toBe(true);

    const ok = harness({});
    expect(await ok.svc.manualCheck()).toEqual({ kind: "latest" });
    // 手动检查同样计入节流（随后 24h 内自动检查不再访问网络）
    expect(ok.prefs.get().lastUpdateCheck).toBeTypeOf("number");
  });

  it("手动检查发现新版本时写 pendingUpdate", async () => {
    const h = harness({ update: fakeUpdate("9.9.9") });
    const result = await h.svc.manualCheck();
    expect(result).toEqual({ kind: "update", notice: { version: "9.9.9", notes: null } });
    expect(h.prefs.get().pendingUpdate?.version).toBe("9.9.9");
  });

  it("pendingUpdate 不比当前版本新时被丢弃；「稍后」不影响它", async () => {
    // 已存版本 ≤ 当前版本：清掉，不再提示
    const stale = harness({
      version: "0.6.0",
      prefs: {
        [PREFS_KEY]: JSON.stringify({
          pendingUpdate: { version: "0.6.0-rc.1", notes: null },
        }),
      },
    });
    expect(stale.svc.pendingNotice()).toBeUndefined();
    expect(stale.prefs.get().pendingUpdate).toBeUndefined();

    // 仍比当前新：重启后再提示（「稍后」只清本次运行的提示状态，不动 prefs）
    const fresh = harness({
      version: "0.5.0",
      prefs: {
        [PREFS_KEY]: JSON.stringify({
          pendingUpdate: { version: "0.6.0", notes: "n" },
        }),
      },
    });
    expect(fresh.svc.pendingNotice()).toEqual({ version: "0.6.0", notes: "n" });
  });

  it("安装：重新检查、下载安装、清 pendingUpdate 并重启", async () => {
    const update = fakeUpdate("0.6.0");
    const h = harness({
      update,
      prefs: {
        [PREFS_KEY]: JSON.stringify({ pendingUpdate: { version: "0.6.0", notes: null } }),
      },
    });
    const progress: [number, number | undefined][] = [];
    const result = await h.svc.install((d, t) => progress.push([d, t]));
    expect(result).toBe("installed");
    expect(update.installs).toBe(1);
    expect(progress).toEqual([[1024, 2048]]);
    expect(h.relaunches).toBe(1);
    expect(h.prefs.get().pendingUpdate).toBeUndefined();
    // 安装路径又做了一次检查（pendingUpdate 里没有安装入口）
    expect(h.checks).toBe(1);
  });

  it("安装失败（含签名校验）：抛错、恢复 pendingUpdate、写外壳日志", async () => {
    const update = fakeUpdate("0.6.0");
    update.failInstall = new Error("signature verification failed");
    const h = harness({
      update,
      prefs: {
        [PREFS_KEY]: JSON.stringify({ pendingUpdate: { version: "0.6.0", notes: null } }),
      },
    });
    await expect(h.svc.install()).rejects.toThrow("signature verification failed");
    expect(h.relaunches).toBe(0);
    expect(h.prefs.get().pendingUpdate?.version).toBe("0.6.0");
    expect(h.notes.some((line) => line.includes("signature verification failed"))).toBe(true);
  });

  it("安装时实际已无更新：返回 gone 且不重启", async () => {
    const h = harness({
      update: null,
      prefs: {
        [PREFS_KEY]: JSON.stringify({ pendingUpdate: { version: "0.6.0", notes: null } }),
      },
    });
    expect(await h.svc.install()).toBe("gone");
    expect(h.relaunches).toBe(0);
    expect(h.prefs.get().pendingUpdate).toBeUndefined();
  });
});
