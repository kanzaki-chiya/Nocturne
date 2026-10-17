import { describe, expect, it } from "vitest";

import { createPrefsStore, migrateLegacyProjectOrder, PREFS_KEY } from "../src/prefs";

function memoryStorage(initial?: Record<string, string>): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
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

describe("prefs store", () => {
  it("读写往返", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    store.update({ pinned: ["s1"], projects: ["Z:\\a"] });
    const store2 = createPrefsStore(storage);
    expect(store2.get()).toEqual({
      pinned: ["s1"],
      projects: ["Z:\\a"],
      hidden: [],
      projectSort: "manual",
      plainWorkspaces: [],
      fileOpenerMigrated: true,
    });
    expect(store2.persistent).toBe(true);
  });

  it("损坏 JSON 回退默认", () => {
    const store = createPrefsStore(memoryStorage({ [PREFS_KEY]: "{oops" }));
    expect(store.get()).toEqual({
      pinned: [],
      projects: [],
      hidden: [],
      projectSort: "manual",
      plainWorkspaces: [],
      fileOpenerMigrated: true,
    });
  });

  it("字段类型不对逐字段回退", () => {
    const store = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({
          pinned: "nope",
          projects: ["Z:\\ok"],
          hidden: [1],
        }),
      }),
    );
    expect(store.get()).toEqual({
      pinned: [],
      projects: ["Z:\\ok"],
      hidden: [],
      projectSort: "manual",
      plainWorkspaces: [],
      fileOpenerMigrated: true,
    });
  });

  it("projectSort 读写往返；非法值回退默认", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    store.update({ projectSort: "name" });
    expect(createPrefsStore(storage).get().projectSort).toBe("name");
    const bad = createPrefsStore(
      memoryStorage({ [PREFS_KEY]: JSON.stringify({ projectSort: "size" }) }),
    );
    expect(bad.get().projectSort).toBe("manual");
  });

  it("projectOrder 读写往返；缺字段为 undefined，类型不对回退空数组", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    expect(store.get().projectOrder).toBeUndefined();
    store.update({ projectSort: "activity", projectOrder: ["z:\\b", "z:\\a"] });
    const again = createPrefsStore(storage).get();
    expect(again.projectOrder).toEqual(["z:\\b", "z:\\a"]);
    expect(again.projectSort).toBe("activity");
    for (const bad of ["nope", [1, "x"], null]) {
      const store2 = createPrefsStore(
        memoryStorage({ [PREFS_KEY]: JSON.stringify({ projectOrder: bad }) }),
      );
      expect(store2.get().projectOrder).toEqual([]);
    }
  });

  it("旧数据（无 projectOrder）迁移：activity 改 manual、name 保留，顺序取升级前最近活动顺序", () => {
    const legacy = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({ pinned: [], projects: [], projectSort: "activity" }),
      }),
    ).get();
    expect(legacy.projectSort).toBe("activity");
    expect(migrateLegacyProjectOrder(legacy, ["z:\\b", "z:\\a"])).toEqual({
      projectSort: "manual",
      projectOrder: ["z:\\b", "z:\\a"],
    });
    expect(migrateLegacyProjectOrder({ projectSort: "name" }, ["z:\\a"])).toEqual({
      projectSort: "name",
      projectOrder: ["z:\\a"],
    });
  });

  it("已有 projectOrder 时不迁移，用户选的「最近活动」保留", () => {
    const store = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({ projectSort: "activity", projectOrder: ["z:\\a"] }),
      }),
    );
    const prefs = store.get();
    expect(prefs.projectSort).toBe("activity");
    expect(migrateLegacyProjectOrder(prefs, ["z:\\x"])).toBeNull();
    // 空数组也算已有字段
    expect(migrateLegacyProjectOrder({ projectSort: "activity", projectOrder: [] }, [])).toBeNull();
  });

  it("lastEffort 读写往返；非字符串字段按未设置处理", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    expect(store.get().lastEffort).toBeUndefined();
    store.update({ lastEffort: "high" });
    expect(createPrefsStore(storage).get().lastEffort).toBe("high");
    const bad = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({ lastEffort: 3, pinned: ["s1"] }),
      }),
    );
    expect(bad.get().lastEffort).toBeUndefined();
    expect(bad.get().pinned).toEqual(["s1"]);
  });

  it("旧数据含 lastProject 字段时正常读取（该字段已废弃）", () => {
    const store = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({
          pinned: ["s1"],
          projects: ["Z:\\a"],
          hidden: [],
          lastProject: "Z:\\a",
        }),
      }),
    );
    expect(store.get()).toEqual({
      pinned: ["s1"],
      projects: ["Z:\\a"],
      hidden: [],
      projectSort: "manual",
      plainWorkspaces: [],
      fileOpenerMigrated: true,
    });
  });

  it("theme / plainWorkspace / plainWorkspaces 读写往返；非法值按未设置处理", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    store.update({ theme: "dark", plainWorkspace: "D:\\chat", plainWorkspaces: ["C:\\old"] });
    const reread = createPrefsStore(storage).get();
    expect(reread.theme).toBe("dark");
    expect(reread.plainWorkspace).toBe("D:\\chat");
    expect(reread.plainWorkspaces).toEqual(["C:\\old"]);
    // 改回跟随系统：键被删掉
    store.update({ theme: undefined });
    expect(createPrefsStore(storage).get().theme).toBeUndefined();
    const bad = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({ theme: "sepia", plainWorkspace: "  ", plainWorkspaces: "x" }),
      }),
    );
    expect(bad.get().theme).toBeUndefined();
    expect(bad.get().plainWorkspace).toBeUndefined();
    expect(bad.get().plainWorkspaces).toEqual([]);
  });

  it("getItem 抛错时用默认值", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new Error("denied");
    };
    const store = createPrefsStore(storage);
    expect(store.get().pinned).toEqual([]);
  });

  it("setItem 抛错时内存值仍生效、persistent 为 false", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("denied");
    };
    const store = createPrefsStore(storage);
    store.update({ pinned: ["s1"] });
    expect(store.get().pinned).toEqual(["s1"]);
    expect(store.persistent).toBe(false);
  });

  it("storage 为 undefined 时可用", () => {
    const store = createPrefsStore(undefined);
    store.update({ pinned: ["s1"] });
    expect(store.get().pinned).toEqual(["s1"]);
    expect(store.persistent).toBe(false);
  });

  it("更新相关字段：读写往返、损坏回退、逐字段互不影响", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    store.update({
      autoUpdate: false,
      lastUpdateCheck: 1_700_000_000_000,
      pendingUpdate: { version: "0.6.0", notes: "修好了一些事" },
    });
    const reread = createPrefsStore(storage).get();
    expect(reread.autoUpdate).toBe(false);
    expect(reread.lastUpdateCheck).toBe(1_700_000_000_000);
    expect(reread.pendingUpdate).toEqual({ version: "0.6.0", notes: "修好了一些事" });

    // 损坏字段回退默认；notes 非字符串归一为 null
    const bad = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({
          autoUpdate: "yes",
          lastUpdateCheck: "昨天",
          pendingUpdate: { version: "0.6.0", notes: 42 },
        }),
      }),
    ).get();
    expect(bad.autoUpdate).toBeUndefined();
    expect(bad.lastUpdateCheck).toBeUndefined();
    expect(bad.pendingUpdate).toEqual({ version: "0.6.0", notes: null });
  });

  it("右侧面板：开关、宽度、概览、标签读写往返；损坏的标签逐项丢弃", () => {
    const storage = memoryStorage();
    const store = createPrefsStore(storage);
    store.update({
      panelOpen: true,
      panelWidth: 600,
      overviewOpen: true,
      panelTabs: [
        { id: "c", kind: "changes" },
        {
          id: "f",
          kind: "file",
          workspace: "Z:\\p",
          sessionId: "s1",
          absolutePath: "Z:\\p\\a.ts",
          relativePath: "a.ts",
          line: 3,
        },
      ],
      panelActiveTab: "f",
    });
    const reread = createPrefsStore(storage).get();
    expect(reread.panelOpen).toBe(true);
    expect(reread.panelWidth).toBe(600);
    expect(reread.overviewOpen).toBe(true);
    expect(reread.panelTabs?.map((tab) => tab.id)).toEqual(["c", "f"]);
    expect(reread.panelActiveTab).toBe("f");

    const bad = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({
          panelOpen: "yes",
          panelWidth: "wide",
          panelTabs: [
            { id: "x", kind: "file" },
            { id: "c1", kind: "changes" },
            { id: "c2", kind: "changes" },
            { id: "n", kind: "new" },
          ],
        }),
      }),
    ).get();
    expect(bad.panelOpen).toBeUndefined();
    expect(bad.panelWidth).toBeUndefined();
    // 文件缺字段丢弃；变更只留一个；新标签页不存
    expect(bad.panelTabs).toEqual([{ id: "c1", kind: "changes" }]);
  });

  it("打开文件用：缺省为面板；旧选择一次性迁移到面板，之后改回 VS Code 保留", () => {
    // 升级前存的是 VS Code：没有迁移标记，回到缺省（面板）并写回标记
    const storage = memoryStorage({ [PREFS_KEY]: JSON.stringify({ fileOpener: "vscode" }) });
    const first = createPrefsStore(storage);
    expect(first.get().fileOpener).toBeUndefined();
    expect(first.get().fileOpenerMigrated).toBe(true);
    const saved = JSON.parse(storage.data.get(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    expect(saved.fileOpenerMigrated).toBe(true);
    expect(saved).not.toHaveProperty("fileOpener");
    // 迁移后用户再改回 VS Code：重启（多次）后保留
    first.update({ fileOpener: "vscode" });
    expect(createPrefsStore(storage).get().fileOpener).toBe("vscode");
    expect(createPrefsStore(storage).get().fileOpener).toBe("vscode");
    // system / cursor 同样迁移
    for (const old of ["system", "cursor"]) {
      const legacy = createPrefsStore(
        memoryStorage({ [PREFS_KEY]: JSON.stringify({ fileOpener: old }) }),
      );
      expect(legacy.get().fileOpener).toBeUndefined();
    }
    // 迁移后的非法值按缺省处理
    const bad = createPrefsStore(
      memoryStorage({
        [PREFS_KEY]: JSON.stringify({ fileOpener: "notepad", fileOpenerMigrated: true }),
      }),
    );
    expect(bad.get().fileOpener).toBeUndefined();
  });
});
