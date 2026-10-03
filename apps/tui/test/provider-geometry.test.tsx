import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ProviderPreset } from "@nocturne/core";

import { ProviderPage } from "../src/components/provider-page.js";
import { TuiEnvContext } from "../src/env.js";
import type { WizardState } from "../src/wizard-io.js";

/**
 * 页头几何回归（ADR-0019 第 3 条）：任何向导状态下整帧行数不得超过终端行数，
 * 否则 Ink 相对定位会让终端滚动、页头被逐帧顶出（conhost 80×25 实测缺陷）。
 */
const ENV = { ascii: false, animated: true };

const PRESETS: ProviderPreset[] = [
  {
    id: "other-oai",
    label: "其他 OpenAI 兼容服务",
    type: "openai-compatible",
    defaultName: "",
    fetchableModels: true,
    thinkingFormat: "openai",
  },
];

const WIZARD = (state: WizardState) => ({
  state,
  submit: vi.fn(),
  submitMulti: vi.fn(),
  cancel: vi.fn(),
});

function renderPage(state: WizardState | undefined, width = 80, height = 25) {
  return render(
    createElement(
      TuiEnvContext.Provider,
      { value: ENV },
      createElement(ProviderPage, {
        presets: PRESETS,
        entries: [],
        wizard: state === undefined ? undefined : WIZARD(state),
        onStartWizard: vi.fn(),
        onOp: vi.fn(),
        onReadonlyHint: () => "",
        onConfirmRemove: vi.fn(),
        onClose: vi.fn(),
        stepLabel: "第 1 步，共 2 步",
        width,
        height,
        active: true,
      }),
    ),
  );
}

/** 断言：帧不超过终端行数，且第 1 行仍是页头标题（单行降级时） */
function expectHeaderIntact(frame: string, height: number, compactTitle: boolean) {
  const rows = frame.split("\n");
  expect(rows.length).toBeLessThanOrEqual(height);
  if (compactTitle) {
    expect(rows[0]).toContain("Nocturne");
  }
}

const STATES: Record<string, WizardState> = {
  list: { running: false, logs: [], steps: [] },
  "name-prompt": {
    running: true,
    logs: [],
    steps: [],
    prompt: { text: "名称：", secret: false, hint: "该服务商的标识" },
  },
  "url-prompt": {
    running: true,
    logs: [],
    steps: ["名称 fake"],
    prompt: {
      text: "服务地址：",
      secret: false,
      hint: "留空使用官方默认端点；示例 https://api.example.com/v1",
    },
  },
  "busy-fetch": {
    running: true,
    logs: [],
    steps: ["名称 fake", "地址 api.example.com", "密钥已保存"],
    busyText: "正在获取模型列表…",
  },
  "fetch-fail": {
    running: true,
    logs: ["保存后可用 /provider refresh 重试"],
    steps: ["名称 fake", "密钥已保存", "! 获取模型列表失败（HTTP 401）：密钥可能无效"],
    busyText: undefined,
    prompt: { text: "思考强度档位：", secret: false, multi: { options: [] } },
  },
  "thinking-multi": {
    running: true,
    logs: [],
    steps: ["名称 fake", "已获取 12 个模型"],
    prompt: {
      text: "思考强度档位：",
      secret: false,
      multi: {
        options: ["不支持思考强度", "minimal", "low", "medium", "high", "xhigh", "max"],
        exclusiveIndex: 0,
      },
    },
  },
};

describe("provider page geometry (header never scrolls off)", () => {
  for (const [tag, state] of Object.entries(STATES)) {
    it(`80x25 ${tag}`, () => {
      const { lastFrame, unmount } = renderPage(tag === "list" ? undefined : state, 80, 25);
      const frame = lastFrame() ?? "";
      expectHeaderIntact(frame, 25, true);
      unmount();
    });
  }

  it("50x20 narrow+short still shows title row", () => {
    const { lastFrame, unmount } = renderPage(STATES["thinking-multi"], 50, 20);
    const frame = lastFrame() ?? "";
    expectHeaderIntact(frame, 20, true);
    unmount();
  });

  it("120x40 draws pixel logo header within height", () => {
    const { lastFrame, unmount } = renderPage(STATES["busy-fetch"], 120, 40);
    const frame = lastFrame() ?? "";
    expectHeaderIntact(frame, 40, false);
    expect(frame).toContain("Nocturne · 服务商");
    unmount();
  });
});
