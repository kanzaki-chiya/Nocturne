/**
 * 模型设置编辑页测试（ADR-0024 第 5 节）：服务商页操作条、模型列表、
 * 编辑页聚焦/跟随/保存、只读查看、/provider model 直达。
 * 直接渲染 ProviderPage（ink-testing-library），数据经 stub 桥注入。
 */
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelField,
  ModelSettingsView,
  ProviderOverview,
  ReasoningEffortLevel,
} from "@nocturne/core";

import { ProviderPage } from "../src/components/provider-page.js";

const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}

const DOWN = "[B";
const LEFT = "[D";
const RIGHT = "[C";
const ENTER = "\r";

const field = <T,>(
  value: T | undefined,
  source: ModelSettingsView["fields"]["displayName"]["source"],
  editable = true,
  userValue?: T,
): ModelField<T> => ({
  value,
  source,
  editable,
  ...(userValue !== undefined ? { userValue } : {}),
});

const fullView = (
  over?: Partial<ModelSettingsView["fields"]>,
  top?: Partial<ModelSettingsView>,
): ModelSettingsView => ({
  providerId: "up",
  modelId: "m1",
  readonly: false,
  fields: {
    displayName: field<string | undefined>(undefined, { kind: "upstream" }),
    contextWindow: field<number | undefined>(100_000, { kind: "upstream" }),
    maxOutputTokens: field<number | undefined>(8_000, { kind: "upstream" }),
    reasoning: field<"none" | "hidden" | "visible">("visible", { kind: "upstream" }),
    imageInput: field<boolean | undefined>(false, { kind: "default" }),
    reasoningEffort: field<("low" | "high")[] | undefined>(["low", "high"], { kind: "derived" }),
    ...over,
  } as ModelSettingsView["fields"],
  ...top,
});

const views = [fullView(), fullView(undefined, { modelId: "m2" })];

const entry = (over?: Partial<ProviderOverview>): ProviderOverview => ({
  id: "up",
  type: "openai-compatible",
  host: "api.example.com",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 2,
  managed: true,
  ...over,
});

function pageProps(over?: Record<string, unknown>) {
  return {
    presets: [],
    entries: [entry()],
    wizard: undefined,
    onStartWizard: vi.fn(),
    onOp: vi.fn(),
    onReadonlyHint: () => "服务商 up 定义在 config.json，请编辑该处配置",
    onConfirmRemove: vi.fn(),
    onListModels: async () => views,
    onClose: vi.fn(),
    width: 100,
    height: 29,
    termRows: 30,
    active: true,
    ...over,
  };
}

describe("模型设置编辑页（ADR-0024）", () => {
  it("操作条含「编辑模型」：Enter 条目 → 操作条 → 编辑模型进列表", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(ProviderPage, pageProps()));
    await waitFor(() => (lastFrame() ?? "").includes("up"));
    stdin.write(ENTER); // 打开操作条
    await waitFor(() => (lastFrame() ?? "").includes("编辑模型"));
    for (let i = 0; i < 3; i += 1) {
      stdin.write(RIGHT);
      await pause(30);
    }
    stdin.write(ENTER); // 选择「编辑模型」
    await waitFor(() => (lastFrame() ?? "").includes("m2"));
    unmount();
  });

  it("列表 → 编辑 → 保存：参数与 patch 正确；成功后回列表显示结果行", async () => {
    const save = vi.fn(async () => undefined as string | undefined);
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onSaveModel: save }),
        initialModelTarget: { providerId: "up" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("m1"));
    await pause(100);
    stdin.write(ENTER); // 列表第一行 → 编辑页
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    await pause(100);
    // ↓×3 到图片输入行，→ 从「跟随」切到「是」
    for (let i = 0; i < 3; i += 1) stdin.write(DOWN);
    await pause(50);
    stdin.write(RIGHT);
    await pause(50);
    // 继续 ↓ 到 [保存]（focusables = 6 字段 + save + cancel）
    for (let i = 0; i < 3; i += 1) stdin.write(DOWN);
    await pause(50);
    stdin.write(ENTER);
    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledWith("up", "m1", { imageInput: true });
    await waitFor(() => (lastFrame() ?? "").includes("已保存 up/m1"));
    unmount();
  });

  it("只读字段不可聚焦：↓ 跳过 config 来源行", async () => {
    const readonlyViews = [
      fullView({
        contextWindow: field<number>(
          42_000,
          { kind: "config", layer: "user", path: "/tmp/config.json" },
          false,
        ),
      }),
    ];
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => readonlyViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    await pause(100);
    // ↓×1：应从「显示名」落到「最大输出」（跳过只读的上下文长度）；键入 7 验证
    stdin.write(DOWN);
    await pause(50);
    stdin.write("7");
    await pause(50);
    const frame = lastFrame() ?? "";
    const maxOutRow = frame.split("\n").find((l) => l.includes("最大输出")) ?? "";
    expect(maxOutRow).toContain("7");
    const ctxRow = frame.split("\n").find((l) => l.includes("上下文长度")) ?? "";
    expect(ctxRow).not.toContain("7");
    unmount();
  });

  it("「跟随」切换写 null 清除用户编辑", async () => {
    const withUser = [
      fullView({
        imageInput: field<boolean>(true, { kind: "user" }, true, true),
      }),
    ];
    const save = vi.fn(async () => undefined as string | undefined);
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => withUser, onSaveModel: save }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    await pause(100);
    // 图片输入有用户编辑 → 草稿初始为「是」；↓×3 到该行，← 回「跟随」
    for (let i = 0; i < 3; i += 1) stdin.write(DOWN);
    await pause(50);
    stdin.write(LEFT);
    await pause(50);
    for (let i = 0; i < 3; i += 1) stdin.write(DOWN);
    await pause(50);
    stdin.write(ENTER);
    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledWith("up", "m1", { imageInput: null });
    unmount();
  });

  it("校验失败：原因显示在页内，不退出编辑页", async () => {
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onSaveModel: async () => "最大输出不能超过上下文长度" }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    await pause(100);
    // 6 字段全可编辑：↓×6 到 [保存]
    for (let i = 0; i < 6; i += 1) stdin.write(DOWN);
    await pause(50);
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("最大输出不能超过上下文长度"));
    expect(lastFrame()).toContain("[保存]"); // 仍在编辑页
    unmount();
  });

  it("只读服务商：Enter 进模型列表查看模式，编辑页只剩取消", async () => {
    const roViews = views.map((v) => ({
      ...v,
      readonly: true,
      readonlyHint: "服务商 up 定义在 config.json，请编辑该处配置",
    }));
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ entries: [entry({ managed: false })], onListModels: async () => roViews }),
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("up"));
    stdin.write(ENTER); // 只读条目直接进模型列表
    await waitFor(
      () => (lastFrame() ?? "").includes("m1") && (lastFrame() ?? "").includes("请编辑该处配置"),
    );
    expect(lastFrame()).toContain("只读 • Esc 返回");
    stdin.write(ENTER); // 进编辑页（只读）
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up › m1"));
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[保存]");
    expect(frame).toContain("只读 • Esc 返回");
    expect(frame).toContain("请编辑该处配置");
    unmount();
  });

  it("/provider model 直达：initialModelTarget 带 modelId 直接打开编辑页", async () => {
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps(),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    await pause(100);
    expect(lastFrame()).toContain("服务商 up › m1");
    unmount();
  });

  it("值显示：可编辑无用户编辑 → 跟随（生效值）；config 来源 → 直接显示生效值", async () => {
    const cfgViews = [
      fullView({
        contextWindow: field<number>(
          42_000,
          { kind: "config", layer: "user", path: "/tmp/config.json" },
          false,
        ),
        displayName: field<string>(undefined, { kind: "default" }),
      }),
    ];
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => cfgViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    const frame = lastFrame() ?? "";
    const ctxRow = frame.split("\n").find((l) => l.includes("上下文长度")) ?? "";
    expect(ctxRow).toContain("42000");
    expect(ctxRow).not.toContain("跟随");
    const outRow = frame.split("\n").find((l) => l.includes("最大输出")) ?? "";
    expect(outRow).toContain("跟随（8000）");
    const nameRow = frame.split("\n").find((l) => l.includes("显示名")) ?? "";
    expect(nameRow).toContain("跟随（未声明）");
    const effortRow = frame.split("\n").find((l) => l.includes("思考档位")) ?? "";
    expect(effortRow).toContain("跟随（low/high）");
    unmount();
  });

  it("reasoning_none 锁定的档位行显示 — 且来源列说明原因", async () => {
    const lockedViews = [
      fullView({
        reasoning: field<"none" | "hidden" | "visible">("none", { kind: "user" }, true, "none"),
        reasoningEffort: field<ReasoningEffortLevel[]>([], { kind: "reasoning_none" }, false),
      }),
    ];
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => lockedViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    const effortRow = (lastFrame() ?? "").split("\n").find((l) => l.includes("思考档位")) ?? "";
    expect(effortRow).toContain("—");
    expect(effortRow).toContain("不可切换");
    expect(effortRow).not.toContain("跟随");
    unmount();
  });

  it("面包屑与底部按键提示：列表页两行页头，编辑页单行面包屑", { timeout: 15000 }, async () => {
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps(),
        initialModelTarget: { providerId: "up" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    expect(lastFrame()).toContain("过滤:");
    expect(lastFrame()).toContain("↑/↓ 选择 • Enter 编辑 • Esc 返回");
    await pause(100);
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up › m1"));
    expect(lastFrame()).toContain("↑/↓ 移动 • ←/→ 切换 • Enter 编辑/确认 • Esc 取消");
    unmount();
  });

  it("字段值列按显示宽度对齐（中文字段名补齐）", async () => {
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps(),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    const frame = lastFrame() ?? "";
    // 「显示名」（显示宽 6）与「上下文长度」（显示宽 10）的值列起始应一致：
    // 列宽 10，显示名补 4 空 + 分隔 1 空，上下文长度只有分隔 1 空
    const nameRow = frame.split("\n").find((l) => l.includes("显示名")) ?? "";
    const ctxRow = frame.split("\n").find((l) => l.includes("上下文长度")) ?? "";
    expect(nameRow).toMatch(/显示名 {5}跟随/);
    expect(ctxRow).toMatch(/上下文长度 {1}跟随/);
    unmount();
  });

  it("值列上限 32：超长值截断后来源列仍可见", async () => {
    const wideViews = [
      fullView({
        reasoningEffort: field<ReasoningEffortLevel[]>(
          ["minimal", "low", "medium", "high", "xhigh", "max"],
          { kind: "derived" },
        ),
      }),
    ];
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => wideViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    const row = (lastFrame() ?? "").split("\n").find((l) => l.includes("思考档位")) ?? "";
    // 值文本「跟随（minimal/low/medium/high/xhigh/max）」宽 44 > 32 → 截断加省略号
    expect(row).toContain("…");
    expect(row).toContain("按推理能力推导"); // 来源列未被挤出
    unmount();
  });

  it("来源路径放不下时从左侧截断，保留文件名", async () => {
    const longPath = "/very/deeply/nested/path/that/cannot/possibly/fit/in/row/config.json";
    const cfgViews = [
      fullView({
        contextWindow: field<number>(
          42_000,
          { kind: "config", layer: "user", path: longPath },
          false,
        ),
      }),
    ];
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => cfgViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[保存]"));
    const row = (lastFrame() ?? "").split("\n").find((l) => l.includes("上下文长度")) ?? "";
    expect(row).toContain("…");
    expect(row).toMatch(/config\.json 决定/);
    expect(row).not.toContain("/very/deeply");
    unmount();
  });

  it("子视图打开时底部只有子视图一行提示（含 Ctrl+C 退出）", async () => {
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps(),
        initialModelTarget: { providerId: "up" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    expect(lastFrame()).not.toContain("Esc 返回上一级");
    expect(lastFrame()).toContain("↑/↓ 选择 • Enter 编辑 • Esc 返回 • Ctrl+C 退出");
    await pause(100);
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up › m1"));
    expect(lastFrame()).not.toContain("Esc 返回上一级");
    expect(lastFrame()).toContain("↑/↓ 移动 • ←/→ 切换 • Enter 编辑/确认 • Esc 取消 • Ctrl+C 退出");
    unmount();
  });
});
