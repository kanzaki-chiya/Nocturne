import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultJevReviewer,
  type JevReviewerConfig,
  type ProviderOverview,
  type Runtime,
} from "@nocturne/core";
import { ReviewerDialog } from "../src/components/reviewer-dialog.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { detectTuiEnv, TuiEnvContext } from "../src/env.js";

const borrowed = {
  id: "opencode-go",
  host: "opencode.ai",
  keySource: "credential",
} as ProviderOverview;
const initial = defaultJevReviewer("opencode-zen", [borrowed]);
const screens: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const screen of screens.splice(0)) screen.unmount();
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
function dialog(
  options: {
    initial?: JevReviewerConfig;
    fallback?: boolean;
    accepted?: boolean;
    width?: number;
    height?: number;
    ascii?: boolean;
  } = {},
) {
  const apply = vi.fn();
  const cancel = vi.fn();
  const list = vi.fn(async (_config: JevReviewerConfig, _signal: AbortSignal) =>
    options.fallback
      ? { models: ["jev-1.13-free"], warning: "模型列表拉取失败，已退回默认模型；也可手动输入" }
      : { models: ["jev-1.13-free", "jev-1.13"] },
  );
  const runtime = {
    getPreference: () => (options.accepted ? "yes" : undefined),
    defaultReviewer: async (endpoint: JevReviewerConfig["endpoint"], url?: string) =>
      defaultJevReviewer(endpoint, [borrowed], url),
    listReviewerModels: list,
    listReviewerProviders: async () => [borrowed],
  } as unknown as Runtime;
  let mouse: DialogMouseFrame | undefined;
  const screen = render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ...detectTuiEnv(), ascii: options.ascii ?? false } },
      createElement(ReviewerDialog, {
        runtime,
        initial: options.initial,
        width: options.width ?? 100,
        height: options.height ?? 28,
        onApply: apply,
        onCancel: cancel,
        onMouseFrame: (frame) => {
          mouse = frame;
        },
      }),
    ),
  );
  screens.push(screen);
  const input = async (value: string) => {
    screen.stdin.write(value);
    await pause();
  };
  const click = async (id: string, offset?: number) => {
    const box = mouse?.boxes.find((box) => box.id === id);
    if (!box) throw new Error(`无可点击区域：${id}`);
    mouse?.click(id, {
      type: "release",
      y: box.row,
      x: offset === undefined ? box.colEnd : box.colStart + offset,
      button: 0,
    });
    await pause();
  };
  return { ...screen, apply, cancel, list, input, click, ready: pause, mouse: () => mouse };
}
describe("ADR-0036 安全审查对话框", () => {
  it("Jev 流程、主机匹配借用、模型列表、一次披露与返回草稿", async () => {
    const s = dialog();
    await s.ready();
    expect(s.lastFrame()).toContain("关闭");
    expect(s.lastFrame()).toContain("小模型");
    await s.input("\x1b[C");
    expect(s.lastFrame()).toContain("opencode-go");
    expect(s.lastFrame()).toContain("0.7");
    await s.input("\r");
    await s.input("\r");
    expect(s.lastFrame()).toContain("选择 Jev 审查模型");
    expect(s.list).toHaveBeenCalledWith(initial, expect.any(AbortSignal));
    await s.input("\x1b[B");
    await s.input("\r");
    expect(s.lastFrame()).toContain("jev-1.13");
    await s.click("save");
    expect(s.lastFrame()).toContain("首次开启 Jev");
    expect(s.lastFrame()).toContain("工作目录和最近三条用户消息");
    expect(s.lastFrame()).toContain("OpenCode 与 TypeSafe");
    expect(s.lastFrame()).toContain("https://opencode.ai/zen/v1");
    expect(s.apply).not.toHaveBeenCalled();
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith({ ...initial, model: "jev-1.13" }, undefined, true);
  });
  it("拉取失败显示默认模型并可手动输入；已披露不再提示", async () => {
    const s = dialog({ initial, fallback: true, accepted: true });
    await s.ready();
    await s.click("model");
    expect(s.lastFrame()).toContain("退回默认模型");
    expect(s.lastFrame()).toContain("jev-1.13-free");
    expect(s.lastFrame()).toContain("手动输入模型 id");
    await s.input("\x1b[B");
    await s.input("\r");
    await s.input("\x15");
    await s.input("jev-manual");
    await s.input("\r");
    expect(s.lastFrame()).toContain("jev-manual");
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith({ ...initial, model: "jev-manual" }, undefined, false);
    expect(s.lastFrame()).not.toContain("首次开启 Jev");
  });
  it("独立密钥在实际帧中遮盖，只随确认回调传递；Esc 不保存", async () => {
    const s = dialog({ initial, accepted: true });
    await s.ready();
    await s.click("credential");
    await s.input("\x1b[B");
    await s.input("\x1b[B");
    await s.input("\r");
    await s.input("test-secret");
    expect(s.lastFrame()).not.toContain("test-secret");
    expect(s.lastFrame()).toContain("***********");
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith(
      { ...initial, credential: { stored: true } },
      "test-secret",
      false,
    );
    const cancelled = dialog({ initial, accepted: true });
    await cancelled.ready();
    await cancelled.input("\x1b");
    expect(cancelled.cancel).toHaveBeenCalledOnce();
    expect(cancelled.apply).not.toHaveBeenCalled();
  });
  it("环境变量可编辑，内置接入点不写 baseURL，鼠标选择 TypeSafe", async () => {
    const s = dialog({ initial, accepted: true });
    await s.ready();
    await s.click("endpoint:1");
    expect(s.lastFrame()).toContain("typesafe");
    expect(s.lastFrame()).toContain("jev-latest");
    await s.click("value");
    await s.input("\x15");
    await s.input("CUSTOM_JEV_KEY");
    expect(s.lastFrame()).toContain("CUSTOM_JEV_KEY");
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith(
      {
        backend: "jev",
        endpoint: "typesafe",
        model: "jev-latest",
        credential: { env: "CUSTOM_JEV_KEY" },
        minConfidence: 0.7,
      },
      undefined,
      false,
    );
  });
  it("文本框鼠标按列定位，标签不作为输入框点击区", async () => {
    const s = dialog({ initial: defaultJevReviewer("typesafe"), accepted: true });
    await s.ready();
    const fields = s.mouse()?.boxes.filter((box) => box.id === "value");
    expect(fields).toHaveLength(1);
    await s.click("value", 2);
    await s.input("CUSTOM_");
    expect(s.lastFrame()).toContain("CUSTOM_TYPESAFE_API_KEY");
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith(
      { ...defaultJevReviewer("typesafe"), credential: { env: "CUSTOM_TYPESAFE_API_KEY" } },
      undefined,
      false,
    );
  });
  it("custom 地址与置信度校验；关闭不需要凭据或披露", async () => {
    const s = dialog({
      initial: defaultJevReviewer("custom", [], "https://custom.invalid/v1"),
      accepted: true,
    });
    await s.ready();
    expect(s.lastFrame()).toContain("https://custom.invalid/v1");
    await s.click("threshold");
    await s.input("\x15");
    await s.input("2");
    await s.click("save");
    expect(s.lastFrame()).toContain("0–1");
    expect(s.apply).not.toHaveBeenCalled();
    await s.click("threshold");
    await s.input("\x15");
    await s.input("0.8");
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://custom.invalid/v1", minConfidence: 0.8 }),
      undefined,
      false,
    );
    const off = dialog();
    await off.ready();
    await off.click("save");
    expect(off.apply).toHaveBeenCalledWith({ backend: "off" }, undefined, false);
  });
  it("ASCII 窄屏保持焦点字段和按钮，加载时 Esc 取消请求", async () => {
    const s = dialog({ initial, width: 36, height: 15, ascii: true });
    await s.ready();
    expect(s.lastFrame()).toContain("安全审查");
    await s.input("\x1b[Z");
    expect(s.lastFrame()).toContain("保存");
    expect(s.lastFrame()?.split("\n").length).toBe(15);
    const loading = dialog({ initial });
    await loading.ready();
    loading.list.mockImplementation(() => new Promise(() => undefined));
    await loading.click("model");
    expect(loading.lastFrame()).toContain("正在拉取");
    const signal = loading.list.mock.calls[0]?.[1];
    await loading.input("\x1b");
    expect(signal?.aborted).toBe(true);
    expect(loading.lastFrame()).toContain("后端");
  });
});
