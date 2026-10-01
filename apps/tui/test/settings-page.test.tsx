import { render } from "ink-testing-library";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime, RuntimeSession, SettingItem } from "@nocturne/core";
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
function page(
  options: { width?: number; height?: number; ascii?: boolean; failure?: boolean } = {},
) {
  const items: SettingItem[] = [
    {
      key: "permissions.preset",
      effective: "read-only",
      saved: "default",
      source: "user",
      overridden: true,
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
  ];
  const update = vi.fn(async () => {
    if (options.failure) throw new Error("disk failure");
    return items;
  });
  const preference = vi.fn(async () => undefined);
  const shell = vi.fn(async () => undefined);
  const close = vi.fn();
  const preview = vi.fn();
  const runtime = {
    describeSettings: () => items,
    updateSettings: update,
    setPreference: preference,
    getPreference: () => undefined,
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
          height: options.height ?? 24,
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
    await waitFor(() => (screen.lastFrame() ?? "").includes("/settings 设置"));
    await pause();
  };
  const input = async (value: string) => {
    screen.stdin.write(value);
    await pause();
  };
  return { ...screen, ready, input, update, preference, shell, close, preview, mouse: () => mouse };
}

describe("ADR-0034 设置页", () => {
  it("分组、来源和覆盖提示；草稿保存不更改会话权限或档位", async () => {
    const screen = page();
    await screen.ready();
    expect(screen.lastFrame()).toContain("已保存，但被 config.json 覆盖");
    expect(screen.lastFrame()).toContain("默认模型与档位 · fake/m · 档位 low");
    expect(screen.lastFrame()).toContain("在 /model 页设置");
    expect(screen.lastFrame()).not.toContain("默认思考档位");
    expect(screen.lastFrame()).toContain("默认值对新会话生效");
    await screen.input("\x1b[C");
    expect(screen.update).not.toHaveBeenCalled();
    await screen.input("\x1b[Z");
    await screen.input("\r");
    await waitFor(() => screen.close.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledWith({ "permissions.preset": "auto-edit" });
    expect(screen.shell).not.toHaveBeenCalled();
    screen.unmount();
  });
  it("主题即时预览，Esc 确认放弃后恢复，取消不写入", async () => {
    const screen = page();
    await screen.ready();
    await screen.input("\t");
    await screen.input("\x1b[C");
    expect(screen.preview).toHaveBeenLastCalledWith("light");
    await screen.input("\x1b");
    await waitFor(() => (screen.lastFrame() ?? "").includes("放弃修改？"));
    await screen.input("\x1b[C");
    await screen.input("\r");
    expect(screen.preview).toHaveBeenLastCalledWith("dark");
    expect(screen.close).toHaveBeenCalledTimes(1);
    expect(screen.update).not.toHaveBeenCalled();
    expect(screen.preference).not.toHaveBeenCalled();
    screen.unmount();
  });
  it("保存失败保留草稿，可继续编辑并重试", async () => {
    const screen = page({ failure: true });
    await screen.ready();
    await screen.input("\x1b[C");
    await screen.input("\x1b[Z");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("保存失败：disk failure"));
    expect(screen.lastFrame()).toContain("* auto-edit");
    expect(screen.close).not.toHaveBeenCalled();
    screen.update.mockResolvedValueOnce([]);
    await screen.input("\r");
    await waitFor(() => screen.close.mock.calls.length === 1);
    screen.unmount();
  });
  it("Enter 进入 /theme 和 shell 选择器，返回后仅保存草稿", async () => {
    const screen = page();
    await screen.ready();
    await screen.input("\t");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("选择主题"));
    await pause();
    await screen.input("\x1b[B");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("/settings 设置"));
    await pause();
    expect(screen.preview).toHaveBeenLastCalledWith("light");
    await screen.input("\t");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("选择 shell"));
    await pause();
    await screen.input("\x1b[B");
    await screen.input("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("Shell · bash"));
    await pause();
    expect(screen.shell).not.toHaveBeenCalled();
    expect(screen.preference).not.toHaveBeenCalled();
    await screen.input("\t");
    await screen.input("\t");
    await screen.input("\r");
    await waitFor(() => screen.close.mock.calls.length === 1);
    expect(screen.shell).toHaveBeenCalledWith("bash");
    expect(screen.preference).toHaveBeenCalledWith("theme", "light");
    expect(screen.update).not.toHaveBeenCalled();
    screen.unmount();
  });
  it("鼠标分段选择与保存，放弃确认保护未保存草稿", async () => {
    const screen = page();
    await screen.ready();
    const click = (id: string) =>
      screen.mouse()?.click(id, { type: "click", row: 1, col: 1, button: 0 } as never);
    expect(screen.mouse()?.boxes.some((box) => box.id === "preset:4")).toBe(true);
    click("preset:4");
    // 等草稿渲染出来再点取消：取消按「是否有未保存修改」决定是否弹放弃确认
    await waitFor(() => (screen.lastFrame() ?? "").includes("* guarded"));
    await pause();
    click("cancel");
    // 每次换层后稍等：鼠标帧先于新层的回调就绪上报，立刻点击会落在旧闭包上
    await waitFor(() => screen.mouse()?.layer === "settings-discard");
    await pause();
    click("continue");
    await waitFor(() => screen.mouse()?.layer === "settings");
    await pause();
    click("save");
    await waitFor(() => screen.close.mock.calls.length === 1);
    expect(screen.update).toHaveBeenCalledWith({ "permissions.preset": "guarded" });
    screen.unmount();
  });
  it("窄屏与 ASCII/NO_COLOR 布局保留页框、焦点和保存按钮", async () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(detectTuiEnv().animated).toBe(false);
    const screen = page({ width: 36, height: 15, ascii: true });
    await screen.ready();
    expect(screen.lastFrame()).toContain("+");
    expect(screen.lastFrame()).toContain("< default > / 共 5 项");
    await screen.input("\x1b[Z");
    expect(screen.lastFrame()).toContain("保存");
    expect(screen.lastFrame()?.split("\n").length).toBe(15);
    expect(screen.mouse()?.boxes.every((box) => box.row > 2 && box.row < 15)).toBe(true);
    screen.unmount();
  });
});
