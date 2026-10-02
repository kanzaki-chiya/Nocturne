import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type RuntimeSession } from "@nocturne/core";
import { App } from "../src/app.js";
import { settle, changedFrame } from "./provider-test-utils.js";
import type { SwitchSessionFn } from "../src/types.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-rewind-ui-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function app(inline = false, pending = false) {
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [new FakeProvider({ scripts: pending ? [[{ type: "wait", ms: 60_000 }]] : [] })],
  });
  let session = await runtime.createSession({ model: "fake/fake-1" });
  await session.session.emit("message.user", {
    messageId: "first",
    content: [{ type: "text", text: "保留这一轮" }],
  });
  await session.session.emit("message.user", {
    messageId: "second",
    content: [{ type: "text", text: "修改这轮\n第二行" }],
    attachments: [
      {
        type: "image",
        file: "missing.png",
        sha256: "a".repeat(64),
        mimeType: "image/png",
        bytes: 1,
        source: "paste",
      },
    ],
  });
  const original = session;
  const switchSession: SwitchSessionFn = async (id) => {
    const next = await runtime.resumeSession(id);
    await session.close();
    session = next;
    return { kind: "ok", session: next };
  };
  const ui = render(
    createElement(App, {
      session,
      runtime,
      env: { ascii: false, animated: false },
      inline,
      switchSession,
    }),
  );
  await settle(() => ui.lastFrame()?.includes("fake-1") === true);
  await pause();
  return { ...ui, original, runtime, current: (): RuntimeSession => session };
}
async function command(ui: Awaited<ReturnType<typeof app>>, text: string) {
  ui.stdin.write(text);
  await pause();
  ui.stdin.write("\r");
}
it.each([false, true])(
  "/rewind 在线回退、文字恢复和图片提示；inline 只追加通知且不重印旧对话 (%s)",
  async (inline) => {
    const ui = await app(inline);
    try {
      const before = ui.frames.length;
      const oldMessageCount = ui.lastFrame()?.match(/保留这一轮/g)?.length ?? 0;
      await command(ui, "/rewind");
      await settle(() => ui.lastFrame()?.includes("轮次列表") === true);
      await changedFrame(ui, () => ui.stdin.write("\r"));
      await changedFrame(ui, () => ui.stdin.write("\t")); // 灰显 both/files，cancel → conversation
      await changedFrame(ui, () => ui.stdin.write("\r"));
      expect(ui.lastFrame()).toContain("> [ 取消 ]");
      await changedFrame(ui, () => ui.stdin.write("\t"));
      ui.stdin.write("\r");
      await settle(() => ui.lastFrame()?.includes("原消息的图片未放回") === true);
      expect(ui.lastFrame()).toContain("修改这轮");
      expect(ui.lastFrame()).toContain("第二行");
      expect(ui.original.state().history.filter((entry) => entry.kind === "user")).toHaveLength(1);
      const newFrames = ui.frames.slice(before).join("\n");
      expect(newFrames).toContain("已回退到「修改这轮」之前 • 还原 0 个文件");
      // Ink debug 帧包含已写入的 Static；只比较关闭列表后的回滚区。
      if (inline) {
        expect(ui.lastFrame()?.match(/保留这一轮/g)?.length).toBe(oldMessageCount);
        expect(ui.lastFrame()?.match(/已回退到「修改这轮」之前/g)).toHaveLength(1);
      }
      ui.stdin.write("\x7f");
      await settle(() => ui.lastFrame()?.includes("原消息的图片未放回") === false);
    } finally {
      ui.unmount();
      await ui.current().close();
    }
  },
);
it("双 Esc 600ms 内打开，超时或输入非空不打开，关闭页不触发第二次回退", async () => {
  const ui = await app();
  try {
    ui.stdin.write("\x1b");
    await pause(1000); // 首个 Esc 可能晚到一帧（Ink 帧延迟 140–290ms），留足余量
    ui.stdin.write("\x1b");
    await pause();
    expect(ui.lastFrame()).not.toContain("轮次列表");
    ui.stdin.write("\x1b");
    await settle(() => ui.lastFrame()?.includes("轮次列表") === true);
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    await pause();
    ui.stdin.write("草稿");
    await pause();
    ui.stdin.write("\x1b");
    await pause();
    ui.stdin.write("\x1b");
    await pause();
    expect(ui.lastFrame()).not.toContain("轮次列表");
    expect(ui.lastFrame()).toContain("草稿");
  } finally {
    ui.unmount();
    await ui.current().close();
  }
});
it("Turn 进行中双 Esc 中断且不打开列表，Core 拒绝回退", async () => {
  const ui = await app(false, true);
  try {
    const turn = ui.original.submit({ text: "正在执行" });
    await settle(() => ui.original.state().openTurn !== undefined);
    const target = ui.original.session
      .durableEvents()
      .find((event) => event.type === "message.user");
    await expect(ui.original.rewind(target?.seq ?? 0, "conversation")).rejects.toMatchObject({
      code: "session_busy",
    });
    ui.stdin.write("\x1b");
    await pause(25);
    ui.stdin.write("\x1b");
    await turn;
    expect(ui.lastFrame()).not.toContain("轮次列表");
  } finally {
    ui.unmount();
    await ui.current().close();
  }
});
it("中途分叉预览确认后换入新会话并恢复文字", async () => {
  const ui = await app();
  try {
    await command(ui, "/rewind");
    await settle(() => ui.lastFrame()?.includes("轮次列表") === true);
    await changedFrame(ui, () => ui.stdin.write("\r"));
    await changedFrame(ui, () => ui.stdin.write("\x1b[A")); // cancel → fork
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.lastFrame()).toContain("确认分叉新会话");
    expect(ui.lastFrame()).toContain("文件保持当前状态");
    await changedFrame(ui, () => ui.stdin.write("\t"));
    ui.stdin.write("\r");
    await settle(
      () =>
        ui.current().id !== ui.original.id &&
        ui.lastFrame()?.includes("原消息的图片未放回") === true,
    );
    const middle = ui.current();
    expect(middle.state().history.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(middle.state().meta.forkedFrom?.sessionId).toBe(ui.original.id);
  } finally {
    ui.unmount();
    await ui.current().close();
  }
});
it("/fork 从当前位置复制并切换会话", async () => {
  const ui = await app();
  try {
    await command(ui, "/fork");
    await settle(() => ui.current().id !== ui.original.id);
    expect(ui.current().state().meta.forkedFrom?.sessionId).toBe(ui.original.id);
    expect(ui.current().state().history).toEqual(ui.original.state().history);
  } finally {
    ui.unmount();
    await ui.current().close();
  }
});
