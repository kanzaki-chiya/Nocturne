import { render } from "ink-testing-library";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultJevReviewer,
  type Runtime,
  type RuntimeSession,
  type SettingItem,
  type SettingsPatch,
  type ProviderOverview,
} from "@nocturne/core";
import { SettingsPage } from "../src/components/settings-page.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { detectTuiEnv, TuiEnvContext } from "../src/env.js";
import { ThemeContext, palettes, type ThemeId } from "../src/theme.js";

const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(() => {
  vi.unstubAllEnvs();
});
async function waitFor(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 4000, interval: 20 });
}
async function changedFrame(screen: ReturnType<typeof page>, action: () => void) {
  const before = screen.lastFrame();
  action();
  await waitFor(() => screen.lastFrame() !== before);
  // 等提交后的 effect 接上新层的输入处理；不依赖固定延时。
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function page(
  options: {
    width?: number;
    height?: number;
    ascii?: boolean;
    failure?: boolean;
    themeFailure?: boolean;
  } = {},
) {
  let items: SettingItem[] = [
    {
      key: "permissions.preset",
      effective: "default",
      saved: "default",
      source: "settings",
      overridden: false,
    },
    {
      key: "defaultModel",
      effective: "fake/m",
      saved: "fake/m",
      source: "settings",
      overridden: false,
      readonly: true,
    },
    {
      key: "reasoningEffort",
      effective: "low",
      saved: "low",
      source: "settings",
      overridden: false,
      readonly: true,
    },
    { key: "shell", effective: "cmd", saved: "cmd", source: "settings", overridden: false },
    {
      key: "modelRoles.task",
      effective: undefined,
      saved: undefined,
      source: "default",
      overridden: false,
    },
  ];
  const update = vi.fn(async (patch: SettingsPatch) => {
    if (options.failure) throw new Error("disk failure");
    items = items.map((entry) => {
      const value = (patch as Record<string, unknown>)[entry.key];
      return value === undefined
        ? entry
        : {
            ...entry,
            saved: value === null ? undefined : String(value),
            effective: value === null ? undefined : String(value),
          };
    });
    if (patch["compaction.threshold"] !== undefined)
      items = [
        ...items,
        {
          key: "compaction.threshold",
          effective: String(patch["compaction.threshold"]),
          saved: String(patch["compaction.threshold"]),
          source: "settings",
          overridden: false,
        },
      ];
    return items;
  });
  const preference = vi.fn(async (name: string) => {
    if (options.themeFailure && name === "theme") throw new Error("pref failure");
    return undefined;
  });
  const shell = vi.fn(async () => undefined);
  const close = vi.fn();
  const preview = vi.fn();
  const runtime = {
    describeSettings: () => items,
    updateSettings: update,
    setPreference: preference,
    getPreference: () => undefined,
    defaultReviewer: async (endpoint: Parameters<Runtime["defaultReviewer"]>[0], url?: string) =>
      defaultJevReviewer(
        endpoint,
        [{ id: "opencode-go", host: "opencode.ai", keySource: "credential" } as ProviderOverview],
        url,
      ),
    listReviewerProviders: async () => [],
    listReviewerModels: async () => ({ models: ["jev-1.13-free"] }),
    listRecentModels: () => [],
    listModels: () => [
      { ref: { provider: "fake", model: "m" }, capabilities: { reasoningEffort: ["low", "high"] } },
    ],
  } as unknown as Runtime;
  const session = {
    shellInfo: () => ({ selected: "cmd" }),
    setShell: shell,
    listShells: () => [
      { kind: "cmd", name: "cmd.exe", available: true },
      { kind: "bash", name: "Bash", available: true },
    ],
  } as unknown as RuntimeSession;
  let mouse: DialogMouseFrame | undefined;
  function Harness() {
    const [theme, setTheme] = useState<ThemeId>("dark");
    return createElement(
      ThemeContext.Provider,
      { value: palettes[theme] },
      createElement(
        TuiEnvContext.Provider,
        { value: { ...detectTuiEnv(), ascii: options.ascii ?? false } },
        createElement(SettingsPage, {
          runtime,
          session,
          width: options.width ?? 110,
          height: options.height ?? 28,
          onClose: close,
          onThemeChange: (id) => {
            preview(id);
            setTheme(id);
          },
          onMouseFrame: (frame) => {
            mouse = frame;
          },
        }),
      ),
    );
  }
  const screen = render(createElement(Harness));
  const ready = async () => {
    await waitFor(() => (screen.lastFrame() ?? "").includes("默认权限预设"));
    await pause();
  };
  // 先等帧变化（不变的按键最多等 300ms），再留时间给新组件订阅 useInput，避免慢机器上丢键
  const settle = async (before: string | undefined) => {
    const deadline = Date.now() + 300;
    while (screen.lastFrame() === before && Date.now() < deadline) await pause(10);
    await pause();
  };
  const input = async (value: string) => {
    const before = screen.lastFrame();
    screen.stdin.write(value);
    await settle(before);
  };
  const down = async (count: number) => {
    for (let i = 0; i < count; i++) await input("\x1b[B");
  };
  const click = async (id: string) => {
    const box = mouse?.boxes.find((entry) => entry.id === id);
    if (!box) throw new Error(`无可点击区域：${id}`);
    const before = screen.lastFrame();
    mouse?.click(id, { type: "release", y: box.row, x: box.colEnd, button: 0 });
    await settle(before);
  };
  return {
    ...screen,
    ready,
    input,
    down,
    click,
    settle,
    update,
    preference,
    shell,
    close,
    preview,
    mouse: () => mouse,
  };
}

const selected = (frame: string | undefined) =>
  (frame ?? "").split("\n").find((l) => l.includes("▌"));

describe("ADR-0045 设置页", () => {
  it("双栏分组、来源、只读行与说明区；没有外框和底部按钮", async () => {
    const screen = page();
    await screen.ready();
    const frame = screen.lastFrame() ?? "";
    expect(frame.split("\n")[0]).toBe("设置");
    expect(frame).toContain("默认值对新会话生效");
    for (const text of [
      "会话默认",
      "界面",
      "执行",
      "模型角色",
      "子代理模型",
      "看图模型",
      "标题模型",
    ])
      expect(frame).toContain(text);
    expect(frame).toMatch(/默认权限预设\s+‹ default ›\s+设置/);
    expect(frame).toMatch(/默认模型与档位\s+fake\/m · low\s+在 \/model 设置/);
    expect(frame).toMatch(/看图模型\s+未设置/);
    expect(frame).toContain("新会话的权限预设");
    expect(frame).toContain("↑↓ 移动  ←→ 修改  Enter 打开  Tab 切换栏  Esc 返回");
    expect(frame).not.toMatch(/╭|\[ 取消 \]|\[ 保存 \]/);
    screen.unmount();
  });

  it("←→ 修改默认权限预设立即写入，每次只传一个字段", async () => {
    const screen = page();
    await screen.ready();
    await screen.input("\x1b[C");
    await waitFor(() => screen.update.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledWith({ "permissions.preset": "auto-edit" });
    await waitFor(() => (screen.lastFrame() ?? "").includes("‹ auto-edit ›"));
    await screen.input("\x1b[D");
    await waitFor(() => screen.update.mock.calls.length === 2);
    expect(screen.update).toHaveBeenLastCalledWith({ "permissions.preset": "default" });
    screen.unmount();
  });

  it("写入失败时值回到原样，错误显示在说明区；Esc 直接返回", async () => {
    const screen = page({ failure: true });
    await screen.ready();
    await screen.input("\x1b[C");
    await waitFor(() => (screen.lastFrame() ?? "").includes("保存失败：disk failure"));
    await waitFor(() => (screen.lastFrame() ?? "").includes("‹ default ›"));
    expect(screen.lastFrame()).not.toContain("‹ auto-edit ›");
    await screen.input("\x1b");
    await waitFor(() => screen.close.mock.calls.length === 1);
    expect(screen.lastFrame()).not.toContain("放弃修改");
    screen.unmount();
  });

  it("主题 ←→ 即时生效并写入偏好；写入失败回退主题", async () => {
    const ok = page();
    await ok.ready();
    await ok.down(3);
    expect(selected(ok.lastFrame())).toContain("主题");
    await ok.input("\x1b[C");
    expect(ok.preview).toHaveBeenLastCalledWith("light");
    await waitFor(() => ok.preference.mock.calls.length === 1);
    expect(ok.preference).toHaveBeenCalledWith("theme", "light");
    expect(ok.update).not.toHaveBeenCalled();
    ok.unmount();
    const bad = page({ themeFailure: true });
    await bad.ready();
    await bad.down(3);
    await bad.input("\x1b[C");
    await waitFor(() => (bad.lastFrame() ?? "").includes("保存失败：pref failure"));
    expect(bad.preview).toHaveBeenLastCalledWith("dark");
    bad.unmount();
  });

  it("压缩阈值：对话框保存即落盘，取消不写", async () => {
    const screen = page();
    await screen.ready();
    await screen.down(5);
    expect(selected(screen.lastFrame())).toContain("压缩阈值");
    await screen.input("\r");
    expect(screen.lastFrame()).toContain("[* 百分比]");
    await changedFrame(screen, () => screen.stdin.write("\x1b[C"));
    expect(screen.lastFrame()).toContain("[* token]");
    await changedFrame(screen, () => screen.stdin.write("\r"));
    await changedFrame(screen, () => screen.stdin.write("\x15"));
    await changedFrame(screen, () => screen.stdin.write("200k"));
    await changedFrame(screen, () => screen.stdin.write("\r"));
    expect(screen.update).not.toHaveBeenCalled();
    await changedFrame(screen, () => screen.stdin.write("\r"));
    await waitFor(() => screen.update.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledExactlyOnceWith({ "compaction.threshold": "200k" });
    await waitFor(() => /压缩阈值\s+200k/.test(screen.lastFrame() ?? ""));
    expect(screen.close).not.toHaveBeenCalled();
    screen.unmount();
  });

  it("压缩阈值保存失败留在对话框；窄屏非法百分比不能保存，取消先确认放弃", async () => {
    const failing = page({ failure: true });
    await failing.ready();
    await failing.down(5);
    await failing.input("\r");
    await changedFrame(failing, () => failing.stdin.write("\t"));
    await changedFrame(failing, () => failing.stdin.write("\t"));
    await changedFrame(failing, () => failing.stdin.write("\t"));
    await changedFrame(failing, () => failing.stdin.write("\r"));
    await waitFor(() => (failing.lastFrame() ?? "").includes("保存失败：disk failure"));
    expect(failing.lastFrame()).toContain("压缩阈值");
    failing.unmount();
    const screen = page({ width: 36, height: 15, ascii: true });
    await screen.ready();
    await screen.down(5);
    await screen.input("\r");
    expect(screen.lastFrame()?.split("\n")).toHaveLength(15);
    await changedFrame(screen, () => screen.stdin.write("\r"));
    await changedFrame(screen, () => screen.stdin.write("\x15"));
    await changedFrame(screen, () => screen.stdin.write("101"));
    await changedFrame(screen, () => screen.stdin.write("\r"));
    await changedFrame(screen, () => screen.stdin.write("\r"));
    expect(screen.lastFrame()).toContain("压缩阈值须为");
    expect(screen.update).not.toHaveBeenCalled();
    await changedFrame(screen, () => screen.stdin.write("\x1b"));
    expect(screen.lastFrame()).toContain("放弃修改？");
    screen.unmount();
  });

  it("审查模型：选定后点保存直接落盘", async () => {
    const screen = page();
    await screen.ready();
    await screen.down(1);
    expect(selected(screen.lastFrame())).toContain("安全审查");
    await screen.input("\r");
    expect(screen.lastFrame()).toContain("后端");
    await screen.input("\x1b[D");
    await screen.input("\r");
    expect(screen.lastFrame()).toContain("安全审查模型");
    await screen.input("\r");
    await screen.input("\r");
    await waitFor(() => screen.update.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledWith({
      "permission.reviewer": { backend: "model", model: { provider: "fake", model: "m" } },
    });
    await waitFor(() => !(screen.lastFrame() ?? "").includes("后端"));
    screen.unmount();
  });

  it("Jev：密钥独立传递，披露确认后一次落盘并记一次披露", async () => {
    const screen = page();
    await screen.ready();
    await screen.click("row:reviewer");
    await screen.click("row:reviewer");
    await screen.click("backend:1");
    expect(screen.lastFrame()).toContain("opencode-go");
    await screen.click("credential");
    await screen.input("\x1b[B");
    await screen.input("\x1b[B");
    await screen.input("\r");
    await screen.input("test-secret");
    expect(screen.lastFrame()).not.toContain("test-secret");
    await screen.click("save");
    expect(screen.lastFrame()).toContain("首次开启 Jev");
    expect(screen.update).not.toHaveBeenCalled();
    await screen.click("save");
    await waitFor(() => screen.update.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledWith(
      {
        "permission.reviewer": {
          backend: "jev",
          endpoint: "opencode-zen",
          model: "jev-1.13-free",
          credential: { stored: true },
          minConfidence: 0.7,
        },
      },
      { reviewerKey: "test-secret" },
    );
    await waitFor(() => screen.preference.mock.calls.length === 1);
    expect(screen.preference).toHaveBeenCalledWith("jevDisclosureAccepted", "yes");
    screen.unmount();
  });

  it("Shell 与模型角色：选定后立即写入，看图以外可清除", async () => {
    const screen = page();
    await screen.ready();
    await screen.down(4);
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("选择 shell"));
    await pause();
    await screen.input("\x1b[B");
    await screen.input("\r");
    await waitFor(() => screen.shell.mock.calls.length === 1);
    expect(screen.shell).toHaveBeenCalledWith("bash");
    await waitFor(() => (screen.lastFrame() ?? "").includes("默认权限预设"));
    await screen.down(2);
    expect(selected(screen.lastFrame())).toContain("子代理模型");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("跟随当前模型"));
    await pause();
    await screen.input("\x1b[B");
    await screen.input("\r");
    await waitFor(() => screen.update.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledWith({ "modelRoles.task": "fake/m" });
    screen.unmount();
  });

  it("Enter 进入主题页，选定后写入偏好并回到设置页", async () => {
    const screen = page();
    await screen.ready();
    await screen.down(3);
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("选择主题"));
    await pause();
    await screen.input("\x1b[B");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("默认权限预设"));
    expect(screen.preview).toHaveBeenLastCalledWith("light");
    expect(screen.preference).toHaveBeenCalledWith("theme", "light");
    screen.unmount();
  });

  it("左栏跳转、打字过滤；鼠标单击选中再单击执行", async () => {
    const screen = page();
    await screen.ready();
    await screen.input("\t");
    await screen.input("\x1b[B");
    await screen.input("\x1b[B");
    await screen.input("\r");
    expect(selected(screen.lastFrame())).toContain("Shell");
    await screen.input("主");
    expect(screen.lastFrame()).toContain("过滤: 主");
    expect(screen.lastFrame()).not.toContain("压缩阈值");
    await screen.input("\x1b");
    expect(screen.lastFrame()).toContain("压缩阈值");
    await screen.click("row:threshold");
    expect(selected(screen.lastFrame())).toContain("压缩阈值");
    await screen.click("row:threshold");
    expect(screen.lastFrame()).toContain("[* 百分比]");
    screen.unmount();
  });

  it("窄屏与 ASCII/NO_COLOR：左栏折叠成分组条，选中标记与文字保留", async () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(detectTuiEnv().animated).toBe(false);
    const screen = page({ width: 60, height: 15, ascii: true });
    await screen.ready();
    const frame = screen.lastFrame() ?? "";
    expect(frame).toContain("< 会话默认 >");
    expect(frame).toContain("> 默认权限预设");
    expect(frame).toContain("< default >");
    expect(frame).not.toMatch(/[▌│─┴‹›]/);
    expect(frame.split("\n").length).toBeLessThanOrEqual(15);
    await screen.input("\t");
    expect(screen.lastFrame()).toContain("< 界面 >");
    screen.unmount();
  });
});
