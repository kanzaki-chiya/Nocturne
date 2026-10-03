import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";

import { ThemePage } from "../src/components/theme-page.js";
import { TuiEnvContext } from "../src/env.js";
import { ThemeApp } from "../src/index.js";
import { palettes, ThemeContext } from "../src/theme.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nctrn-theme-"));
  roots.push(root);
  return root;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ENV = { ascii: false, animated: false };

async function openTheme(screen: ReturnType<typeof render>): Promise<void> {
  screen.stdin.write("/theme");
  await waitFor(() => (screen.lastFrame() ?? "").includes("/theme"));
  screen.stdin.write("\r");
  await waitFor(() => (screen.lastFrame() ?? "").includes("选择主题"));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("/theme", () => {
  it("预览复用真实条目、diff、权限、状态和 Todo 组件；窄屏上下排列", async () => {
    for (const [width, height, ascii] of [
      [112, 35, false],
      [42, 65, true],
    ] as const) {
      const screen = render(
        createElement(
          ThemeContext.Provider,
          { value: palettes.dark },
          createElement(
            TuiEnvContext.Provider,
            { value: { ascii, animated: false } },
            createElement(ThemePage, {
              width,
              height,
              active: true,
              onSave: vi.fn(async () => undefined),
              onCancel: vi.fn(),
            }),
          ),
        ),
      );
      const first = screen.lastFrame() ?? "";
      expect(first).toContain("Campbell");
      expect(first).toContain("One Half Light");
      expect(first).toContain("主题预览");
      expect(first).toContain("const accent");
      expect(first).toContain("需要确认");
      expect(first).toContain("任务");
      const darkAt = first.indexOf("Campbell");
      const lightAt = first.indexOf("One Half Light");
      if (width < 90) expect(lightAt).toBeGreaterThan(darkAt + 100);
      screen.stdin.write("\x1b[B");
      await waitFor(() => (screen.lastFrame() ?? "").includes(ascii ? "> light" : "› light"));
      screen.unmount();
    }
  }, 15000);

  it("Enter 保存后应用，重开高亮新主题；Esc 不写入", async () => {
    const runtime = await createRuntime({
      cwd: temp(),
      sessionsDir: temp(),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    let saved = "dark";
    vi.spyOn(runtime, "getPreference").mockImplementation(() => saved);
    const write = vi.spyOn(runtime, "setPreference").mockImplementation(async (_key, value) => {
      saved = value ?? "dark";
    });
    const screen = render(createElement(ThemeApp, { session, runtime, env: ENV }));
    await openTheme(screen);
    expect(screen.lastFrame()).toContain("› dark  当前");
    screen.stdin.write("\x1b[B");
    await waitFor(() => (screen.lastFrame() ?? "").includes("› light"));
    screen.stdin.write("\r");
    await waitFor(
      () => write.mock.calls.length === 1 && !(screen.lastFrame() ?? "").includes("选择主题"),
    );
    expect(write).toHaveBeenCalledWith("theme", "light");
    await new Promise((resolve) => setImmediate(resolve));
    screen.stdin.write("x");
    await waitFor(() => (screen.lastFrame() ?? "").includes("› x"));
    screen.unmount();
    const restarted = render(createElement(ThemeApp, { session, runtime, env: ENV }));
    await openTheme(restarted);
    await waitFor(() => (restarted.lastFrame() ?? "").includes("› light  当前"));
    restarted.stdin.write("\x1b[A");
    await waitFor(() => (restarted.lastFrame() ?? "").includes("› dark"));
    restarted.stdin.write("\x1b");
    await waitFor(() => !(restarted.lastFrame() ?? "").includes("选择主题"));
    expect(write).toHaveBeenCalledTimes(1);
    restarted.unmount();
    await session.close();
  }, 20000);

  it("无 RuntimeConfig 时保存失败，停留选择页且当前主题不变", async () => {
    const runtime = await createRuntime({
      cwd: temp(),
      sessionsDir: temp(),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const screen = render(createElement(ThemeApp, { session, runtime, env: ENV }));
    await openTheme(screen);
    screen.stdin.write("\x1b[B");
    await waitFor(() => (screen.lastFrame() ?? "").includes("› light"));
    screen.stdin.write("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("未注入 RuntimeConfig"));
    expect(screen.lastFrame()).toContain("› light");
    screen.stdin.write("\x1b");
    await waitFor(() => !(screen.lastFrame() ?? "").includes("选择主题"));
    await openTheme(screen);
    await waitFor(() => (screen.lastFrame() ?? "").includes("› dark  当前"));
    screen.unmount();
    await session.close();
  }, 20000);

  it("保存出错时不应用预览主题，错误留在选择页", async () => {
    const runtime = await createRuntime({
      cwd: temp(),
      sessionsDir: temp(),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    vi.spyOn(runtime, "getPreference").mockReturnValue("dark");
    const write = vi.spyOn(runtime, "setPreference").mockRejectedValue(new Error("磁盘不可写"));
    const screen = render(createElement(ThemeApp, { session, runtime, env: ENV }));
    await openTheme(screen);
    screen.stdin.write("\x1b[B");
    await waitFor(() => (screen.lastFrame() ?? "").includes("› light"));
    screen.stdin.write("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("保存失败：磁盘不可写"));
    expect(write).toHaveBeenCalledWith("theme", "light");
    expect(screen.lastFrame()).toContain("› light");
    screen.unmount();
    await session.close();
  }, 15000);

  it("非法偏好在首帧回退 dark，NO_COLOR 下选择页仍靠文字识别", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const runtime = await createRuntime({
      cwd: temp(),
      sessionsDir: temp(),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    vi.spyOn(runtime, "getPreference").mockReturnValue("invalid");
    const screen = render(
      createElement(ThemeApp, { session, runtime, env: { ascii: true, animated: false } }),
    );
    await openTheme(screen);
    await waitFor(() => (screen.lastFrame() ?? "").includes("> dark  当前"));
    expect(screen.lastFrame()).toContain("Campbell");
    expect(screen.lastFrame()).toContain("One Half Light");
    screen.unmount();
    await session.close();
  }, 15000);
});
