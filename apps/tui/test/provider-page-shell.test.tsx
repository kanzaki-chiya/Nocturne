import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { listProviderPresets, type ProviderOverview } from "@nocturne/core";
import { ProviderPage } from "../src/components/provider-page.js";
import { TuiEnvContext } from "../src/env.js";
import { changedFrame, settle } from "./provider-test-utils.js";

afterEach(cleanup);

const entry = (id: string, over: Partial<ProviderOverview> = {}): ProviderOverview => ({
  id,
  type: "openai-compatible",
  host: "example.test",
  keySource: "credential",
  authKind: "apiKey",
  origin: "setup",
  overridden: false,
  modelCount: 3,
  managed: true,
  auth: "API key",
  credentialStatus: "valid",
  ...over,
});

function page(over: { stepLabel?: string; width?: number; height?: number } = {}) {
  return render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ascii: false, animated: false } },
      createElement(ProviderPage, {
        presets: listProviderPresets(),
        entries: [entry("alpha"), entry("beta", { credentialStatus: "expired" })],
        currentProviderId: "alpha",
        wizard: undefined,
        onStartWizard: vi.fn(),
        onOp: vi.fn(),
        onReadonlyHint: () => "",
        onConfirmRemove: vi.fn(),
        onClose: vi.fn(),
        width: over.width ?? 110,
        height: over.height ?? 30,
        termRows: over.height ?? 30,
        active: true,
        ...(over.stepLabel !== undefined ? { stepLabel: over.stepLabel } : {}),
      }),
    ),
  );
}

it("双栏：左栏已配置/可添加计数，右栏状态点、状态、认证方式、当前与模型数", async () => {
  const ui = page();
  await settle(() => ui.lastFrame()?.includes("可添加") === true);
  const frame = ui.lastFrame() ?? "";
  const presets = listProviderPresets().length;
  expect(frame.split("\n")[0]).toContain("服务商");
  expect(frame).toContain("2 已配置");
  expect(frame).toMatch(/已配置 2/);
  expect(frame).toMatch(new RegExp(`可添加 ${presets}`));
  expect(frame).toMatch(/● alpha\s+有效\s+API key\s+当前\s+3 个模型/);
  expect(frame).toMatch(/● beta\s+已失效\s+API key\s+3 个模型/);
  expect(frame).toMatch(/○ ChatGPT\s+未配置/);
  expect(frame).toContain("▌");
  expect(frame).not.toContain("█▀");
  expect(frame).toContain("↑↓ 移动  Enter 操作  Delete 删除  Tab 切换栏  Esc 返回");
  ui.unmount();
});

it("左栏跳转：Tab 到左栏后 ↓ 选中「可添加」，右栏光标落到该组首项", async () => {
  const ui = page();
  await settle(() => ui.lastFrame()?.includes("可添加") === true);
  await changedFrame(ui, () => ui.stdin.write("\t"));
  await changedFrame(ui, () => ui.stdin.write("\x1b[B"));
  await changedFrame(ui, () => ui.stdin.write("\t"));
  const selectedRow = (ui.lastFrame() ?? "")
    .split("\n")
    .find((l) => l.includes("│") && l.indexOf("▌") > l.indexOf("│"));
  expect(selectedRow).toContain("ChatGPT");
  ui.unmount();
});

it("没有 stepLabel 时不画像素 Logo；首次配置（stepLabel）保留 Logo", async () => {
  const plain = page({ height: 40, width: 120 });
  await settle(() => plain.lastFrame()?.includes("可添加") === true);
  expect(plain.lastFrame()).not.toContain("首次配置");
  plain.unmount();
  const first = page({ stepLabel: "第 1 步，共 2 步", height: 40, width: 120 });
  await settle(() => first.lastFrame()?.includes("可添加") === true);
  expect(first.lastFrame()).toContain("Nocturne · 首次配置");
  expect(first.lastFrame()).toContain("第 1 步，共 2 步");
  expect((first.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(40);
  first.unmount();
});

it("当前服务商的说明区显示在用提示；窄屏折叠为分组条", async () => {
  const wide = page();
  await settle(() => wide.lastFrame()?.includes("可添加") === true);
  expect(wide.lastFrame()).toContain("当前会话在用");
  wide.unmount();
  const narrow = page({ width: 60 });
  await settle(() => narrow.lastFrame()?.includes("已配置") === true);
  expect(narrow.lastFrame()).toContain("‹ 已配置 ›");
  expect(narrow.lastFrame()).toContain("Tab 切换分组");
  narrow.unmount();
});
