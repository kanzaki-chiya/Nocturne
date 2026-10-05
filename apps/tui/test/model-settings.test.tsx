/**
 * 模型设置编辑页测试（ADR-0024 第 5 节）：服务商页操作条、模型列表、
 * 编辑页聚焦/跟随/保存、只读查看、/provider model 直达。
 * 直接渲染 ProviderPage（ink-testing-library），数据经 stub 桥注入。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createPlatform,
  loadConfig,
  type ModelField,
  type ModelSettingsView,
  type ProviderOverview,
  type ReasoningEffortLevel,
  type ProviderPreset,
} from "@nocturne/core";

import { ProviderPage } from "../src/components/provider-page.js";
import { draftToPatch, ModelEditPane } from "../src/components/model-settings-view.js";
import { TuiEnvContext } from "../src/env.js";

const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}

/**
 * 等 Ink 写出下一帧：本次按键的 React 更新已经完成。
 * 同一测试里连续发键（如先移焦点再 Enter）时用它同步，不用固定延时。
 */
async function nextFrame(frames: readonly string[]): Promise<void> {
  const n = frames.length;
  await waitFor(() => frames.length > n);
}

const DOWN = "[B";
const LEFT = "[D";
const RIGHT = "[C";
const ENTER = "\r";
const UP = "\x1b[A";
/**
 * 等 React 跑完挂在 useEffect 上的 useInput 订阅/退订：帧写出去不代表
 * 按键路由已切换（订阅变更比帧提交晚一轮事件循环）。视图切换后写键前先调它。
 */
async function flushInput(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}
/** ink 7 对真实终端序列的解析：\x7f = backspace，\x1b[3~ = delete */
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";

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
    protocol: field<"openai-compatible" | "anthropic" | undefined>("openai-compatible", {
      kind: "entryType",
    }),
    editTool: field<"edit" | "apply_patch">("edit", { kind: "default" }),
    ...over,
  } as ModelSettingsView["fields"],
  ...top,
});

const views = [fullView(), fullView(undefined, { modelId: "m2" })];

const blankDraft = {
  displayName: "",
  contextWindow: "",
  maxOutputTokens: "",
  imageInput: "follow",
  reasoning: "follow",
  reasoningEffort: "follow",
  protocol: "follow",
  editTool: "follow",
} as const;

const entry = (over?: Partial<ProviderOverview>): ProviderOverview => ({
  id: "up",
  type: "openai-compatible",
  host: "api.example.com",
  keySource: "credential",
  authKind: "apiKey",
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

describe("draftToPatch 固定期望值", () => {
  it("既有三态、数字、协议与清除覆盖的输出保持不变", () => {
    expect(draftToPatch(fullView(), blankDraft)).toEqual({});
    expect(
      draftToPatch(fullView(), {
        ...blankDraft,
        imageInput: "true",
        reasoning: "yes",
        protocol: "messages",
      }),
    ).toEqual({ imageInput: true, reasoning: "visible", protocol: "anthropic" });
    expect(
      draftToPatch(fullView(), {
        ...blankDraft,
        imageInput: "false",
        reasoning: "no",
        protocol: "chat",
      }),
    ).toEqual({ imageInput: false, reasoning: "none", protocol: "openai-compatible" });
    expect(
      draftToPatch(fullView(), {
        ...blankDraft,
        protocol: "responses",
      }),
    ).toEqual({ protocol: "openai-responses" });
    expect(
      draftToPatch(fullView(), {
        ...blankDraft,
        displayName: "新名",
        contextWindow: "abc",
        maxOutputTokens: "1200",
      }),
    ).toEqual({ displayName: "新名", contextWindow: -1, maxOutputTokens: 1200 });
    const withUser = fullView({
      imageInput: field(true, { kind: "user" }, true, true),
      protocol: field<"openai-compatible" | "anthropic">(
        "anthropic",
        { kind: "user" },
        true,
        "anthropic",
      ),
    });
    expect(draftToPatch(withUser, blankDraft)).toEqual({ imageInput: null, protocol: null });
  });

  it("已有 hidden 且草稿仍为是时不写 reasoning；改否仍写 none", () => {
    const hidden = fullView({
      reasoning: field<"none" | "hidden" | "visible">("hidden", { kind: "user" }, true, "hidden"),
    });
    expect(draftToPatch(hidden, { ...blankDraft, reasoning: "yes" })).toEqual({});
    expect(draftToPatch(hidden, { ...blankDraft, reasoning: "no" })).toEqual({ reasoning: "none" });
    expect(draftToPatch(hidden, blankDraft)).toEqual({ reasoning: null });
  });
});

describe("模型设置编辑页（ADR-0024）", () => {
  it("上游只有基本字段时，编辑页显示 models.dev 的推理和看图来源", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nct-model-frame-"));
    try {
      const home = path.join(root, "home");
      await fs.mkdir(home);
      const upstream = {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        context_length: 128_000,
        supported_endpoints: ["/v1/chat/completions"],
      };
      await fs.writeFile(
        path.join(home, "providers.json"),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: "up",
              type: "openai-compatible",
              baseURL: "https://example.test/v1",
              models: {
                [upstream.id]: {
                  displayName: upstream.name,
                  contextWindow: upstream.context_length,
                },
              },
            },
          ],
        }),
      );
      const config = await loadConfig(createPlatform(), {
        nocturneHome: home,
        env: () => undefined,
      });
      const { lastFrame, unmount } = render(
        createElement(
          ProviderPage,
          pageProps({
            entries: [entry({ modelCount: 1 })],
            onListModels: () => config.listModelSettings("up"),
            initialModelTarget: { providerId: "up", modelId: upstream.id },
          }),
        ),
      );
      await waitFor(
        () => (lastFrame() ?? "").includes("推理") && (lastFrame() ?? "").includes("图片输入"),
      );
      const frame = lastFrame() ?? "";
      expect(frame).toMatch(/推理[^\n]*\n[^\n]*models\.dev[^\n]*是/);
      expect(frame).toMatch(/图片输入[^\n]*\n[^\n]*models\.dev[^\n]*是/);
      expect(frame).toMatch(/上下文长度[^\n]*\n[^\n]*上游[^\n]*128000/);
      unmount();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("操作条含「编辑模型」：Enter 条目 → 操作条 → 编辑模型进列表", async () => {
    const { lastFrame, stdin, frames, unmount } = render(createElement(ProviderPage, pageProps()));
    await waitFor(() => (lastFrame() ?? "").includes("up"));
    stdin.write(ENTER); // 打开操作条
    await waitFor(() => (lastFrame() ?? "").includes("编辑模型"));
    for (let i = 0; i < 2; i += 1) {
      stdin.write(RIGHT);
      await nextFrame(frames);
    }
    stdin.write(ENTER); // 选择「编辑模型」
    await waitFor(() => (lastFrame() ?? "").includes("m2"));
    unmount();
  });

  it("列表 → 编辑 → 保存：参数与 patch 正确；成功后回列表显示结果行", async () => {
    const save = vi.fn(async () => undefined as string | undefined);
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onSaveModel: save }),
        initialModelTarget: { providerId: "up" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("m1"));
    await flushInput();
    stdin.write(ENTER); // 列表第一行 → 编辑页
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    await flushInput();
    // ↓×3 到图片输入行，→ 从「跟随」切到「是」
    for (let i = 0; i < 3; i += 1) {
      stdin.write(DOWN);
      await nextFrame(frames);
    }
    stdin.write(RIGHT);
    await nextFrame(frames);
    // Tab 跨过剩余字段与取消，到保存。
    for (let i = 0; i < 6; i += 1) {
      stdin.write("\t");
      await nextFrame(frames);
    }
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
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => readonlyViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    await flushInput();
    // ↓×1：应从「显示名」落到「最大输出」（跳过只读的上下文长度）；键入 7 验证
    stdin.write(DOWN);
    await nextFrame(frames);
    stdin.write("7");
    await nextFrame(frames);
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
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => withUser, onSaveModel: save }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    await flushInput();
    // 图片输入有用户编辑 → 草稿初始为「是」；↓×3 到该行，← 回「跟随」
    for (let i = 0; i < 3; i += 1) {
      stdin.write(DOWN);
      await nextFrame(frames);
    }
    stdin.write(LEFT);
    await nextFrame(frames);
    for (let i = 0; i < 6; i += 1) {
      stdin.write("\t");
      await nextFrame(frames);
    }
    stdin.write(ENTER);
    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledWith("up", "m1", { imageInput: null });
    unmount();
  });

  it("校验失败：原因显示在页内，不退出编辑页", async () => {
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onSaveModel: async () => "最大输出不能超过上下文长度" }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    await flushInput();
    // Tab 遍历所有字段与取消，到保存。
    for (let i = 0; i < 9; i += 1) {
      stdin.write("\t");
      await nextFrame(frames);
    }
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("最大输出不能超过上下文长度"));
    expect(lastFrame()).toContain("[ 保存 ]"); // 仍在编辑页
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
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up / 模型 m1"));
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[ 保存 ]");
    expect(frame).toContain("[ 返回 ]");
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
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    expect(lastFrame()).toContain("服务商 up / 模型 m1");
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
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    const frame = lastFrame() ?? "";
    const ctxRow = frame.split("\n").find((l) => l.includes("上下文长度")) ?? "";
    expect(ctxRow).toContain("42000");
    expect(ctxRow).not.toContain("跟随");
    expect(frame).toMatch(/最大输出[^\n]*\n[^\n]*跟随（8000）/);
    expect(frame).toMatch(/显示名[^\n]*\n[^\n]*跟随（未声明）/);
    const effortRow = frame.split("\n").find((l) => l.includes("思考档位")) ?? "";
    expect(effortRow).toContain("跟随（low/high）");
    unmount();
  });

  it("推理为否时隐藏档位行", async () => {
    const noReasoningViews = [
      fullView({
        reasoning: field<"none" | "hidden" | "visible">("none", { kind: "user" }, true, "none"),
        reasoningEffort: field<ReasoningEffortLevel[]>([], { kind: "default" }, false),
      }),
    ];
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onListModels: async () => noReasoningViews }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    expect(lastFrame()).toContain("推理");
    expect(lastFrame()).not.toContain("思考档位");
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
    await flushInput();
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up / 模型 m1"));
    expect(lastFrame()).toContain("Tab/方向键移动  空格/Enter 选择  Esc 取消");
    unmount();
  });

  it("字段值列按显示宽度对齐（中文字段名补齐）", async () => {
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps(),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    const frame = lastFrame() ?? "";
    // 不同显示宽度的标签后，输入框从同一列开始。
    // 行里还拼着左侧服务商面板，先裁到对话框边框 "│" 再比列位
    const nameRow = frame.split("\n").find((l) => l.includes("显示名")) ?? "";
    const ctxRow = frame.split("\n").find((l) => l.includes("上下文长度")) ?? "";
    // 输入框 "[" 到对话框左边框的显示宽度即为标签列宽
    const fromBox = (l: string) => stringWidth(l.slice(l.indexOf("│"), l.indexOf("[")));
    expect(fromBox(nameRow)).toBe(fromBox(ctxRow));
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
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/思考档位[^\n]*\n(?:[^\n]*\n)?[^\n]*按推理能力推导/);
    expect(frame).toContain("minimal/low/medium/high/xhigh/max");
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
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    const lines = (lastFrame() ?? "").split("\n");
    const index = lines.findIndex((l) => l.includes("上下文长度"));
    const row = lines[index + 1] ?? "";
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
    await flushInput();
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up / 模型 m1"));
    expect(lastFrame()).not.toContain("Esc 返回上一级");
    expect(lastFrame()).toContain("Tab/方向键移动  空格/Enter 选择  Esc 取消");
    unmount();
  });
});

describe("服务商页 Delete 入口与底部提示（ADR-0030 §6）", () => {
  it("Delete 打开删除确认（默认焦点在取消），确认后才删除", async () => {
    const onConfirmRemove = vi.fn();
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, pageProps({ onConfirmRemove })),
    );
    await waitFor(() => (lastFrame() ?? "").includes("已配置"));
    stdin.write(DELETE);
    await waitFor(() => (lastFrame() ?? "").includes("删除服务商 up"));
    stdin.write(ENTER); // 默认焦点在「取消」：Enter 不删除
    await waitFor(() => (lastFrame() ?? "").includes("已取消删除"));
    expect(onConfirmRemove).not.toHaveBeenCalled();
    stdin.write(DELETE);
    await waitFor(() => (lastFrame() ?? "").includes("删除服务商 up"));
    stdin.write(RIGHT); // 移到「删除」
    await nextFrame(frames);
    stdin.write(ENTER);
    await waitFor(() => onConfirmRemove.mock.calls.length === 1);
    expect(onConfirmRemove).toHaveBeenCalledWith("up");
    unmount();
  });

  it("当前会话所用服务商：Delete 拒绝，操作对话框「删除」灰显并跳过焦点", async () => {
    const onConfirmRemove = vi.fn();
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, pageProps({ currentProviderId: "up", onConfirmRemove })),
    );
    await waitFor(() => (lastFrame() ?? "").includes("当前"));
    stdin.write(DELETE);
    await waitFor(() => (lastFrame() ?? "").includes("先 /model 切换"));
    expect(lastFrame() ?? "").not.toContain("删除服务商");
    expect(onConfirmRemove).not.toHaveBeenCalled();
    // 操作对话框的删除不可聚焦，左箭头环绕到取消。
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("[ 删除 ]（不可用）"));
    expect(lastFrame() ?? "").toContain("先用 /model 切换");
    await flushInput();
    stdin.write(LEFT);
    await nextFrame(frames);
    expect(lastFrame() ?? "").toContain("> [ 取消 ]");
    stdin.write(ENTER);
    await waitFor(() => !(lastFrame() ?? "").includes("[ 删除 ]（不可用）"));
    expect(lastFrame() ?? "").not.toContain("删除服务商");
    expect(onConfirmRemove).not.toHaveBeenCalled();
    unmount();
  });

  it("只读条目：Delete 提示只读原因，不开确认框", async () => {
    const onConfirmRemove = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      createElement(
        ProviderPage,
        pageProps({ entries: [entry({ managed: false })], onConfirmRemove }),
      ),
    );
    await waitFor(() => (lastFrame() ?? "").includes("只读"));
    stdin.write(DELETE);
    await waitFor(() => (lastFrame() ?? "").includes("请编辑该处配置"));
    expect(lastFrame() ?? "").not.toContain("删除服务商");
    expect(onConfirmRemove).not.toHaveBeenCalled();
    unmount();
  });

  it("未配置预设：Delete 提示不能删除的原因，不开确认框", async () => {
    const presets: ProviderPreset[] = [
      {
        id: "other-oai",
        label: "其他 OpenAI 兼容服务",
        type: "openai-compatible",
        defaultName: "",
        fetchableModels: true,
        thinkingFormat: "openai",
      },
    ];
    const onConfirmRemove = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      createElement(ProviderPage, pageProps({ presets, entries: [], onConfirmRemove })),
    );
    await waitFor(() => (lastFrame() ?? "").includes("其他 OpenAI 兼容服务"));
    stdin.write(DELETE);
    await waitFor(() => (lastFrame() ?? "").includes("尚未配置"));
    expect(lastFrame() ?? "").not.toContain("删除服务商");
    expect(onConfirmRemove).not.toHaveBeenCalled();
    unmount();
  });

  it("过滤非空时 Delete 仍打开确认框，过滤文字不变", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(ProviderPage, pageProps()));
    await waitFor(() => (lastFrame() ?? "").includes("已配置"));
    stdin.write("u");
    await waitFor(() => {
      const row = (lastFrame() ?? "").split("\n").find((l) => l.includes("过滤:")) ?? "";
      return row.includes("过滤: u");
    });
    stdin.write(DELETE);
    await waitFor(() => (lastFrame() ?? "").includes("删除服务商 up"));
    const filter = (lastFrame() ?? "").split("\n").find((l) => l.includes("过滤:")) ?? "";
    expect(filter).toContain("过滤: u");
    unmount();
  });

  it("Backspace 仍只删过滤字符", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(ProviderPage, pageProps()));
    await waitFor(() => (lastFrame() ?? "").includes("已配置"));
    stdin.write("up");
    await waitFor(() => {
      const row = (lastFrame() ?? "").split("\n").find((l) => l.includes("过滤:")) ?? "";
      return row.includes("过滤: up");
    });
    stdin.write(BACKSPACE);
    await waitFor(() => {
      const row = (lastFrame() ?? "").split("\n").find((l) => l.includes("过滤:")) ?? "";
      return row.includes("过滤: u") && !row.includes("过滤: up");
    });
    unmount();
  });

  it("宽屏底部使用 ADR-0039 列表提示", async () => {
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, pageProps({ width: 120, height: 30, termRows: 30 })),
    );
    await waitFor(() => (lastFrame() ?? "").includes("已配置"));
    const hint = (lastFrame() ?? "").split("\n").find((l) => l.includes("Enter 操作")) ?? "";
    expect(hint).toContain("↑↓ 移动  Enter 操作  Delete 删除  Tab 切换栏  Esc 返回");
    expect(lastFrame() ?? "").not.toContain("换密钥 / 刷新 / 编辑模型 / 删除");
    unmount();
  });

  it("70 列仍显示同一列表提示，不再重复列出操作名", async () => {
    const { lastFrame, unmount } = render(
      createElement(ProviderPage, pageProps({ width: 70, height: 30, termRows: 30 })),
    );
    await waitFor(() => (lastFrame() ?? "").includes("已配置"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Enter 操作");
    expect(frame).toContain("Esc 返回");
    expect(frame).not.toContain("Enter 打开操作");
    expect(frame).toContain("↑↓ 移动  Enter 操作  Delete 删除  Tab 切换分组  Esc 返回");
    expect(frame).not.toContain("换密钥 / 刷新 / 编辑模型 / 删除");
    unmount();
  });
});

describe("模型对话框键盘操作（ADR-0030 §4）", () => {
  function editor(over: Partial<Parameters<typeof ModelEditPane>[0]> = {}) {
    const onSave = vi.fn();
    const onBack = vi.fn();
    const props = {
      view: fullView(),
      active: true,
      width: 100,
      height: 29,
      onSave,
      onBack,
      ...over,
    };
    const ui = render(createElement(ModelEditPane, props));
    return { ...ui, onSave, onBack, props };
  }

  it("文本框编辑、空格和 Enter 只移动焦点；按钮需获得焦点才保存", async () => {
    const { stdin, lastFrame, frames, onSave, unmount } = editor();
    await waitFor(() => (lastFrame() ?? "").includes("显示名"));
    stdin.write("ab c");
    await waitFor(() => (lastFrame() ?? "").includes("ab c"));
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("> 上下文长度"));
    expect(onSave).not.toHaveBeenCalled();
    stdin.write("x");
    await waitFor(() => (lastFrame() ?? "").includes("请输入正整数"));
    stdin.write("\x1b[H");
    await nextFrame(frames);
    stdin.write(DELETE);
    await waitFor(() => !(lastFrame() ?? "").includes("请输入正整数"));
    unmount();
  });

  it("弹层 Esc 放弃弹层修改；无修改 Esc 返回；有修改 Esc 确认且可撤销确认", async () => {
    const { stdin, lastFrame, frames, onBack, unmount } = editor();
    await waitFor(() => (lastFrame() ?? "").includes("显示名"));
    for (let i = 0; i < 5; i += 1) {
      stdin.write("\t");
      await nextFrame(frames);
    }
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("空格勾选"));
    stdin.write(" ");
    await nextFrame(frames);
    stdin.write("\x1b");
    await waitFor(() => !(lastFrame() ?? "").includes("空格勾选"));
    stdin.write("\x1b");
    await waitFor(() => onBack.mock.calls.length === 1);
    unmount();

    const dirty = editor();
    await waitFor(() => (dirty.lastFrame() ?? "").includes("显示名"));
    dirty.stdin.write("a");
    await waitFor(() => (dirty.lastFrame() ?? "").includes("[ a"));
    dirty.stdin.write("\x1b");
    await waitFor(() => (dirty.lastFrame() ?? "").includes("放弃修改？"));
    expect(dirty.onBack).not.toHaveBeenCalled();
    dirty.stdin.write("\x1b");
    await waitFor(() => !(dirty.lastFrame() ?? "").includes("放弃修改？"));
    dirty.stdin.write("\x1b");
    await waitFor(() => (dirty.lastFrame() ?? "").includes("放弃修改？"));
    dirty.stdin.write(RIGHT);
    await nextFrame(dirty.frames);
    dirty.stdin.write(ENTER);
    await waitFor(() => dirty.onBack.mock.calls.length === 1);
    dirty.unmount();
  });

  it("保存失败保留草稿和保存焦点；保存中重复 Enter 只调用一次", async () => {
    let finish: ((error: string | undefined) => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          finish = resolve;
        }),
    );
    const { lastFrame, stdin, frames, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onSaveModel: save }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write("X");
    await waitFor(() => (lastFrame() ?? "").includes("[ X"));
    for (let i = 0; i < 9; i += 1) {
      stdin.write("\t");
      await nextFrame(frames);
    }
    expect(lastFrame()).toContain("> [ 保存 ]");
    stdin.write(ENTER);
    await waitFor(() => save.mock.calls.length === 1);
    await waitFor(() => (lastFrame() ?? "").includes("正在保存"));
    stdin.write(ENTER);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    stdin.write("\x1b");
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(lastFrame()).toContain("正在保存");
    finish?.("文件不可写");
    await waitFor(() => (lastFrame() ?? "").includes("! 保存失败：文件不可写"));
    expect(lastFrame()).toContain("[ X");
    expect(lastFrame()).toContain("> [ 保存 ]");
    unmount();
  });

  it("四级布局退化和极小尺寸仅允许 Esc", async () => {
    for (const [width, height, expected] of [
      [100, 29, "╭"],
      [28, 10, "服务商 up / 模型"],
      [22, 10, "显示"],
      [15, 8, "显示"],
      [8, 3, "终端太小"],
    ] as const) {
      const { lastFrame, stdin, onSave, onBack, unmount } = editor({ width, height });
      await waitFor(() => (lastFrame() ?? "").includes(expected));
      if (width === 8) {
        stdin.write("\t");
        stdin.write(ENTER);
        expect(onSave).not.toHaveBeenCalled();
        stdin.write("\x1b");
        await waitFor(() => onBack.mock.calls.length === 1);
      }
      unmount();
    }
  });

  it("对话框按字母和 Enter 时，下层过滤框不变且不触发主提交", async () => {
    const close = vi.fn();
    const save = vi.fn(async () => undefined);
    const { stdin, lastFrame, unmount } = render(
      createElement(ProviderPage, {
        ...pageProps({ onClose: close, onSaveModel: save }),
        initialModelTarget: { providerId: "up", modelId: "m1" },
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("[ 保存 ]"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write("z");
    await waitFor(() => (lastFrame() ?? "").includes("[ z"));
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("> 上下文长度"));
    expect(
      ((lastFrame() ?? "").split("\n").find((line) => line.includes("过滤:")) ?? "").split("│")[0],
    ).not.toContain("z");
    expect(close).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    unmount();
  });

  it("Tab 循环全部可聚焦项；↑/↓ 只在字段间移动并在两端停住", async () => {
    const { stdin, lastFrame, onSave, onBack, unmount } = editor();
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    // 首字段按 ↑ 停住：随后键入的字符仍落在显示名框
    stdin.write(UP);
    stdin.write("k");
    await waitFor(() => (lastFrame() ?? "").includes("[ k"));
    expect(lastFrame()).toContain("> 显示名");
    // Tab 到末尾的保存，再 Tab 回第一个字段（循环）
    for (let i = 0; i < 9; i += 1) stdin.write("\t");
    await waitFor(() => (lastFrame() ?? "").includes("> [ 保存 ]"));
    stdin.write("\t");
    await waitFor(
      () =>
        (lastFrame() ?? "").includes("> 上下文长度") === false &&
        (lastFrame() ?? "").includes("> 显示名"),
    );
    // Shift+Tab 反向循环回保存
    stdin.write("\x1b[Z");
    await waitFor(() => (lastFrame() ?? "").includes("> [ 保存 ]"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    unmount();
  });

  it("推理原本为否：草稿切到「是」后档位可编辑并显示推导全档，不改档位只保存推理", async () => {
    const view = fullView({
      reasoning: field<"none" | "hidden" | "visible">("none", { kind: "default" }),
      reasoningEffort: field<ReasoningEffortLevel[]>(undefined, { kind: "default" }, false),
    });
    const { stdin, lastFrame, onSave, unmount } = editor({ view });
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 4; i += 1) stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> 推理"));
    stdin.write(RIGHT);
    await waitFor(() => (lastFrame() ?? "").includes("思考档位"));
    expect(lastFrame()).toContain("minimal/low/medium/high/xhigh/max");
    const effortRow = (lastFrame() ?? "").split("\n").find((l) => l.includes("思考档位")) ?? "";
    expect(effortRow).not.toContain("未声明");
    expect(effortRow).not.toContain("只读");
    stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> 思考档位"));
    // ↓×3：协议 → 编辑工具 → 保存
    stdin.write(DOWN);
    stdin.write(DOWN);
    stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> [ 保存 ]"));
    stdin.write(ENTER);
    await waitFor(() => onSave.mock.calls.length === 1);
    expect(onSave).toHaveBeenCalledWith({ reasoning: "visible" });
    unmount();
  });

  it("↓ 从最后一个字段进入「保存」；放得下时不滚动", async () => {
    const { stdin, lastFrame, onSave, unmount } = editor();
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 10; i += 1) stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> [ 保存 ]"));
    // 高度足够：焦点到底部后首个字段仍可见
    expect(lastFrame()).toContain("显示名");
    expect(onSave).not.toHaveBeenCalled();
    unmount();
  });

  it("需要滚动时只滚到焦点字段可见，不在下方留空", async () => {
    const { stdin, lastFrame, unmount } = editor({ height: 16 });
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 6; i += 1) stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> 协议"));
    // 协议之上的字段仍填满字段区，而不是把协议顶到第一行
    expect(lastFrame()).toContain("思考档位");
    unmount();
  });

  it("按钮区：↓ 停住、↑ 回最后一个字段、←/→ 在按钮间移动", async () => {
    const { stdin, lastFrame, onBack, unmount } = editor();
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 8; i += 1) stdin.write("\t");
    await waitFor(() => (lastFrame() ?? "").includes("> [ 取消 ]"));
    // ↓ 在按钮区停住：随后 Enter 仍执行取消
    stdin.write(DOWN);
    stdin.write(ENTER);
    await waitFor(() => onBack.mock.calls.length === 1);
    unmount();

    const again = editor();
    await waitFor(() => (again.lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 8; i += 1) again.stdin.write("\t");
    await waitFor(() => (again.lastFrame() ?? "").includes("> [ 取消 ]"));
    // ←/→ 在取消与保存之间移动
    again.stdin.write(RIGHT);
    await waitFor(() => (again.lastFrame() ?? "").includes("> [ 保存 ]"));
    again.stdin.write(LEFT);
    await waitFor(() => (again.lastFrame() ?? "").includes("> [ 取消 ]"));
    // ↑ 回最后一个可编辑字段（编辑工具）
    again.stdin.write(UP);
    await waitFor(() => (again.lastFrame() ?? "").includes("> 编辑工具"));
    again.unmount();
  });

  it("分段按钮到两端停住不循环；选「否」保存为 false", async () => {
    const save = vi.fn();
    const { stdin, lastFrame, unmount } = editor({ onSave: save });
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 3; i += 1) stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> 图片输入"));
    // 起点是「跟随」：← 不循环回「否」，随后 →→ 选中「否」
    stdin.write(LEFT);
    stdin.write(RIGHT);
    stdin.write(RIGHT);
    await waitFor(() => (lastFrame() ?? "").includes("[* 否]"));
    for (let i = 0; i < 6; i += 1) stdin.write("\t");
    await waitFor(() => (lastFrame() ?? "").includes("> [ 保存 ]"));
    stdin.write(ENTER);
    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledWith({ imageInput: false });
    unmount();
  });

  it("编辑工具：跟随/edit/apply_patch 循环；选 apply_patch 保存（ADR-0035 §5）", async () => {
    const save = vi.fn();
    const { stdin, lastFrame, unmount } = editor({ onSave: save });
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    // ↓×7 到「编辑工具」（最后一个字段）
    for (let i = 0; i < 7; i += 1) stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> 编辑工具"));
    // →→：跟随 → edit → apply_patch
    stdin.write(RIGHT);
    stdin.write(RIGHT);
    await waitFor(() => (lastFrame() ?? "").includes("[* apply_patch]"));
    stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? "").includes("> [ 保存 ]"));
    stdin.write(ENTER);
    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledWith({ editTool: "apply_patch" });
    unmount();
  });

  it("多选弹层：「跟随」「不支持思考强度」与其他项互斥", async () => {
    const { stdin, lastFrame, unmount } = editor();
    await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
    await flushInput();
    for (let i = 0; i < 5; i += 1) stdin.write("\t");
    await waitFor(() => (lastFrame() ?? "").includes("> 思考档位"));
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("空格勾选"));
    // 光标 0=跟随：↓×2 到 minimal，空格勾选，再 ↓ 勾 low，两行都 [x]
    stdin.write(DOWN);
    stdin.write(DOWN);
    stdin.write(" ");
    stdin.write(DOWN);
    stdin.write(" ");
    await waitFor(
      () => (lastFrame() ?? "").includes("[x] minimal") && (lastFrame() ?? "").includes("[x] low"),
    );
    // ↑×3 回「跟随」，空格独占选择：其余清空
    stdin.write(UP);
    stdin.write(UP);
    stdin.write(UP);
    stdin.write(" ");
    await waitFor(
      () =>
        (lastFrame() ?? "").includes("[x] 跟随") && !(lastFrame() ?? "").includes("[x] minimal"),
    );
    // ↓ 到「不支持思考强度」再独占一次，Enter 确认后显示「不支持思考强度」
    stdin.write(DOWN);
    stdin.write(" ");
    await waitFor(
      () =>
        (lastFrame() ?? "").includes("[x] 不支持思考强度") &&
        !(lastFrame() ?? "").includes("[x] 跟随"),
    );
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? "").includes("当前：不支持思考强度"));
    unmount();
  });

  it("ASCII 模式外框退为 classic，>、*、! 照常显示", async () => {
    const { lastFrame, unmount } = render(
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: true, animated: false } },
        createElement(ModelEditPane, {
          view: fullView(),
          active: true,
          width: 100,
          height: 29,
          onSave: vi.fn(),
          onBack: vi.fn(),
        }),
      ),
    );
    await waitFor(() => (lastFrame() ?? "").includes("服务商 up / 模型 m1"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("+---"); // classic 边框
    expect(frame).toContain("> 显示名");
    expect(frame).toContain("[* 跟随]");
    expect(frame).not.toContain("╭");
    unmount();
  });

  it("NO_COLOR 下不输出颜色控制序列，边框与标记仍在", async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const { lastFrame, stdin, unmount } = editor();
      await waitFor(() => (lastFrame() ?? "").includes("> 显示名"));
      await flushInput();
      stdin.write("x");
      await waitFor(() => (lastFrame() ?? "").includes("[ x"));
      stdin.write("\t");
      await waitFor(() => (lastFrame() ?? "").includes("> 上下文长度"));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("["); // 无任何 CSI 颜色/样式序列
      expect(frame).toContain("╭");
      expect(frame).toContain("> 上下文长度");
      unmount();
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
