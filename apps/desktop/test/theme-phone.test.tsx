import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import type { PhoneConnectionOptions } from "../src/web/connection";
import { fakeServer, withInit } from "./fake-server";
import {
  loadCachedTheme,
  loadThemePreset,
  saveThemePreset,
  selectThemeHost,
} from "../src/web/local";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});
it("手机有缓存时首次应用纸面而不经过工作台，连接后以电脑预设覆盖并写回缓存", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "cached",
    hostPub: "pub",
    name: "缓存电脑",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  saveThemePreset("cached", "paper");
  selectThemeHost("cached");
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": [{ key: "appearance.themePreset", effective: "celadon" }],
      "runtime.listSessions": [],
    }),
  );
  await server.initialize();
  let options: PhoneConnectionOptions | undefined;
  const theme = vi.fn();
  const view = render(
    <PhoneApp
      storage={storage}
      platform={{
        relay: "link",
        observer: { theme },
        createConnection: (value) => {
          options = value;
          return {
            state: "connecting",
            message: "",
            sessionsDir: undefined,
            start: vi.fn(),
            stop: vi.fn(),
            visibility: vi.fn(),
          };
        },
      }}
    />,
  );
  try {
    expect(theme.mock.calls[0]).toEqual(["light", "#fbfaf6"]);
    await waitFor(() => expect(options).toBeDefined());
    expect(theme.mock.calls.every(([, background]) => background === "#fbfaf6")).toBe(true);
    await act(async () => {
      await options?.connected(server.client);
    });
    await waitFor(() => expect(theme).toHaveBeenLastCalledWith("light", "#fbfdfd"));
    expect(loadThemePreset("cached")).toBe("celadon");
    view.unmount();
    const restarted = vi.fn();
    render(
      <PhoneApp
        storage={storage}
        platform={{
          relay: "link",
          observer: { theme: restarted },
          createConnection: () => ({
            state: "connecting",
            message: "",
            sessionsDir: undefined,
            start: vi.fn(),
            stop: vi.fn(),
            visibility: vi.fn(),
          }),
        }}
      />,
    );
    expect(restarted.mock.calls[0]).toEqual(["light", "#fbfdfd"]);
  } finally {
    server.close();
  }
});

it("切换电脑先应用各自缓存，只有未缓存电脑使用工作台", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const storage = memoryStorage();
  for (const id of ["first", "second", "third"])
    await storage.putHost({
      hostId: id,
      hostPub: "pub",
      name: id,
      pairedAt: 1,
      origin: "https://relay.example",
    });
  saveThemePreset("first", "paper");
  saveThemePreset("second", "ink");
  selectThemeHost("first");
  const theme = vi.fn();
  render(
    <PhoneApp
      storage={storage}
      platform={{
        relay: "link",
        observer: { theme },
        createConnection: () => ({
          state: "connecting",
          message: "",
          sessionsDir: undefined,
          start: vi.fn(),
          stop: vi.fn(),
          visibility: vi.fn(),
        }),
      }}
    />,
  );
  await screen.findByRole("button", { name: "切换电脑" });
  theme.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "切换电脑" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /^second/ }));
  expect(theme.mock.calls).toEqual([["light", "#ffffff"]]);
  expect(loadThemePreset()).toBe("ink");
  theme.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "切换电脑" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /^first/ }));
  expect(theme.mock.calls).toEqual([["light", "#fbfaf6"]]);
  theme.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "切换电脑" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /^third/ }));
  expect(theme.mock.calls).toEqual([["light", expect.any(String)]]);
  expect(loadThemePreset()).toBe("workbench");
});

it("手机按电脑预设配色、保留本机模式并向安卓观察者传背景，实时同步", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "desktop",
    hostPub: "pub",
    name: "电脑",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  let preset = "paper";
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => [{ key: "appearance.themePreset", effective: preset }],
      "runtime.listSessions": [],
    }),
  );
  await server.initialize();
  let options: PhoneConnectionOptions | undefined;
  const theme = vi.fn();
  render(
    <PhoneApp
      storage={storage}
      platform={{
        relay: "link",
        observer: { theme },
        createConnection: (value) => {
          options = value;
          return {
            state: "online",
            message: "",
            sessionsDir: undefined,
            start: vi.fn(),
            stop: vi.fn(),
            visibility: vi.fn(),
          };
        },
      }}
    />,
  );
  try {
    await waitFor(() => expect(options).toBeDefined());
    await act(async () => {
      await options?.connected(server.client);
    });
    await waitFor(() => expect(theme).toHaveBeenLastCalledWith("light", "#fbfaf6"));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("radio", { name: "月之暗面" }));
    expect(theme).toHaveBeenLastCalledWith("dark", "#171512");
    preset = "celadon";
    await act(async () => {
      server.notify("runtime.settingsChanged", {});
    });
    await waitFor(() => expect(theme).toHaveBeenLastCalledWith("dark", "#0a1213"));
    expect(document.documentElement.style.getPropertyValue("--sans")).toBe("");
    expect(document.documentElement.dataset.contentWidth).toBeUndefined();
    expect(screen.queryByText("内容宽度")).toBeNull();
  } finally {
    server.close();
  }
});

it("手机缓存与同步自定义三色：首帧先缓存、切换电脑防旧连接迟到、同 id 改色实时更新并通知安卓观察者", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const fog = { id: "c-fog", name: "雾蓝", bg: "#f6f8fa", text: "#16202a", accent: "#2f6db5" };
  const moss = { id: "c-moss", name: "苔绿", bg: "#11140f", text: "#e5eadf", accent: "#a3c98a" };
  const mossEdited = { ...moss, bg: "#141812" };

  const storage = memoryStorage();
  await storage.putHost({
    hostId: "first",
    hostPub: "pub",
    name: "first",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  await storage.putHost({
    hostId: "second",
    hostPub: "pub",
    name: "second",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  saveThemePreset("first", "c-fog", [fog]);
  saveThemePreset("second", "paper");
  selectThemeHost("first");

  let resolveFirstSettings: ((value: unknown) => void) | undefined;
  const firstServer = fakeServer(
    withInit({
      "runtime.describeSettings": () =>
        new Promise((resolve) => {
          resolveFirstSettings = resolve;
        }),
      "runtime.listSessions": [],
    }),
  );
  const secondPreset = "c-moss";
  let secondCustom = [moss];
  const secondServer = fakeServer(
    withInit({
      "runtime.describeSettings": () => [
        { key: "appearance.themePreset", effective: secondPreset },
        { key: "appearance.customThemes", effective: JSON.stringify(secondCustom) },
      ],
      "runtime.listSessions": [],
    }),
  );
  await firstServer.initialize();
  await secondServer.initialize();

  const connections = new Map<string, PhoneConnectionOptions>();
  const theme = vi.fn();
  render(
    <PhoneApp
      storage={storage}
      platform={{
        relay: "link",
        observer: { theme },
        createConnection: (value) => {
          connections.set(value.host.hostId, value);
          return {
            state: "online",
            message: "",
            sessionsDir: undefined,
            start: vi.fn(),
            stop: vi.fn(),
            visibility: vi.fn(),
          };
        },
      }}
    />,
  );

  try {
    // 启动首帧先应用 first 的缓存自定义主题（暗面）
    expect(theme.mock.calls[0]).toEqual(["dark", "#121518"]);
    await waitFor(() => expect(connections.has("first")).toBe(true));

    await act(async () => {
      await connections.get("first")?.connected(firstServer.client);
    });

    // 切换到 second：先应用 second 的旧 string 缓存（纸面暗面），并且 first 的迟到响应不能覆盖
    await screen.findByRole("button", { name: "切换电脑" });
    theme.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "切换电脑" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^second/ }));
    expect(theme.mock.calls).toEqual([["dark", "#171512"]]);

    // first 的迟到 describeSettings 响应到达，必须被忽略
    resolveFirstSettings?.([
      { key: "appearance.themePreset", effective: "celadon" },
      { key: "appearance.customThemes", effective: "[]" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadThemePreset("first")).toBe("c-fog");

    // second 连上后同步自定义主题并写回缓存
    await waitFor(() => expect(connections.has("second")).toBe(true));
    await act(async () => {
      await connections.get("second")?.connected(secondServer.client);
    });
    await waitFor(() => expect(theme).toHaveBeenLastCalledWith("dark", "#11140f"));
    expect(loadCachedTheme("second")).toEqual({ id: "c-moss", customTheme: moss });

    // 同 id 修改三色并触发 settingsChanged，立即重新推算并通知安卓观察者
    secondCustom = [mossEdited];
    await act(async () => {
      secondServer.notify("runtime.settingsChanged", {});
    });
    await waitFor(() => expect(theme).toHaveBeenLastCalledWith("dark", "#141812"));
    expect(loadCachedTheme("second")).toEqual({ id: "c-moss", customTheme: mossEdited });

    // 手机设置页仍只包含模式切换，不能编辑自定义主题
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.queryByText(/新建|导入|编辑/)).toBeNull();
  } finally {
    firstServer.close();
    secondServer.close();
  }
});
