/**
 * PickList 组件测试（ADR-0022 /shell 选择页依赖）：
 * disabled 项灰显且光标跳过、Enter 不生效；initialValue 定位当前项。
 * 用 waitFor 轮询渲染帧，不依赖固定时长 sleep；
 * 其中一条用例把实际渲染帧写入临时文件作为审查证据。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { PickList, type PickItem } from "../src/components/pick-list.js";
import { TuiEnvContext } from "../src/env.js";

const ENV = { ascii: false, animated: false };
const inEnv = (child: React.ReactNode) =>
  createElement(TuiEnvContext.Provider, { value: ENV }, child);

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > end) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function renderList(
  items: PickItem<string>[],
  over?: {
    onPick?: (v: string) => void;
    onCancel?: () => void;
    initialValue?: string;
    note?: string;
  },
) {
  const onPick = vi.fn((v: string) => over?.onPick?.(v));
  const onCancel = vi.fn(() => over?.onCancel?.());
  const r = render(
    inEnv(
      createElement(PickList<string>, {
        title: "选择 shell",
        ...(over?.note !== undefined ? { note: over.note } : {}),
        items,
        active: true,
        onPick,
        onCancel,
        width: 60,
        ...(over?.initialValue !== undefined ? { initialValue: over.initialValue } : {}),
      }),
    ),
  );
  return { ...r, onPick, onCancel };
}

const items: PickItem<string>[] = [
  { label: "auto", hint: "自动选择", value: "auto" },
  { label: "pwsh", hint: "C:\\ps\\pwsh.exe", value: "pwsh" },
  { label: "powershell（未安装）", value: "powershell", disabled: true },
  { label: "bash", hint: "C:\\Git\\bin\\bash.exe", value: "bash" },
];

describe("PickList（ADR-0022 选择页）", () => {
  it("渲染全部项与标题/说明行；disabled 项照常显示；帧文本落盘存证", async () => {
    const { lastFrame, unmount } = renderList(items, {
      note: "当前由 NOCTURNE_SHELL 指定，选择写入 settings.json 但不生效",
      initialValue: "pwsh",
    });
    await waitFor(() => (lastFrame() ?? "").includes("powershell（未安装）"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("选择 shell");
    expect(frame).toContain("当前由 NOCTURNE_SHELL 指定");
    expect(frame).toContain("powershell（未安装）");
    expect(frame).toContain("bash");
    // 当前项（pwsh）获得光标前缀 ›；disabled 项无
    expect(frame).toContain("› pwsh");
    // 渲染帧存证：<tmpdir>/nct-pick-frame-*/shell-pick-list.txt
    const dir = mkdtempSync(path.join(os.tmpdir(), "nct-pick-frame-"));
    writeFileSync(path.join(dir, "shell-pick-list.txt"), `${frame}\n`);
    unmount();
  });

  it("光标跳过 disabled 项；Enter 只对可选项生效", async () => {
    const { stdin, lastFrame, onPick, unmount } = renderList(items);
    await waitFor(() => (lastFrame() ?? "").includes("› auto"));
    // 光标从 auto 出发，↓ 落在 pwsh（可用）
    stdin.write("\x1b[B");
    await waitFor(() => (lastFrame() ?? "").includes("› pwsh"));
    // 再 ↓ 应跳过 disabled 的 powershell 落到 bash
    stdin.write("\x1b[B");
    await waitFor(() => (lastFrame() ?? "").includes("› bash"));
    stdin.write("\r");
    await waitFor(() => onPick.mock.calls.length === 1);
    expect(onPick).toHaveBeenCalledWith("bash");
    unmount();
  });

  it("initialValue 定位到当前项；disabled 的 initialValue 回退到第一个可用项", async () => {
    const { stdin, lastFrame, onPick, unmount } = renderList(items, { initialValue: "bash" });
    await waitFor(() => (lastFrame() ?? "").includes("› bash"));
    stdin.write("\r");
    await waitFor(() => onPick.mock.calls.length === 1);
    expect(onPick).toHaveBeenCalledWith("bash");
    unmount();

    const second = renderList(items, { initialValue: "powershell" });
    // powershell disabled → 光标回退到第一个可用项 auto
    await waitFor(() => (second.lastFrame() ?? "").includes("› auto"));
    second.stdin.write("\r");
    await waitFor(() => second.onPick.mock.calls.length === 1);
    expect(second.onPick).toHaveBeenCalledWith("auto");
    second.unmount();
  });

  it("Esc 取消", async () => {
    const { stdin, lastFrame, onCancel, unmount } = renderList(items);
    await waitFor(() => (lastFrame() ?? "").includes("选择 shell"));
    stdin.write("\x1b");
    await waitFor(() => onCancel.mock.calls.length === 1);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });
});
