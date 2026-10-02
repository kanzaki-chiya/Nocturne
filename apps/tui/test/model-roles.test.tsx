import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type ModelRole,
} from "@nocturne/core";
import { SettingsPage } from "../src/components/settings-page.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { App } from "../src/app.js";

let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nct-role-ui-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await Promise.all([mkdir(home), mkdir(workspace)]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function setup(roles: Partial<Record<ModelRole, string>> = {}) {
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ modelRoles: roles }));
  const base = new FakeProvider({}).models()[0];
  if (base === undefined) throw new Error("FakeProvider 缺少默认模型");
  const runtime = await createRuntime({
    cwd: workspace,
    config: await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined }),
    providers: [
      new FakeProvider({
        models: [
          base,
          {
            ...base,
            ref: { provider: "fake", model: "image" },
            capabilities: { ...base.capabilities, imageInput: true },
          },
        ],
        roleHandler: () => [{ type: "text_delta", text: "生成后的会话标题" }],
        scripts: [[{ type: "text_delta", text: "完成" }]],
      }),
    ],
  });
  return { runtime, session: await runtime.createSession({ model: "fake/fake-1" }) };
}
async function changed(screen: ReturnType<typeof render>, action: () => void) {
  const before = screen.lastFrame();
  action();
  await vi.waitFor(() => expect(screen.lastFrame()).not.toBe(before), {
    timeout: 5000,
    interval: 20,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function page(roles: Partial<Record<ModelRole, string>> = {}) {
  const { runtime, session } = await setup(roles);
  let mouse: DialogMouseFrame | undefined;
  const close = vi.fn();
  const screen = render(
    createElement(SettingsPage, {
      runtime,
      session,
      width: 110,
      height: 24,
      onClose: close,
      onMouseFrame: (frame) => {
        mouse = frame;
      },
    }),
  );
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("模型角色"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const click = (id: string) => {
    const frame = mouse;
    const hit = frame?.boxes.find((box) => box.id === id);
    if (!hit || !frame) throw new Error(`找不到设置行 ${id}`);
    frame.click(id, { type: "release", button: 0, x: hit.colStart, y: hit.row });
  };
  return { runtime, session, screen, click, close };
}
it("模型角色三行默认显示，选择草稿并保存落盘；vision 只列能看图的模型", async () => {
  const { runtime, session, screen, click, close } = await page();
  expect(screen.lastFrame()).toContain("子代理模型：跟随当前模型");
  expect(screen.lastFrame()).toContain("看图模型：未设置");
  expect(screen.lastFrame()).toContain("标题模型：跟随当前模型");
  for (const role of ["task", "vision", "smol"] as const) {
    await changed(screen, () => click(role));
    expect(screen.lastFrame()).toContain(role === "vision" ? "不使用" : "跟随当前模型");
    if (role === "vision") expect(screen.lastFrame()).not.toContain("fake/fake-1");
    await changed(screen, () => screen.stdin.write("\x1b[B"));
    await changed(screen, () => screen.stdin.write("\r"));
    expect(runtime.describeModelRoles().find((r) => r.role === role)?.configured).toBeUndefined();
  }
  expect(JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")).modelRoles).toEqual(
    {},
  );
  click("save");
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")).modelRoles).toEqual({
    task: "fake/fake-1",
    vision: "fake/image",
    smol: "fake/fake-1",
  });
  screen.unmount();
  await session.close();
});
it("选择列表顶部清除三个角色，保存前不写盘", async () => {
  const { runtime, session, screen, click, close } = await page({
    task: "fake/fake-1",
    vision: "fake/image",
    smol: "fake/fake-1",
  });
  for (const role of ["task", "vision", "smol"] as const) {
    await changed(screen, () => click(role));
    await changed(screen, () => screen.stdin.write("\r"));
    expect(runtime.describeModelRoles().find((r) => r.role === role)?.configured).toBeDefined();
  }
  expect(screen.lastFrame()).toContain("看图模型：未设置");
  click("save");
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(
    JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")).modelRoles ?? {},
  ).toEqual({});
  screen.unmount();
  await session.close();
});
it("保存前提示不能看图的 vision 配置，不写盘", async () => {
  const { session, screen, click, close } = await page({ vision: "fake/fake-1" });
  click("save");
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("看图模型必须支持图片"));
  expect(close).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")).modelRoles).toEqual({
    vision: "fake/fake-1",
  });
  screen.unmount();
  await session.close();
});
it("生成标题进入输入框与 /resume 列表", async () => {
  const { runtime, session } = await setup();
  await session.submit({ text: "首条原文\n正文" });
  await vi.waitFor(() =>
    expect(session.session.durableEvents().some((e) => e.type === "session.titled")).toBe(true),
  );
  await session.close();
  const resumed = await runtime.resumeSession(session.id);
  const screen = render(
    createElement(App, {
      session: resumed,
      runtime,
      env: { ascii: false, animated: false },
      switchSession: async (id) => {
        await resumed.close();
        return { kind: "ok", session: await runtime.resumeSession(id) };
      },
    }),
  );
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("生成后的会话标题"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await changed(screen, () => screen.stdin.write("/resume"));
  await changed(screen, () => screen.stdin.write("\r"));
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("切换到会话（当前目录）"));
  expect(screen.lastFrame()).toContain("生成后的会话标题");
  screen.unmount();
  await resumed.close();
});
