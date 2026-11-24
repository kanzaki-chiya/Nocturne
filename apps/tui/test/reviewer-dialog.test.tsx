import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionModelConfig, ProviderOverview, SecurityReviewerConfig } from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import { DecisionModelDialog } from "../src/components/decision-model-dialog.js";
import { ReviewerDialog } from "../src/components/reviewer-dialog.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { detectTuiEnv, TuiEnvContext } from "../src/env.js";
import { flush } from "./provider-test-utils.js";

const borrowed = {
  id: "opencode-go",
  host: "opencode.ai",
  keySource: "credential",
} as ProviderOverview;

const geminiDecision: DecisionModelConfig = {
  source: "gemini",
  endpoint: "ai-studio",
  model: "gemini-decision-1",
  credential: { env: "GEMINI_API_KEY" },
};

const screens: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const screen of screens.splice(0)) screen.unmount();
});

function makeHelper(
  screen: ReturnType<typeof render>,
  getMouse: () => DialogMouseFrame | undefined,
) {
  const settle = async (before: string | undefined) => {
    if (screen.lastFrame() === before) {
      await vi
        .waitFor(() => expect(screen.lastFrame()).not.toBe(before), { timeout: 300 })
        .catch(() => undefined);
    }
    await flush();
  };
  const input = async (value: string) => {
    const before = screen.lastFrame();
    screen.stdin.write(value);
    await settle(before);
  };
  const click = async (id: string, offset?: number) => {
    const mouse = getMouse();
    const box = mouse?.boxes.find((b) => b.id === id);
    if (!box) throw new Error(`无可点击区域：${id}`);
    const before = screen.lastFrame();
    mouse?.click(id, {
      type: "release",
      y: box.row,
      x: offset === undefined ? box.colEnd : box.colStart + offset,
      button: 0,
    });
    await settle(before);
  };
  const ready = () => settle("");
  return { input, click, ready };
}

function reviewerDialog(
  options: {
    initial?: SecurityReviewerConfig;
    decisionModel?: DecisionModelConfig;
    accepted?: string;
    legacyAccepted?: boolean;
    width?: number;
    height?: number;
  } = {},
) {
  const apply = vi.fn(() => Promise.resolve(undefined as string | undefined));
  const cancel = vi.fn();
  const openDecisionModel = vi.fn();
  const runtime = createRuntimeStub({
    getPreference: (key: string) =>
      key === "decisionDisclosureAccepted"
        ? options.accepted
        : key === "jevDisclosureAccepted" && options.legacyAccepted
          ? "yes"
          : undefined,
  });
  let mouse: DialogMouseFrame | undefined;
  const screen = render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ...detectTuiEnv(), ascii: false } },
      createElement(ReviewerDialog, {
        runtime,
        initial: options.initial,
        decisionModel: options.decisionModel,
        width: options.width ?? 100,
        height: options.height ?? 28,
        onOpenDecisionModel: openDecisionModel,
        onApply: apply,
        onCancel: cancel,
        onMouseFrame: (frame) => {
          mouse = frame;
        },
      }),
    ),
  );
  screens.push(screen);
  return {
    ...screen,
    ...makeHelper(screen, () => mouse),
    apply,
    cancel,
    openDecisionModel,
  };
}

function decisionDialog(
  options: {
    initial?: DecisionModelConfig;
    models?: string[];
    width?: number;
    height?: number;
  } = {},
) {
  const apply = vi.fn(() => Promise.resolve(undefined as string | undefined));
  const cancel = vi.fn();
  const listDecisionModels = vi.fn(async () => ({
    models: options.models ?? ["gemini-decision-1", "gemini-decision-2"],
  }));
  const runtime = createRuntimeStub({
    listReviewerProviders: async () => [borrowed],
    listDecisionModels,
  });
  let mouse: DialogMouseFrame | undefined;
  const screen = render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ...detectTuiEnv(), ascii: false } },
      createElement(DecisionModelDialog, {
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
  return {
    ...screen,
    ...makeHelper(screen, () => mouse),
    apply,
    cancel,
    listDecisionModels,
  };
}

describe("ADR-0117 TUI 决策模型与安全审查对话框", () => {
  it("决策模型对话框：切换来源 Gemini、单独密钥遮盖与保存；Esc 取消", async () => {
    const s = decisionDialog();
    await s.ready();
    expect(s.lastFrame()).toContain("未设置");
    expect(s.lastFrame()).toContain("Gemini");
    expect(s.lastFrame()).toContain("Jev");

    // 切到 Gemini
    await s.input("\x1b[C");
    expect(s.lastFrame()).toContain("Google AI Studio");
    expect(s.lastFrame()).toContain("gemini-decision-1");

    // 焦点移到凭据 -> 切到单独密钥 -> 焦点移到值 -> 输入假密钥
    await s.click("credential");
    await s.input("\x1b[C");
    await s.click("value");
    await s.input("fake-tui-secret");
    expect(s.lastFrame()).not.toContain("fake-tui-secret");
    expect(s.lastFrame()).toContain("***************");

    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith(
      {
        source: "gemini",
        endpoint: "ai-studio",
        model: "gemini-decision-1",
        credential: { stored: true },
      },
      "fake-tui-secret",
    );

    const cancelled = decisionDialog({ initial: geminiDecision });
    await cancelled.ready();
    await cancelled.input("\x1b");
    expect(cancelled.cancel).toHaveBeenCalledOnce();
    expect(cancelled.apply).not.toHaveBeenCalled();
  });

  it("审查对话框：新分段关闭/决策模型/小模型；未设置决策模型时报错；可跳转决策模型", async () => {
    const s = reviewerDialog();
    await s.ready();
    expect(s.lastFrame()).toContain("关闭");
    expect(s.lastFrame()).toContain("决策模型");
    expect(s.lastFrame()).toContain("小模型");

    // 切到决策模型，未设置时保存报错
    await s.input("\x1b[C");
    expect(s.lastFrame()).toContain("未设置");
    await s.click("save");
    expect(s.lastFrame()).toContain("先设置决策模型");
    expect(s.apply).not.toHaveBeenCalled();

    // 点决策模型行触发跳转
    await s.click("decisionModel");
    expect(s.openDecisionModel).toHaveBeenCalledOnce();
  });

  it("审查对话框：已设 Gemini 决策模型时首次外发显示 Google 说明，确认后保存", async () => {
    const s = reviewerDialog({ decisionModel: geminiDecision });
    await s.ready();
    await s.input("\x1b[C");
    expect(s.lastFrame()).toContain("gemini-decision-1");
    await s.click("save");
    expect(s.lastFrame()).toContain("首次启用决策模型审查");
    expect(s.lastFrame()).toContain("Google");
    expect(s.apply).not.toHaveBeenCalled();

    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith({ backend: "decision", minConfidence: 0.7 }, "google");
  });

  it("审查对话框：已接受偏好时不再重复显示外发说明", async () => {
    const s = reviewerDialog({
      decisionModel: geminiDecision,
      accepted: "google",
    });
    await s.ready();
    await s.input("\x1b[C");
    await s.click("save");
    expect(s.apply).toHaveBeenCalledWith({ backend: "decision", minConfidence: 0.7 }, undefined);
  });
});
