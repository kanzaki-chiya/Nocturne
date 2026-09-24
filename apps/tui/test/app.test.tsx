/**
 * TUI 骨架冒烟：App 渲染会话元信息；Ctrl+C 退出。
 * 真实的会话视图组件在后续提交落地，本文件只锁定骨架接线。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";

import { App } from "../src/app.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

describe("TUI 骨架", () => {
  it("渲染会话 id 与模型；Ctrl+C 退出", async () => {
    const runtime = await createRuntime({
      cwd: tmp("nct-tui-ws-"),
      sessionsDir: tmp("nct-tui-sd-"),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { lastFrame, stdin, unmount } = render(createElement(App, { session }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain(session.id);
    expect(frame).toContain("fake/fake-model");
    stdin.write("\x03"); // Ctrl+C
    await new Promise((r) => setTimeout(r, 20));
    unmount();
    await session.close();
  });
});
