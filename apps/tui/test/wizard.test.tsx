/** Core 编排 + 对话框集成；所有网络请求由离线 fetch 桩接管。 */
import { cleanup, render } from "ink-testing-library";
import { createElement, useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelOverrideShape,
  ProviderEntryConfig,
  RuntimeConfig,
  SetupWizardDeps,
  WizardPreset,
} from "@nocturne/core";
import { WizardView } from "../src/components/wizard-view.js";
import { ModelPicker } from "../src/components/model-picker.js";
import { CursorClaimsContext } from "../src/components/input-cursor.js";
import type { CursorPoint } from "../src/cursor.js";
import { TuiEnvContext } from "../src/env.js";
import { useProviderWizard, type WizardOutcome, type WizardStart } from "../src/wizard-io.js";
import { changedFrame, providerMouse, settle } from "./provider-test-utils.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const PRESET: WizardPreset = {
  id: "deepseek",
  label: "DeepSeek",
  type: "openai-compatible",
  defaultName: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  defaultKeyEnv: "DEEPSEEK_API_KEY",
  fetchableModels: true,
};
function makeConfig(backend: "none" | "dpapi") {
  const saved: {
    entry: ProviderEntryConfig;
    opts: { key?: string; defaultModel?: string } | undefined;
  }[] = [];
  const creds: { providerId: string; key: string }[] = [];
  const config = {
    credentials: { backend: () => backend },
    base: { providers: [] as ProviderEntryConfig[] },
    saveSetupProvider: vi.fn(
      async (entry: ProviderEntryConfig, opts?: { key?: string; defaultModel?: string }) => {
        saved.push({ entry, opts });
      },
    ),
    refreshModelsDev: vi.fn(async () => undefined),
    setCredential: vi.fn(async (providerId: string, key: string) => {
      creds.push({ providerId, key });
    }),
  };
  return { config: config as unknown as RuntimeConfig, methods: config, saved, creds };
}
function makeDeps(overrides?: Partial<SetupWizardDeps>): SetupWizardDeps {
  return {
    presets: () => [PRESET],
    fetchModels: vi.fn(async () => [
      {
        id: "deepseek-chat",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        pricing: { input: 0.27, output: 1.1 },
        capabilities: { reasoning: "visible" as const, imageInput: false },
      },
      { id: "deepseek-reasoner", contextWindow: 128_000 },
    ]),
    env: () => undefined,
    ...overrides,
  };
}
function screen(
  config: RuntimeConfig,
  start: WizardStart,
  options: {
    deps?: SetupWizardDeps;
    realFetch?: boolean;
    width?: number;
    ascii?: boolean;
    title?: string;
  } = {},
) {
  const onDone = vi.fn<(o: WizardOutcome) => void>();
  const mouse = providerMouse();
  const points = new Map<symbol, CursorPoint>();
  const deps = options.realFetch ? undefined : (options.deps ?? makeDeps());
  function Probe() {
    const w = useProviderWizard(config, deps);
    const started = useRef(false);
    useEffect(() => {
      if (!started.current) {
        started.current = true;
        w.start(start, onDone);
      }
    });
    return (
      <WizardView
        title={options.title ?? "配置 DeepSeek"}
        state={w.state}
        active
        width={options.width ?? 81}
        height={24}
        onSubmit={w.submit}
        onSubmitMulti={w.submitMulti}
        onCancel={w.cancel}
        onMouseFrame={mouse.report}
      />
    );
  }
  const claims = {
    set: (id: symbol, point: CursorPoint | undefined) => {
      if (point) points.set(id, point);
      else points.delete(id);
    },
    delete: (id: symbol) => {
      points.delete(id);
    },
  };
  const ui = render(
    createElement(
      CursorClaimsContext.Provider,
      { value: claims },
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: options.ascii ?? false, animated: false } },
        createElement(Probe),
      ),
    ),
  );
  return { ...ui, onDone, mouse, points };
}
async function answer(ui: ReturnType<typeof screen>, value = "") {
  if (value) await changedFrame(ui, () => ui.stdin.write(value));
  ui.stdin.write("\r"); // 输入框回车直接提交，保留 Core 原有留空规则。
}

describe("/provider 向导对话框", () => {
  it("环境变量回退、摘要、最后一步显式保存，上游字段不变", async () => {
    const { config, saved } = makeConfig("none");
    const ui = screen(config, { kind: "add", presetId: "deepseek" });
    await settle(() => ui.lastFrame()?.includes("凭据环境变量名") === true);
    expect(ui.lastFrame()).not.toContain("名称：");
    expect(ui.lastFrame()).not.toContain("服务地址：");
    await answer(ui);
    await settle(() => ui.lastFrame()?.includes("保存配置") === true);
    expect(ui.lastFrame()).toContain("名称 deepseek • 地址");
    expect(ui.lastFrame()).toContain("[ 保存 ]");
    expect(saved).toHaveLength(0);
    ui.stdin.write("\r");
    await settle(() => ui.onDone.mock.calls.length === 1);
    expect(ui.onDone).toHaveBeenCalledWith({
      kind: "added",
      providerId: "deepseek",
      modelCount: 2,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entry).toMatchObject({
      id: "deepseek",
      baseURL: PRESET.baseURL,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      source: "upstream",
    });
    const models = saved[0]?.entry.models as Record<string, ModelOverrideShape>;
    expect(models["deepseek-chat"]?.contextWindow).toBe(128_000);
    expect(models["deepseek-chat"]?.pricing).toEqual({ input: 0.27, output: 1.1 });
    expect(saved[0]?.entry.thinking?.levels).toBeUndefined();
    expect(ui.lastFrame()).not.toContain("设为默认模型");
  });
  it("密钥只以星号回显，保存传递密钥不写入条目", async () => {
    const { config, saved } = makeConfig("dpapi");
    const ui = screen(config, { kind: "add", presetId: "deepseek" });
    await settle(() => ui.lastFrame()?.includes("API Key") === true);
    await changedFrame(ui, () => ui.stdin.write("sk-secret-123"));
    expect(ui.lastFrame()).toContain("*************");
    expect(ui.lastFrame()).not.toContain("sk-secret-123");
    await answer(ui);
    await settle(() => ui.lastFrame()?.includes("保存配置") === true);
    ui.stdin.write("\r");
    await settle(() => saved.length === 1);
    expect(saved[0]?.opts?.key).toBe("sk-secret-123");
    expect(JSON.stringify(saved[0]?.entry)).not.toContain("sk-secret-123");
  });
  it("API Key 留空仍走 Core 环境变量步骤", async () => {
    const { config } = makeConfig("dpapi");
    const ui = screen(config, { kind: "add", presetId: "deepseek" });
    await settle(() => ui.lastFrame()?.includes("直接回车改用环境变量") === true);
    await answer(ui);
    await settle(() => ui.lastFrame()?.includes("凭据环境变量名") === true);
    expect(ui.onDone).not.toHaveBeenCalled();
  });
  it("向导输入框空时不显示「跟随」，长说明折成两行保留回车提示", async () => {
    const { config } = makeConfig("dpapi");
    const ui = screen(config, { kind: "add", presetId: "deepseek" }, { width: 56 });
    await settle(() => ui.lastFrame()?.includes("API Key") === true);
    const frame = ui.lastFrame() ?? "";
    expect(frame).not.toContain("跟随");
    expect(frame.replace(/[│\s]/g, "")).toContain("直接回车改用环境变量");
  });
  it("空输入 Esc 直接取消，草稿 Esc 默认继续编辑，确认放弃才退出", async () => {
    const { config, saved } = makeConfig("none");
    const ui = screen(config, { kind: "add", presetId: "deepseek" });
    await settle(() => ui.lastFrame()?.includes("凭据环境变量名") === true);
    await changedFrame(ui, () => ui.stdin.write("DRAFT_ENV"));
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    expect(ui.lastFrame()).toContain("放弃修改？ > [继续编辑]");
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.lastFrame()).toContain("DRAFT_ENV");
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    await changedFrame(ui, () => ui.stdin.write("\x1b[C"));
    ui.stdin.write("\r");
    await settle(() => ui.onDone.mock.calls.length === 1);
    expect(ui.onDone).toHaveBeenCalledWith({ kind: "cancel" });
    expect(saved).toHaveLength(0);
    ui.unmount();
    const empty = screen(config, { kind: "add", presetId: "deepseek" });
    await settle(() => empty.lastFrame()?.includes("凭据环境变量名") === true);
    empty.stdin.write("\x1b");
    await settle(() => empty.onDone.mock.calls.length === 1);
    expect(empty.onDone).toHaveBeenCalledWith({ kind: "cancel" });
  });
  it("换密钥保存失败保留掩码和原输入，重试成功", async () => {
    const { config, methods, creds } = makeConfig("dpapi");
    methods.setCredential.mockRejectedValueOnce(new Error("credential store unavailable"));
    const ui = screen(
      config,
      { kind: "key", providerId: "deepseek" },
      { title: "换密钥 deepseek" },
    );
    await settle(() => ui.lastFrame()?.includes("新的 API Key") === true);
    expect(ui.lastFrame()).toContain("[ 保存 ]");
    await answer(ui, "new-key-456");
    await settle(() => ui.lastFrame()?.includes("credential store unavailable") === true);
    expect(ui.lastFrame()).toContain("***********");
    expect(ui.lastFrame()).not.toContain("new-key-456");
    expect(ui.onDone).not.toHaveBeenCalled();
    await answer(ui);
    await settle(() => ui.onDone.mock.calls.length === 1);
    expect(methods.setCredential).toHaveBeenNthCalledWith(1, "deepseek", "new-key-456");
    expect(creds).toEqual([{ providerId: "deepseek", key: "new-key-456" }]);
    expect(ui.onDone).toHaveBeenCalledWith({ kind: "key-updated", providerId: "deepseek" });
  });
  it("backend=none 换密钥保留环境变量提示，不调用凭据存储", async () => {
    const { config, creds } = makeConfig("none");
    const ui = screen(config, { kind: "key", providerId: "deepseek" });
    await settle(() => ui.lastFrame()?.includes("环境变量") === true);
    expect(creds).toHaveLength(0);
  });
  it("真实 fetchModels 适配只发 GET /models，不探测聊天端点", async () => {
    const requests: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET" });
        return new Response(
          JSON.stringify({ data: [{ id: "fake-model", context_length: 4096 }] }),
          { status: 200 },
        );
      }),
    );
    const { config, saved } = makeConfig("dpapi");
    const ui = screen(config, { kind: "add", presetId: "deepseek" }, { realFetch: true });
    await settle(() => ui.lastFrame()?.includes("API Key") === true);
    await answer(ui, "offline-key");
    await settle(() => ui.lastFrame()?.includes("保存配置") === true);
    ui.stdin.write("\r");
    await settle(() => saved.length === 1);
    expect(requests).toEqual([{ url: "https://api.deepseek.com/v1/models", method: "GET" }]);
    expect(saved[0]?.entry.models).toHaveProperty("fake-model");
  });
  it("GET /models 中 Esc 真正 abort 并返回上一步，晚到结果不会保存", async () => {
    let signal: AbortSignal | undefined;
    let finish: ((response: Response) => void) | undefined;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { config, saved, methods } = makeConfig("dpapi");
    const ui = screen(config, { kind: "add", presetId: "deepseek" }, { realFetch: true });
    await settle(() => ui.lastFrame()?.includes("API Key") === true);
    await answer(ui, "offline-key");
    await settle(
      () => ui.lastFrame()?.includes("正在获取模型列表") === true && signal !== undefined,
    );
    ui.stdin.write("\x1b");
    await settle(() => ui.lastFrame()?.includes("API Key：") === true && signal?.aborted === true);
    expect(ui.lastFrame()).toContain("***********");
    finish?.(new Response(JSON.stringify({ data: [{ id: "late" }] }), { status: 200 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(saved).toHaveLength(0);
    expect(ui.onDone).not.toHaveBeenCalled();
    expect(ui.lastFrame()).not.toContain("保存配置");
    expect(methods.setCredential).not.toHaveBeenCalled();
    expect(methods.saveSetupProvider).not.toHaveBeenCalled();
    expect(methods.refreshModelsDev).not.toHaveBeenCalled();
    fetch.mockImplementationOnce(
      async () => new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 }),
    );
    await answer(ui); // 重试上一步，保留的密钥再次交 Core。
    await settle(() => ui.lastFrame()?.includes("保存配置") === true);
    ui.stdin.write("\r");
    await settle(() => ui.onDone.mock.calls.length === 1);
    expect(methods.saveSetupProvider).toHaveBeenCalledTimes(1);
    expect(methods.refreshModelsDev).toHaveBeenCalledTimes(1);
    expect(methods.setCredential).not.toHaveBeenCalled();
    expect(saved[0]?.entry.models).toHaveProperty("fresh");
    expect(saved[0]?.entry.models).not.toHaveProperty("late");
  });
  it("鼠标可以点输入框、保存与取消；对话框滚轮冻结", async () => {
    const { config, creds } = makeConfig("dpapi");
    const ui = screen(config, { kind: "key", providerId: "deepseek" });
    await settle(() => ui.mouse.frame?.boxes.some((b) => b.id === "input") === true);
    await changedFrame(ui, () => ui.stdin.write("abcdef"));
    await changedFrame(ui, () => ui.mouse.click("cancel"));
    expect(ui.mouse.frame?.layer).toBe("provider-wizard-discard");
    await changedFrame(ui, () => ui.mouse.click("continue"));
    ui.mouse.click("input", 2);
    await settle(() => [...ui.points.values()][0]?.x === ui.mouse.at("input").colStart + 1);
    await changedFrame(ui, () => ui.stdin.write("Z"));
    const before = ui.lastFrame();
    ui.mouse.feed({ type: "wheel", dir: "down", x: 10, y: 10 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ui.lastFrame()).toBe(before);
    ui.mouse.click("save");
    await settle(() => creds.length === 1);
    expect(creds[0]?.key).toBe("Zabcdef");
  });
  for (const width of [80, 81])
    it(`显式定位真实光标与输入框一致，宽度 ${width}`, async () => {
      const { config } = makeConfig("dpapi");
      const ui = screen(
        config,
        { kind: "key", providerId: "deepseek" },
        { width, ascii: width === 81 },
      );
      await settle(
        () => ui.mouse.frame?.boxes.some((b) => b.id === "input") === true && ui.points.size === 1,
      );
      const box = ui.mouse.at("input");
      expect([...ui.points.values()][0]).toEqual({ x: box.colStart + 1, y: box.row - 1 - 24 });
      await changedFrame(ui, () => ui.stdin.write("abc"));
      expect([...ui.points.values()][0]).toEqual({ x: box.colStart + 4, y: box.row - 1 - 24 });
      expect(ui.lastFrame()?.split("\n").length).toBeLessThanOrEqual(24);
      if (width === 81) expect(ui.lastFrame()).toContain("+");
    });
  it("ModelPicker 旧 maxRows/offsetX/offsetY 调用保持光标位置及直接 Enter 提交", async () => {
    const submit = vi.fn();
    const points = new Map<symbol, CursorPoint>();
    const claims = {
      set: (id: symbol, point: CursorPoint | undefined) => {
        if (point) points.set(id, point);
        else points.delete(id);
      },
      delete: (id: symbol) => {
        points.delete(id);
      },
    };
    const ui = render(
      createElement(
        CursorClaimsContext.Provider,
        { value: claims },
        createElement(ModelPicker, {
          models: [],
          recents: [],
          providers: [],
          presets: [PRESET],
          current: undefined,
          defaultModel: undefined,
          wizard: {
            state: {
              running: true,
              steps: [],
              logs: [],
              prompt: { text: "API Key：", secret: true },
            },
            submit,
            submitMulti: vi.fn(),
            cancel: vi.fn(),
          },
          onStartWizard: vi.fn(),
          onPick: vi.fn(),
          onClose: vi.fn(),
          width: 101,
          height: 24,
          active: true,
        }),
      ),
    );
    await settle(() => ui.lastFrame()?.includes("API Key：") === true && points.size === 1);
    const rows = (ui.lastFrame() ?? "").split("\n");
    const inputRow = rows.findIndex((row) => row.includes("[ "));
    const inputColumn = rows[inputRow]?.indexOf("[ ") ?? -1;
    expect([...points.values()][0]).toEqual({ x: inputColumn + 2, y: inputRow - 24 });
    await changedFrame(ui, () => ui.stdin.write("legacy-key"));
    ui.stdin.write("\r");
    await settle(() => submit.mock.calls.length === 1);
    expect(submit).toHaveBeenCalledWith("legacy-key");
  });
});
