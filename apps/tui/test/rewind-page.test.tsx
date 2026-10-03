import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { RewindTarget } from "@nocturne/core/protocol";
import { RewindPage } from "../src/components/rewind-page.js";
import { changedFrame, providerMouse, settle } from "./provider-test-utils.js";

afterEach(cleanup);
const target: RewindTarget = {
  seq: 3,
  firstLine: "修改文件",
  text: "修改文件\n保留第二行",
  time: new Date().toISOString(),
  hasImages: false,
  files: [
    { path: "C:/work/a.txt", action: "restore", external: true },
    { path: "C:/work/new.txt", action: "delete", external: false },
    { path: "C:/work/dir", action: "untracked", reason: "目录", external: false },
  ],
  untrackedCalls: 2,
};
async function page(targets: RewindTarget[] = [target], width = 81, height = 24, inline = false) {
  const mouse = providerMouse(),
    onClose = vi.fn(),
    onRewind = vi.fn(async () => undefined),
    onFork = vi.fn(async () => undefined);
  const ui = render(
    createElement(RewindPage, {
      targets,
      cwd: "C:/work",
      width,
      height,
      onClose,
      onRewind,
      onFork,
      onMouseFrame: inline ? undefined : mouse.report,
    }),
  );
  await settle(() => /轮次列表|终端太小/.test(ui.lastFrame() ?? ""));
  return { ...ui, mouse, onClose, onRewind, onFork };
}
it("竖排操作和两级默认取消；预览标明删除、无法还原、外部修改和未追踪调用", async () => {
  const ui = await page();
  expect(ui.lastFrame()).toContain("改动 3 个文件");
  expect(ui.lastFrame()).toContain("含 shell");
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("> [ 取消 ]");
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("轮次列表");
  await changedFrame(ui, () => ui.stdin.write("\r"));
  await changedFrame(ui, () => ui.stdin.write("\t"));
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("确认回退");
  for (const text of [
    "还原 a.txt [已在外部修改]",
    "已在外部修改",
    "删除 new.txt",
    "无法还原（目录）",
    "2 次 shell/MCP",
    "> [ 取消 ]",
  ])
    expect(ui.lastFrame()).toContain(text);
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.onRewind).not.toHaveBeenCalled();
  await changedFrame(ui, () => ui.mouse.click("files"));
  ui.mouse.click("confirm");
  await settle(() => ui.onRewind.mock.calls.length === 1);
  expect(ui.onRewind).toHaveBeenCalledWith(target, "files");
});
it("无可还原文件灰显两项，键盘跳过；分叉说明共享文件且默认取消", async () => {
  const empty = { ...target, files: [] };
  const ui = await page([empty], 81, 24, true);
  expect(ui.mouse.frame).toBeUndefined();
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("这一轮之后没有可还原的文件");
  expect(ui.lastFrame()).toContain("[ 只还原文件 ]（不可用）");
  await changedFrame(ui, () => ui.stdin.write("\t"));
  expect(ui.lastFrame()).toContain("> [ 只回退对话 ]");
  await changedFrame(ui, () => ui.stdin.write("\t"));
  expect(ui.lastFrame()).toContain("> [ 从这里分叉新会话 ]");
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("文件保持当前状态");
  expect(ui.lastFrame()).toContain("可在原会话里对同一轮执行「只还原文件」");
  await changedFrame(ui, () => ui.stdin.write("\t"));
  ui.stdin.write("\r");
  await settle(() => ui.onFork.mock.calls.length === 1);
  expect(ui.onFork).toHaveBeenCalledWith(empty);
});
it("全屏单击先选中、再打开，拖动不激活；列表和长预览按整帧预算翻页", async () => {
  const many = Array.from({ length: 35 }, (_, i) => ({
    ...target,
    seq: i + 3,
    firstLine: `轮次${i}`,
  }));
  many[1] = {
    ...target,
    seq: 4,
    firstLine: "轮次1",
    files: Array.from({ length: 30 }, (_, i) => ({
      path: `C:/f${i}`,
      action: "restore",
      external: false,
    })),
  };
  const ui = await page(many, 60, 14);
  const b = ui.mouse.at("1");
  ui.mouse.feed({ type: "press", button: 0, x: b.colStart, y: b.row });
  ui.mouse.feed({ type: "drag", button: 0, x: b.colStart + 2, y: b.row });
  ui.mouse.feed({ type: "release", button: 0, x: b.colStart, y: b.row });
  expect(ui.lastFrame()).toContain("› 轮次0");
  await changedFrame(ui, () => ui.mouse.click("1"));
  expect(ui.lastFrame()).toContain("› 轮次1");
  await changedFrame(ui, () => ui.mouse.click("1"));
  await changedFrame(ui, () => ui.mouse.click("both"));
  expect(ui.lastFrame()).toContain("C:/f0");
  await changedFrame(ui, () => ui.stdin.write("\x1b[6~"));
  expect(ui.lastFrame()).not.toContain("C:/f0");
  expect(ui.lastFrame()).toContain("C:/f8");
  expect((ui.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(14);
});
it("过小终端仍可 Esc 返回，错误保留预览并允许重试", async () => {
  const tiny = await page([target], 10, 6);
  expect(tiny.lastFrame()).toContain("终端太小");
  tiny.stdin.write("\x1b");
  await settle(() => tiny.onClose.mock.calls.length === 1);
  tiny.unmount();
  const ui = await page();
  ui.onRewind.mockRejectedValueOnce(new Error("session_busy"));
  await changedFrame(ui, () => ui.mouse.click("0"));
  await changedFrame(ui, () => ui.mouse.click("conversation"));
  expect(ui.lastFrame()).toContain("文件保持当前状态");
  ui.mouse.click("confirm");
  await settle(() => ui.lastFrame()?.includes("session_busy") === true);
  expect(ui.lastFrame()).toContain("确认回退");
});
