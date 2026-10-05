/**
 * 模型选择页组件测试（tui.md §7）：双栏布局、搜索、分页、内联选项条、
 * 窄屏降级、○ 预设进向导。组件级渲染（ink-testing-library），
 * 备用屏进出序列在 App 层由 alt-screen.ts 负责，不在此断言。
 */
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelInfo,
  ModelRef,
  ProviderOverview,
  ProviderPreset,
  ReasoningEffort,
} from "@nocturne/core";

import { ModelPicker } from "../src/components/model-picker.js";
import { TuiEnvContext } from "../src/env.js";

const ENV = { ascii: false, animated: false };
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const inEnv = (child: React.ReactNode) =>
  createElement(TuiEnvContext.Provider, { value: ENV }, child);

const caps = (
  reasoning: "none" | "visible" | "hidden",
  imageInput = false,
): ModelInfo["capabilities"] => ({
  reasoning,
  imageInput,
  promptCache: false,
  editTool: "edit",
  toolCalls: true,
  parallelToolCalls: false,
});

const model = (provider: string, id: string, extra?: Partial<ModelInfo>): ModelInfo => ({
  ref: { provider, model: id },
  capabilities: caps("none"),
  ...extra,
});

const MODELS: ModelInfo[] = [
  model("deepseek", "deepseek-chat", {
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    pricing: { input: 0.27, output: 1.1 },
    capabilities: caps("visible", true),
  }),
  model("openrouter", "gpt-5.2-codex", {
    contextWindow: 400_000,
    pricing: { input: 1.75, output: 14 },
    capabilities: caps("hidden"),
  }),
  model("anthropic", "claude-opus-4.6", { contextWindow: 200_000 }),
  model("openrouter", "llama-4", {}),
];

const PROVIDERS: ProviderOverview[] = [
  {
    id: "deepseek",
    type: "openai-compatible",
    host: "api.deepseek.com",
    keySource: "credential",
    authKind: "apiKey",
    origin: "setup",
    overridden: false,
    modelCount: 1,
    managed: true,
  },
  {
    id: "openrouter",
    type: "openai-compatible",
    host: "openrouter.ai",
    keySource: "env",
    authKind: "env",
    keyEnvName: "OPENROUTER_API_KEY",
    origin: "user",
    overridden: false,
    modelCount: 2,
    managed: false,
  },
  {
    id: "anthropic",
    type: "anthropic",
    keySource: "missing",
    authKind: "none",
    origin: "setup",
    overridden: false,
    modelCount: 1,
    managed: true,
  },
];

const PRESETS: ProviderPreset[] = [
  {
    id: "commandcode",
    label: "CommandCode",
    type: "openai-compatible",
    defaultName: "CommandCode",
    baseURL: "https://x",
    defaultKeyEnv: "CC_KEY",
    fetchableModels: true,
  },
];

const CURRENT: ModelRef = { provider: "deepseek", model: "deepseek-chat" };
const DEFAULT: ModelRef = { provider: "openrouter", model: "gpt-5.2-codex" };
const RECENTS: ModelRef[] = [{ provider: "anthropic", model: "claude-opus-4.6" }];

function renderPicker(overrides?: {
  width?: number;
  models?: ModelInfo[];
  providers?: ProviderOverview[];
  recents?: ModelRef[];
  initialFocus?: "left" | "right";
  initialScope?: { kind: "provider"; id: string };
  onPick?: (ref: string, d: boolean) => void;
  onStartWizard?: (id: string) => void;
  onClose?: () => void;
  currentEffort?: ReasoningEffort;
  savedEffort?: ReasoningEffort;
}) {
  const onPick = overrides?.onPick ?? vi.fn();
  const onStartWizard = overrides?.onStartWizard ?? vi.fn();
  const onClose = overrides?.onClose ?? vi.fn();
  const r = render(
    inEnv(
      createElement(ModelPicker, {
        models: overrides?.models ?? MODELS,
        recents: overrides?.recents ?? RECENTS,
        providers: overrides?.providers ?? PROVIDERS,
        presets: PRESETS,
        current: CURRENT,
        defaultModel: DEFAULT,
        currentEffort: overrides?.currentEffort,
        savedEffort: overrides?.savedEffort,
        initialScope: overrides?.initialScope,
        initialFocus: overrides?.initialFocus,
        wizard: undefined,
        onStartWizard,
        onPick,
        onClose,
        width: overrides?.width ?? 100,
        height: 30,
        active: true,
      }),
    ),
  );
  return { ...r, onPick, onStartWizard, onClose };
}

describe("模型选择页", () => {
  it.each([
    ["high", "low", "high"],
    ["medium", "medium", "low"],
    [undefined, undefined, "off"],
  ] as const)(
    "设为默认预选 current=%s saved=%s → %s，Esc 返回选项条",
    async (currentEffort, savedEffort, expected) => {
      const chosen = model("fake", "reasoner", {
        capabilities: { ...caps("visible"), reasoningEffort: ["low", "high"] },
      });
      const screen = renderPicker({
        models: [chosen],
        recents: [],
        ...(currentEffort ? { currentEffort } : {}),
        ...(savedEffort ? { savedEffort } : {}),
      });
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("fake/reasoner"));
      await pause(100);
      screen.stdin.write("\r");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("仅本会话"));
      await pause(100);
      screen.stdin.write("\x1b[C");
      await pause(100);
      screen.stdin.write("\r");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain(`* ${expected}`));
      await pause(100);
      screen.stdin.write("\x1b");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("仅本会话"));
      await pause(100);
      expect(screen.onPick).not.toHaveBeenCalled();
      screen.stdin.write("\r");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain(`* ${expected}`));
      await pause(100);
      screen.stdin.write("\x1b[C");
      await pause(100);
      screen.stdin.write("\r");
      await vi.waitFor(() =>
        expect(screen.onPick).toHaveBeenCalledWith(
          "fake/reasoner",
          true,
          expected === "off" ? "low" : expected === "low" ? "high" : "off",
        ),
      );
      screen.unmount();
    },
  );
  it("双栏布局：左栏范围/服务商/预设，右栏搜索框与模型行", async () => {
    const { lastFrame, unmount } = renderPicker();
    await pause();
    const frame = lastFrame() ?? "";
    // 左栏
    expect(frame).toContain("最近使用");
    expect(frame).toContain("全部模型");
    expect(frame).toContain("● deepseek 1");
    expect(frame).toContain("○ commandcode");
    // 右栏模型行：provider/model + 能力标记 + 上下文（价格只在说明区显示选中行）
    expect(frame).toContain("deepseek/deepseek-chat");
    expect(frame).toContain("128k");
    expect(frame).toContain("openrouter/gpt-5.2-codex");
    expect(frame).toContain("400k");
    // 未声明字段：llama-4 无 ctx/价格 → 不编造
    expect(frame).toContain("openrouter/llama-4");
    // 底部按键提示
    expect(frame).toContain("Esc");
    unmount();
  });

  it("最近使用置顶并以分隔线隔开；详情行标注当前/默认", async () => {
    const { lastFrame, unmount } = renderPicker();
    await pause();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("最近使用");
    // anthropic/claude-opus-4.6 是 recent，在 all 范围置顶
    const idx = frame.indexOf("anthropic/claude-opus-4.6");
    const idx2 = frame.indexOf("deepseek/deepseek-chat");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(idx2);
    unmount();
  });

  it("全部模型范围最近项按新→旧置顶，分隔线标「其余模型」", async () => {
    const { lastFrame, unmount } = renderPicker({
      recents: [
        { provider: "openrouter", model: "llama-4" },
        { provider: "deepseek", model: "deepseek-chat" },
      ],
    });
    await pause();
    const frame = lastFrame() ?? "";
    const llama = frame.indexOf("openrouter/llama-4");
    const chat = frame.indexOf("deepseek/deepseek-chat");
    const sep = frame.indexOf("其余模型");
    expect(llama).toBeGreaterThan(-1);
    expect(llama).toBeLessThan(chat);
    expect(chat).toBeLessThan(sep);
    unmount();
  });

  it("打字自动聚焦搜索框并模糊过滤；Esc 先清搜索再关闭", async () => {
    const { lastFrame, stdin, unmount, onClose } = renderPicker();
    await pause();
    stdin.write("codex");
    await pause();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("codex");
    expect(frame).toContain("gpt-5.2-codex");
    expect(frame).not.toContain("llama-4");
    // Esc 清空搜索
    stdin.write("\x1b");
    await pause();
    expect(lastFrame()).toContain("llama-4");
    // 搜索框已空再 Esc → 关闭
    stdin.write("\x1b");
    await pause();
    expect(onClose).toHaveBeenCalled();
    unmount();
  });

  it("Enter 弹内联选项条；→ 选设为默认后 Enter 确认", async () => {
    const { stdin, unmount, onPick } = renderPicker();
    await pause();
    // 列表第一行是 recent（claude-opus），移到 deepseek-chat
    stdin.write("\x1b[B"); // ↓
    await pause();
    stdin.write("\r"); // Enter → 选项条
    await pause();
    stdin.write("\x1b[C"); // → 设为默认
    await pause();
    stdin.write("\r"); // 确认
    await pause();
    expect(onPick).toHaveBeenCalledWith("deepseek/deepseek-chat", true, null);
    unmount();
  });

  it("Enter 默认项为仅本会话", async () => {
    const { stdin, unmount, onPick } = renderPicker();
    await pause();
    stdin.write("\r"); // 第一行（recent claude-opus）→ 选项条
    await pause();
    stdin.write("\r"); // 确认仅本会话
    await pause();
    expect(onPick).toHaveBeenCalledWith("anthropic/claude-opus-4.6", false, null);
    unmount();
  });

  it("左栏 Enter 选中服务商过滤右栏；○ 预设进向导", async () => {
    const { lastFrame, stdin, unmount, onStartWizard } = renderPicker({
      initialFocus: "left",
    });
    await pause();
    // 左栏：最近使用 → 全部模型 → deepseek → openrouter
    stdin.write("\x1b[B"); // 全部模型
    await pause();
    stdin.write("\x1b[B"); // deepseek
    await pause();
    stdin.write("\r"); // Enter → 过滤为 deepseek
    await pause();
    const f1 = lastFrame() ?? "";
    expect(f1).toContain("deepseek/deepseek-chat");
    expect(f1).not.toContain("llama-4");
    // 选中服务商后焦点切到右栏；按 ← 回左栏继续移动到 ○ commandcode
    stdin.write("\x1b[D");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\r");
    await pause();
    expect(onStartWizard).toHaveBeenCalledWith("commandcode");
    unmount();
  });

  it("窄屏 <80 隐藏左栏，←/→ 循环范围", async () => {
    const { lastFrame, stdin, unmount } = renderPicker({ width: 60 });
    await pause();
    const f0 = lastFrame() ?? "";
    expect(f0).not.toContain("● deepseek"); // 左栏隐藏
    // 初始 scope=all；← 循环到 recent
    stdin.write("\x1b[D");
    await pause();
    const f1 = lastFrame() ?? "";
    expect(f1).toContain("anthropic/claude-opus-4.6");
    expect(f1).not.toContain("llama-4"); // recent 范围只有 1 个
    unmount();
  });

  it("PageDown/Home/End 长列表导航", async () => {
    const many: ModelInfo[] = Array.from({ length: 40 }, (_, i) =>
      model("p", `m${i}`, { contextWindow: 128_000 }),
    );
    const onPick = vi.fn();
    const { stdin, unmount, lastFrame } = render(
      inEnv(
        createElement(ModelPicker, {
          models: many,
          recents: [],
          providers: [{ ...(PROVIDERS[0] as ProviderOverview), id: "p" }],
          presets: [],
          current: undefined,
          defaultModel: undefined,
          wizard: undefined,
          onStartWizard: vi.fn(),
          onPick,
          onClose: vi.fn(),
          width: 100,
          height: 20,
          active: true,
        }),
      ),
    );
    await pause();
    expect(lastFrame()).toContain("1/40");
    stdin.write("\x1b[6~"); // PageDown
    await pause();
    expect(lastFrame()).toContain("13/40");
    stdin.write("\x1b[F"); // End
    await pause();
    expect(lastFrame()).toContain("m39");
    stdin.write("\x1b[H"); // Home
    await pause();
    expect(lastFrame()).toContain("1/40");
    unmount();
  });

  // ADR-0026 §5：不可用模型照常列出，行尾标注并在选中详情显示原因
  it("不可用模型照常列出：行尾「协议不支持」，选中详情显示原因", async () => {
    const { lastFrame, unmount } = renderPicker({
      models: [
        model("gw", "responses-only", {
          contextWindow: 128_000,
          unavailable: { reason: "该模型没有可用的服务协议：上游只声明了 /responses 接口" },
        }),
        model("gw", "chat-ok", { contextWindow: 128_000 }),
      ],
      providers: [
        {
          id: "gw",
          type: "openai-compatible",
          host: "gw.test",
          keySource: "credential",
          authKind: "apiKey",
          origin: "setup",
          overridden: false,
          modelCount: 2,
          managed: true,
        },
      ],
      recents: [],
    });
    await pause();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("gw/responses-only");
    expect(frame).toContain("协议不支持");
    expect(frame).toContain("没有可用的服务协议");
    // 正常模型不带标注
    const okRow = frame.split("\n").find((l) => l.includes("chat-ok")) ?? "";
    expect(okRow).not.toContain("协议不支持");
    unmount();
  });

  it("长模型名截断后仍显示不可用标注", async () => {
    const { lastFrame, unmount } = renderPicker({
      width: 80,
      models: [
        model("gw", "responses-only-with-an-especially-long-model-identifier", {
          unavailable: { reason: "仅支持 /responses" },
        }),
      ],
      providers: [
        {
          id: "gw",
          type: "openai-compatible",
          host: "gw.test",
          keySource: "credential",
          authKind: "apiKey",
          origin: "setup",
          overridden: false,
          modelCount: 1,
          managed: true,
        },
      ],
      recents: [],
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("responses-only"));
    const row = (lastFrame() ?? "").split("\n").find((line) => line.includes("responses-only"));
    expect(row).toContain("协议不支持");
    unmount();
  });
});

describe("模型选择页 PageShell 形态（ADR-0045）", () => {
  it("面包屑加序号计数，分组名「最近使用 / 其余模型」，当前/默认变成附注标签", async () => {
    const { lastFrame, unmount } = renderPicker();
    await pause();
    const frame = lastFrame() ?? "";
    expect(frame.split("\n")[0]).toMatch(/^模型\s+1\/4/);
    expect(frame).toContain("其余模型");
    expect(frame).toMatch(/deepseek\/deepseek-chat\s+R I\s+128k\s+当前/);
    expect(frame).toMatch(/openrouter\/gpt-5\.2-codex\s+R\s+400k\s+默认/);
    expect(frame).not.toMatch(/>\*d|\*d /);
    unmount();
  });

  it("→/← 与 Tab 都能切换栏；左栏 Enter 应用服务商范围并回到右栏", async () => {
    const { lastFrame, stdin, unmount } = renderPicker();
    await pause();
    stdin.write("\x1b[D");
    await pause(80);
    expect(lastFrame()).toContain("Enter 应用");
    // 左栏光标从当前范围（全部模型）开始 → 下移到 deepseek
    stdin.write("\x1b[B");
    await pause(60);
    stdin.write("\r");
    await pause(100);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Enter 选择");
    expect(frame).toContain("deepseek/deepseek-chat");
    expect(frame).not.toContain("openrouter/llama-4");
    stdin.write("\t");
    await pause(80);
    expect(lastFrame()).toContain("Enter 应用");
    unmount();
  });

  it("选中行的价格、最大输出进说明区", async () => {
    const { lastFrame, stdin, unmount } = renderPicker({ recents: [] });
    await pause();
    // 第一行即 deepseek/deepseek-chat
    const frame = lastFrame() ?? "";
    expect(frame).toContain("上下文 128k");
    expect(frame).toContain("最大输出 8k");
    expect(frame).toContain("$0.27/1.1 每 M");
    expect(frame).toContain("当前会话");
    stdin.write("\x1b[B");
    await pause(80);
    expect(lastFrame()).toContain("默认模型");
    unmount();
  });
});
