/**
 * 设置 › 浏览器（ADR-0078）：「模型操作网页」开关、风险确认与「重启应用」。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserSettingsPage,
  formatSize,
  type BrowsingDataHost,
  type DownloadsHost,
} from "../src/BrowserSettingsPage";
import type { AgentBrowserHost, AgentBrowserStatus } from "../src/host";
import { createPrefsStore, PREFS_KEY } from "../src/prefs";

afterEach(cleanup);

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** 外壳的判定由 Rust 单测覆盖；这里按给定的回包驱动界面 */
function agentHost(
  replies: AgentBrowserStatus[] = [],
  status: AgentBrowserStatus = { enabled: false, restartRequired: false },
): AgentBrowserHost & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    watch: vi.fn(async () => ({ shellGeneration: 0, revision: 0, enabled: false, tabs: [] })),
    uiState: vi.fn(async () => undefined),
    presented: vi.fn(async () => undefined),
    control: vi.fn(async () => ({ revision: 0 })),
    dialog: vi.fn(async () => undefined),
    setEnabled: vi.fn(async (next: boolean) => {
      calls.push(next);
      return replies.shift() ?? { enabled: next, restartRequired: false };
    }),
    status: vi.fn(async () => status),
  };
}

function mount(host: AgentBrowserHost | undefined, storage = memory(), downloads?: DownloadsHost) {
  const prefs = createPrefsStore(storage);
  const relaunch = vi.fn(async () => undefined);
  render(
    <BrowserSettingsPage
      prefs={prefs}
      agentBrowser={host}
      downloads={downloads}
      relaunch={relaunch}
      version={1}
    />,
  );
  return { prefs, storage, relaunch };
}

const agentSwitch = () => screen.getByRole("switch", { name: "模型操作网页" });

describe("Agent 浏览器", () => {
  it("页面只有标题、分组名与行名，没有副标题或说明", () => {
    mount(agentHost());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("浏览器");
    const group = screen.getByRole("region", { name: "Agent 浏览器" });
    expect(within(group).getByRole("group", { name: "模型操作网页" })).toBeTruthy();
    expect(group.querySelector(".desc")).toBeNull();
    expect(screen.queryByText(/网站权限/)).toBeNull();
  });

  it("第一次启用先内联确认，取消就不启用", () => {
    const host = agentHost();
    const { prefs } = mount(host);
    expect(agentSwitch().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(agentSwitch());
    const dialog = screen.getByRole("alertdialog", { name: "启用模型操作网页" });
    expect(within(dialog).getByText("网页内容不可信，可能诱导它操作其他页面。")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "仍然启用" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(host.calls).toEqual([]);
    expect(prefs.get().agentBrowserEnabled).toBeUndefined();
    expect(prefs.get().agentBrowserRiskAccepted).toBeUndefined();
  });

  it("确认后启用并沿用旧存储字段；外壳说要重启时开关左边出现「重启应用」", async () => {
    const host = agentHost([{ enabled: true, restartRequired: true }]);
    const { prefs, storage, relaunch } = mount(host);
    fireEvent.click(agentSwitch());
    fireEvent.click(screen.getByRole("button", { name: "仍然启用" }));
    const restart = await screen.findByRole("button", { name: "重启应用" });
    expect(agentSwitch().getAttribute("aria-checked")).toBe("true");
    // 按钮在开关左边：同一个控件区里排在开关前面
    expect(
      restart.compareDocumentPosition(agentSwitch()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(prefs.get().agentBrowserEnabled).toBe(true);
    expect(prefs.get().agentBrowserRiskAccepted).toBe(true);
    expect(storage.getItem(PREFS_KEY)).toContain('"agentBrowserEnabled":true');
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(restart);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("切回运行中后台的状态后按钮消失；再改又出现", async () => {
    const storage = memory();
    storage.setItem(
      PREFS_KEY,
      JSON.stringify({ agentBrowserEnabled: true, agentBrowserRiskAccepted: true }),
    );
    const host = agentHost([
      { enabled: false, restartRequired: true },
      { enabled: true, restartRequired: false },
    ]);
    mount(host, storage);
    // 旧配置继续生效：已开、看过风险提示，不再弹确认
    expect(agentSwitch().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(agentSwitch());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await screen.findByRole("button", { name: "重启应用" });
    fireEvent.click(agentSwitch());
    await waitFor(() => expect(screen.queryByRole("button", { name: "重启应用" })).toBeNull());
    expect(host.calls).toEqual([false, true]);
  });

  it("进入页面按外壳状态还原「重启应用」（页面重载后）", async () => {
    mount(agentHost([], { enabled: true, restartRequired: true }));
    expect(await screen.findByRole("button", { name: "重启应用" })).toBeTruthy();
  });

  it("外壳报错写在行内，开关不变", async () => {
    const host = agentHost();
    host.setEnabled = vi.fn(async () => {
      throw new Error("无法取得启动凭证的随机数");
    });
    const storage = memory();
    storage.setItem(PREFS_KEY, JSON.stringify({ agentBrowserRiskAccepted: true }));
    mount(host, storage);
    fireEvent.click(agentSwitch());
    expect((await screen.findByRole("alert")).textContent).toBe("无法取得启动凭证的随机数");
    expect(agentSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("没有外壳时不显示这一组", () => {
    mount(undefined);
    expect(screen.queryByRole("region", { name: "Agent 浏览器" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "模型操作网页" })).toBeNull();
  });
});

describe("打开方式", () => {
  it("网页链接与本地网址缺省系统浏览器；选面板才写入，选回系统浏览器清掉字段", () => {
    const { prefs, storage } = mount(undefined);
    const group = screen.getByRole("region", { name: "打开方式" });
    const web = within(group).getByRole("combobox", { name: "网页链接" });
    const local = within(group).getByRole("combobox", { name: "本地网址" });
    expect(web.textContent).toContain("系统浏览器");
    expect(local.textContent).toContain("系统浏览器");
    expect(storage.getItem(PREFS_KEY) ?? "").not.toMatch(/LinkOpener/);

    fireEvent.click(local);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      expect.stringContaining("系统浏览器"),
      expect.stringContaining("Nocturne 面板"),
    ]);
    fireEvent.click(screen.getByRole("option", { name: /Nocturne 面板/ }));
    expect(local.textContent).toContain("Nocturne 面板");
    expect(prefs.get().localLinkOpener).toBe("panel");
    expect(prefs.get().webLinkOpener).toBeUndefined();
    expect(storage.getItem(PREFS_KEY)).toContain('"localLinkOpener":"panel"');

    fireEvent.click(local);
    fireEvent.click(screen.getByRole("option", { name: /系统浏览器/ }));
    expect(prefs.get().localLinkOpener).toBeUndefined();
    expect(storage.getItem(PREFS_KEY)).not.toContain("localLinkOpener");
  });

  it("存过的选择重新进入页面时还原", () => {
    const storage = memory();
    storage.setItem(PREFS_KEY, JSON.stringify({ webLinkOpener: "panel" }));
    mount(undefined, storage);
    expect(screen.getByRole("combobox", { name: "网页链接" }).textContent).toContain(
      "Nocturne 面板",
    );
    expect(screen.getByRole("combobox", { name: "本地网址" }).textContent).toContain("系统浏览器");
  });
});

describe("浏览数据", () => {
  function dataHost(after = { user: 9 * 1024, agent: 2048 }) {
    const host: BrowsingDataHost & { cleared: string[] } = {
      cleared: [],
      sizes: vi.fn(async () => ({ user: 184 * 1024 * 1024, agent: 62 * 1024 * 1024 })),
      clear: vi.fn(async (which: "user" | "agent") => {
        host.cleared.push(which);
        return after[which];
      }),
    };
    return host;
  }
  function mountData(host: BrowsingDataHost, version = 1) {
    const prefs = createPrefsStore(memory());
    const relaunch = vi.fn(async () => undefined);
    const ui = (v: number) => (
      <BrowserSettingsPage prefs={prefs} browsingData={host} relaunch={relaunch} version={v} />
    );
    const view = render(ui(version));
    return { rerender: (v: number) => view.rerender(ui(v)) };
  }
  const row = (name: string) => screen.getByRole("group", { name });

  it("formatSize", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("2 KB");
    expect(formatSize(184 * 1024 * 1024)).toBe("184 MB");
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("进入页面显示两份大小，再次进入时刷新", async () => {
    const host = dataHost();
    const view = mountData(host);
    expect(await within(row("我的浏览")).findByText("184 MB")).toBeTruthy();
    expect(within(row("Agent 浏览")).getByText("62 MB")).toBeTruthy();
    expect(host.sizes).toHaveBeenCalledTimes(1);
    view.rerender(2);
    await waitFor(() => {
      expect(host.sizes).toHaveBeenCalledTimes(2);
    });
  });

  it("「清除…」展开内联确认；取消不清；确认后显示外壳给的实际大小", async () => {
    const host = dataHost();
    mountData(host);
    await screen.findByText("184 MB");
    fireEvent.click(within(row("我的浏览")).getByRole("button", { name: "清除…" }));
    const dialog = screen.getByRole("alertdialog", { name: "清除我的浏览数据" });
    expect(dialog.textContent).toContain("面板里登录过的网站都要重新登录。");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(host.cleared).toEqual([]);

    fireEvent.click(within(row("Agent 浏览")).getByRole("button", { name: "清除…" }));
    const agent = screen.getByRole("alertdialog", { name: "清除 Agent 浏览数据" });
    expect(agent.textContent).toContain("Agent 登录过的网站都要重新登录。");
    fireEvent.click(within(agent).getByRole("button", { name: "清除" }));
    expect(await within(row("Agent 浏览")).findByText("2 KB")).toBeTruthy();
    expect(within(row("我的浏览")).getByText("184 MB")).toBeTruthy();
    expect(host.cleared).toEqual(["agent"]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("清除失败写在那一行", async () => {
    const host = dataHost();
    host.clear = vi.fn(async () => {
      throw new Error("清除浏览数据超时");
    });
    mountData(host);
    await screen.findByText("184 MB");
    fireEvent.click(within(row("我的浏览")).getByRole("button", { name: "清除…" }));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect((await within(row("我的浏览")).findByRole("alert")).textContent).toBe(
      "清除浏览数据超时",
    );
    expect(within(row("Agent 浏览")).queryByRole("alert")).toBeNull();
  });

  it("没有内置浏览器时不显示这一组", () => {
    mount(undefined);
    expect(screen.queryByRole("region", { name: "浏览数据" })).toBeNull();
  });
});

describe("分组顺序与文字", () => {
  it("按效果图：Agent 浏览器、打开方式、浏览数据、下载；没有网站权限", () => {
    const prefs = createPrefsStore(memory());
    render(
      <BrowserSettingsPage
        prefs={prefs}
        agentBrowser={agentHost()}
        browsingData={{ sizes: async () => ({ user: 0, agent: 0 }), clear: async () => 0 }}
        downloads={{ set: async () => ({ defaultDir: null }), pickFolder: async () => null }}
        relaunch={async () => undefined}
        version={1}
      />,
    );
    const titles = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(titles).toEqual(["浏览器", "Agent 浏览器", "打开方式", "浏览数据", "下载"]);
    expect(document.querySelector(".desc")).toBeNull();
    expect(screen.queryByText(/网站权限|允许|拒绝/)).toBeNull();
  });
});

describe("下载", () => {
  function downloadsHost(picked: string | null = "D:\\dl") {
    const sets: [boolean, string | null][] = [];
    const host: DownloadsHost = {
      set: vi.fn(async (ask: boolean, dir: string | null) => {
        sets.push([ask, dir]);
        return { defaultDir: "C:\\Users\\me\\Downloads" };
      }),
      pickFolder: vi.fn(async () => picked),
    };
    return { host, sets };
  }

  it("缺省每次询问、显示系统「下载」文件夹，不写 prefs；进入页面同步一次", async () => {
    const { host, sets } = downloadsHost();
    const { storage } = mount(undefined, memory(), host);
    const group = screen.getByRole("region", { name: "下载" });
    const ask = within(group).getByRole("switch", { name: "每次询问保存位置" });
    expect(ask.getAttribute("aria-checked")).toBe("true");
    expect(await within(group).findByText("C:\\Users\\me\\Downloads")).toBeTruthy();
    expect(sets).toEqual([[true, null]]);
    expect(storage.getItem(PREFS_KEY) ?? "").not.toMatch(/download/);
    expect(group.querySelector(".desc")).toBeNull();
  });

  it("关掉询问、更改保存位置：写 prefs 并同步外壳；打开询问时清掉字段", async () => {
    const { host, sets } = downloadsHost();
    const { prefs } = mount(undefined, memory(), host);
    const ask = screen.getByRole("switch", { name: "每次询问保存位置" });
    fireEvent.click(ask);
    expect(prefs.get().downloadAsk).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "更改…" }));
    expect(await screen.findByText("D:\\dl")).toBeTruthy();
    expect(prefs.get().downloadDir).toBe("D:\\dl");
    fireEvent.click(ask);
    expect(prefs.get().downloadAsk).toBeUndefined();
    await waitFor(() => {
      expect(sets).toEqual([
        [true, null],
        [false, null],
        [false, "D:\\dl"],
        [true, "D:\\dl"],
      ]);
    });
  });

  it("选目录时取消不改；外壳报错写在行内", async () => {
    const { host } = downloadsHost(null);
    const { prefs } = mount(undefined, memory(), host);
    fireEvent.click(screen.getByRole("button", { name: "更改…" }));
    await waitFor(() => {
      expect(host.pickFolder).toHaveBeenCalled();
    });
    expect(prefs.get().downloadDir).toBeUndefined();
    cleanup();
    host.set = vi.fn(async () => {
      throw new Error("同步失败");
    });
    mount(undefined, memory(), host);
    fireEvent.click(screen.getByRole("switch", { name: "每次询问保存位置" }));
    expect((await screen.findByRole("alert")).textContent).toBe("同步失败");
  });

  it("没有内置浏览器时不显示这一组", () => {
    mount(undefined);
    expect(screen.queryByRole("region", { name: "下载" })).toBeNull();
  });

  it("存过的设置重新进入页面时还原", async () => {
    const storage = memory();
    storage.setItem(PREFS_KEY, JSON.stringify({ downloadAsk: false, downloadDir: "E:\\x" }));
    const { host, sets } = downloadsHost();
    mount(undefined, storage, host);
    expect(
      screen.getByRole("switch", { name: "每次询问保存位置" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("E:\\x")).toBeTruthy();
    await waitFor(() => {
      expect(sets).toEqual([[false, "E:\\x"]]);
    });
  });
});
