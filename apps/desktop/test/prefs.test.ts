import { describe, expect, it } from "vitest";

import { createPrefsStore, PREFS_KEY } from "../src/prefs";

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
      projectSort: "activity",
      plainWorkspaces: [],
    });
    expect(store2.persistent).toBe(true);
  });

  it("损坏 JSON 回退默认", () => {
    const store = createPrefsStore(memoryStorage({ [PREFS_KEY]: "{oops" }));
    expect(store.get()).toEqual({
      pinned: [],
      projects: [],
      hidden: [],
      projectSort: "activity",
      plainWorkspaces: [],
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
      projectSort: "activity",
      plainWorkspaces: [],
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
    expect(bad.get().projectSort).toBe("activity");
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
      projectSort: "activity",
      plainWorkspaces: [],
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
});
