import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DecisionModelConfig } from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import { GoalCheckDialog } from "../src/components/goal-check-dialog.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { detectTuiEnv, TuiEnvContext } from "../src/env.js";
import { ThemeContext, palettes } from "../src/theme.js";
import { flush } from "./provider-test-utils.js";

const geminiDecision: DecisionModelConfig = {
  source: "gemini",
  endpoint: "ai-studio",
  model: "gemini-decision-1",
  credential: { env: "GEMINI_API_KEY" },
};

const jevDecision: DecisionModelConfig = {
  source: "jev",
  endpoint: "typesafe",
  model: "jev-latest",
  credential: { env: "TYPESAFE_API_KEY" },
};

function openDialog(
  options: {
    initial?: "off" | "decision" | "smol";
    decisionModel?: DecisionModelConfig | undefined;
    prefs?: Record<string, string>;
  } = {},
) {
  const onApply = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  const onOpenDecisionModel = vi.fn();
  let frame: DialogMouseFrame | undefined;
  const runtime = createRuntimeStub({
    getPreference: (key: string) => options.prefs?.[key],
  });
  const app = render(
    createElement(
      TuiEnvContext.Provider,
      { value: detectTuiEnv() },
      createElement(
        ThemeContext.Provider,
        { value: palettes.dark },
        createElement(GoalCheckDialog, {
          runtime,
          initial: options.initial ?? "off",
          decisionModel: options.decisionModel,
          width: 80,
          height: 24,
          onOpenDecisionModel,
          onApply,
          onCancel,
          onMouseFrame: (next) => {
            frame = next;
          },
        }),
      ),
    ),
  );
  const send = async (data: string) => {
    app.stdin.write(data);
    await flush();
  };
  const click = async (id: string) => {
    await vi.waitFor(() => expect(frame).toBeDefined(), { timeout: 2000, interval: 10 });
    frame?.click(id, { type: "release", button: 0, x: 1, y: 1 });
    await flush();
  };
  return { ...app, send, click, onApply, onCancel, onOpenDecisionModel };
}

describe("GoalCheckDialog（ADR-0119）", () => {
  it("选小模型直接保存，不弹外发披露", async () => {
    const s = openDialog({ decisionModel: geminiDecision });
    await flush();
    await s.send("\x1b[D"); // off -> smol
    await s.click("save");
    expect(s.onApply).toHaveBeenCalledWith("smol", undefined);
    s.unmount();
  });

  it("未设置决策模型时选决策模型：显示设置 › 模型跳转入口且允许直接保存", async () => {
    const s = openDialog({ decisionModel: undefined });
    await flush();
    await s.send("\x1b[C"); // off -> decision
    expect(s.lastFrame()).toContain("设置 › 模型");
    expect(s.lastFrame()).not.toContain("未设置");
    await s.click("decisionModel");
    expect(s.onOpenDecisionModel).toHaveBeenCalledOnce();
    await s.click("save");
    expect(s.onApply).toHaveBeenCalledWith("decision", undefined);
    s.unmount();
  });

  it("已配 Google 决策模型且未接受目标核对披露时：弹出披露并写明免费档条款；已接受则跳过", async () => {
    const s1 = openDialog({
      decisionModel: geminiDecision,
      prefs: { decisionDisclosureAccepted: "google" },
    });
    await flush();
    await s1.send("\x1b[C"); // decision
    await s1.click("save");
    expect(s1.lastFrame()).toContain("首次启用 Gemini");
    expect(s1.lastFrame()).toContain("Google 免费档数据会被用于改进产品");
    expect(s1.onApply).not.toHaveBeenCalled();
    await s1.click("save");
    expect(s1.onApply).toHaveBeenCalledWith("decision", "google");
    s1.unmount();

    const s2 = openDialog({
      decisionModel: geminiDecision,
      prefs: { goalCheckDisclosureAccepted: "google" },
    });
    await flush();
    await s2.send("\x1b[C"); // decision
    await s2.click("save");
    expect(s2.onApply).toHaveBeenCalledWith("decision", undefined);
    s2.unmount();
  });

  it("已配 Jev (TypeSafe) 决策模型时：披露不含 Google 免费档条款", async () => {
    const s = openDialog({ decisionModel: jevDecision });
    await flush();
    await s.send("\x1b[C");
    await s.click("save");
    expect(s.lastFrame()).toContain("首次启用 Jev");
    expect(s.lastFrame()).toContain("TypeSafe");
    expect(s.lastFrame()).not.toContain("免费档数据会被用于改进产品");
    await s.click("save");
    expect(s.onApply).toHaveBeenCalledWith("decision", "typesafe");
    s.unmount();
  });
});
