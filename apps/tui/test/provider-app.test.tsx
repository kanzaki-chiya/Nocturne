import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type RuntimeConfig } from "@nocturne/core";
import { App } from "../src/app.js";
import type { MouseEvent, MouseSource } from "../src/mouse.js";
import { changedFrame, settle } from "./provider-test-utils.js";

const roots: string[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function mount(inline: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-provider-app-"));
  roots.push(root);
  vi.stubEnv("NOCTURNE_HOME", path.join(root, "home"));
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [new FakeProvider({})],
  });
  const config = {
    describeProviders: async () => [
      {
        id: "offline",
        type: "openai-compatible",
        host: "example.test",
        keySource: "credential",
        origin: "setup",
        managed: true,
        overridden: false,
        modelCount: 1,
      },
    ],
  } as unknown as RuntimeConfig;
  const listeners = new Set<(event: MouseEvent) => void>();
  const mouse: MouseSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const ui = render(
    createElement(App, {
      runtime,
      setup: { step: 1 },
      provider: { config, reloadConfig: async () => config, updateProviders: () => undefined },
      env: { ascii: true, animated: false },
      inline,
      mouse,
    }),
  );
  await settle(() => ui.lastFrame()?.includes("offline") === true);
  const emit = (event: MouseEvent) => listeners.forEach((listener) => listener(event));
  const row = () =>
    (ui.lastFrame() ?? "").split("\n").findIndex((line) => line.includes("offline")) + 1;
  const click = () => {
    const point = { button: 0, x: 24, y: row() };
    emit({ type: "press", ...point });
    emit({ type: "release", ...point });
  };
  return { ui, click, listeners, emit, row };
}

it("首次配置的 App 路由列表点击，拖回原处不触发动作", async () => {
  const { ui, click, emit, row } = await mount(false);
  await changedFrame(ui, () => ui.stdin.write("\x1b[B")); // 光标先离开 offline，单击才是"选中"
  await changedFrame(ui, click);
  const before = ui.lastFrame();
  const point = { button: 0, x: 24, y: row() };
  emit({ type: "press", ...point });
  emit({ type: "drag", ...point, x: 4 });
  emit({ type: "drag", ...point });
  emit({ type: "release", ...point });
  await changedFrame(ui, () => ui.stdin.write("\x1b[B"));
  expect(before).not.toContain("[ 换密钥 ]");
  expect(ui.lastFrame()).not.toContain("[ 换密钥 ]");
  await changedFrame(ui, click);
  await changedFrame(ui, click);
  expect(ui.lastFrame()).toContain("服务商 offline");
  expect(ui.lastFrame()).toContain("第 1 步，共 2 步");
});

it("首次配置 inline 的 App 不订阅鼠标，键盘照常打开同一对话框", async () => {
  const { ui, listeners } = await mount(true);
  expect(listeners.size).toBe(0);
  await changedFrame(ui, () => ui.stdin.write("offline"));
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("服务商 offline");
  expect(ui.lastFrame()).toContain("[ 换密钥 ]");
});
