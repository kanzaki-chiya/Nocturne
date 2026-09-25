/**
 * /provider 向导弹层集成测试：useProviderWizard + WizardView 驱动
 * Core 编排（runProviderSetupWizard/runProviderKeyWizard），桩 config/deps
 * 验证：预设直达 → 各步提示 → 凭据环境变量回退 → 模型选择 → 写入调用。
 * 密钥输入回显 *，凭据不落明文（桩断言 setCredential 收到的值）。
 */
import { render } from "ink-testing-library";
import { createElement, useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelOverrideShape,
  ProviderEntryConfig,
  RuntimeConfig,
  SetupWizardDeps,
  WizardPreset,
} from "@nocturne/core";

import { WizardView } from "../src/components/wizard-view.js";
import { TuiEnvContext } from "../src/env.js";
import { useProviderWizard, type WizardOutcome, type WizardStart } from "../src/wizard-io.js";

const ENV = { ascii: false, animated: false };
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const inEnv = (child: React.ReactNode) =>
  createElement(TuiEnvContext.Provider, { value: ENV }, child);

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
  const thinking: { providerId: string; levels: unknown }[] = [];
  const config = {
    credentials: { backend: () => backend },
    base: { providers: [] as ProviderEntryConfig[] },
    saveSetupProvider: (
      entry: ProviderEntryConfig,
      opts?: { key?: string; defaultModel?: string },
    ) => {
      saved.push({ entry, opts });
      return Promise.resolve();
    },
    saveSetupThinking: (providerId: string, levels: unknown) => {
      thinking.push({ providerId, levels });
      return Promise.resolve();
    },
    setCredential: (providerId: string, key: string) => {
      creds.push({ providerId, key });
      return Promise.resolve();
    },
  } as unknown as RuntimeConfig;
  return { config: config as RuntimeConfig, saved, creds, thinking };
}

function makeDeps(overrides?: Partial<SetupWizardDeps>): SetupWizardDeps {
  return {
    presets: () => [PRESET],
    fetchModels: () =>
      Promise.resolve([
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

function Probe({
  config,
  deps,
  start,
  onDone,
}: {
  config: RuntimeConfig;
  deps: SetupWizardDeps;
  start: WizardStart;
  onDone: (o: WizardOutcome) => void;
}) {
  const w = useProviderWizard(config, deps);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    w.start(start, onDone);
  });
  return (
    <WizardView
      title="添加服务商"
      state={w.state}
      active
      width={80}
      onSubmit={w.submit}
      onSubmitMulti={w.submitMulti}
      onCancel={w.cancel}
    />
  );
}

const type = async (stdin: { write: (s: string) => void }, text: string): Promise<void> => {
  stdin.write(text);
  await pause(30);
  stdin.write("\r");
  await pause(30);
};

describe("/provider 向导弹层", () => {
  it("backend=none：环境变量回退路径 → 模型选择 → 保存（含上游字段映射）", async () => {
    const { config, saved } = makeConfig("none");
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(Probe, {
          config,
          deps: makeDeps(),
          start: { kind: "add", presetId: "deepseek" },
          onDone,
        }),
      ),
    );
    await pause();
    // 名称 [deepseek]：直接回车
    expect(lastFrame()).toContain("名称");
    await type(stdin, "");
    await pause();
    // backend=none → 直接问环境变量名
    expect(lastFrame()).toContain("凭据环境变量名");
    await type(stdin, "");
    await pause(120);
    // fetchModels 返回列表 → 编号选择
    const f = lastFrame() ?? "";
    expect(f).toContain("deepseek-chat");
    await type(stdin, "1");
    await pause();
    // 选完模型直接问"设为默认"（向导不做连接测试）
    expect(lastFrame()).toContain("设为默认模型");
    await type(stdin, "");
    await pause(120);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "added", providerId: "deepseek" }),
    );
    // saveSetupProvider 收到完整条目：上游字段映射进 models
    expect(saved).toHaveLength(1);
    const entry = saved[0]?.entry;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.id).toBe("deepseek");
    expect(entry.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    const models = entry.models as Record<string, ModelOverrideShape>;
    expect(models["deepseek-chat"]?.contextWindow).toBe(128_000);
    expect(models["deepseek-chat"]?.pricing).toEqual({ input: 0.27, output: 1.1 });
    unmount();
  });

  it("backend=dpapi：密钥输入回显 *，setCredential/setDefault 正确传递", async () => {
    const { config, saved } = makeConfig("dpapi");
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(Probe, {
          config,
          deps: makeDeps({ env: () => "sk-from-env" }),
          start: { kind: "add", presetId: "deepseek" },
          onDone,
        }),
      ),
    );
    await pause();
    await type(stdin, ""); // 名称
    await pause();
    // backend=dpapi → askSecret 密钥提示
    expect(lastFrame()).toContain("API Key");
    // 密钥逐字符输入，回显应为 * 而非明文
    stdin.write("sk-secret-123");
    await pause(60);
    const f = lastFrame() ?? "";
    expect(f).toContain("*************");
    expect(f).not.toContain("sk-secret-123");
    stdin.write("\r");
    await pause(120);
    // 模型选择
    await type(stdin, "1");
    await pause(150);
    // 选完模型直接问"设为默认"（无连接测试步骤）
    expect(lastFrame()).toContain("设为默认模型");
    await type(stdin, "");
    await pause(120);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "added", providerId: "deepseek" }),
    );
    // 密钥经 opts.key 传给 saveSetupProvider（凭据存储路径），不落 entry 明文
    expect(saved[0]?.opts?.key).toBe("sk-secret-123");
    expect(JSON.stringify(saved[0]?.entry)).not.toContain("sk-secret-123");
    unmount();
  });

  it("Esc 取消：pending ask 被 reject（WizardAbort），onDone 收到 cancel", async () => {
    const { config } = makeConfig("none");
    const onDone = vi.fn();
    const { stdin, unmount } = render(
      inEnv(
        createElement(Probe, {
          config,
          deps: makeDeps(),
          start: { kind: "add", presetId: "deepseek" },
          onDone,
        }),
      ),
    );
    await pause();
    stdin.write("\x1b"); // Esc → 取消
    await pause(80);
    expect(onDone).toHaveBeenCalledWith({ kind: "cancel" });
    unmount();
  });

  it("/provider key：dpapi 后端 → askSecret → setCredential 收到密钥", async () => {
    const { config, creds } = makeConfig("dpapi");
    const onDone = vi.fn();
    const { stdin, unmount } = render(
      inEnv(
        createElement(Probe, {
          config,
          deps: makeDeps(),
          start: { kind: "key", providerId: "deepseek" },
          onDone,
        }),
      ),
    );
    await pause();
    stdin.write("new-key-456");
    await pause(40);
    stdin.write("\r");
    await pause(120);
    expect(onDone).toHaveBeenCalledWith({ kind: "key-updated", providerId: "deepseek" });
    expect(creds).toEqual([{ providerId: "deepseek", key: "new-key-456" }]);
    unmount();
  });

  it("/provider thinking：y → 空格勾选多档 → Enter 保存 thinking.levels", async () => {
    const { config, thinking } = makeConfig("none");
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(Probe, {
          config,
          deps: makeDeps(),
          start: { kind: "thinking", providerId: "deepseek" },
          onDone,
        }),
      ),
    );
    await pause();
    // 先问"支持思考强度吗？[y/N]"
    expect(lastFrame()).toContain("支持思考强度");
    await type(stdin, "y");
    await pause(80);
    // 多选界面：六个档位 + 勾选提示
    const f = lastFrame() ?? "";
    expect(f).toContain("minimal");
    expect(f).toContain("max");
    expect(f).toContain("空格勾选");
    // ↓ → 空格勾选 low；↓ ↓ → 空格勾选 high；Enter 确认
    stdin.write("\x1b[B");
    await pause();
    stdin.write(" ");
    await pause();
    expect(lastFrame()).toContain("[x] low");
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write(" ");
    await pause();
    expect(lastFrame()).toContain("[x] high");
    stdin.write("\r");
    await pause(150);
    expect(onDone).toHaveBeenCalledWith({ kind: "thinking-updated", providerId: "deepseek" });
    expect(thinking).toEqual([{ providerId: "deepseek", levels: ["low", "high"] }]);
    unmount();
  });

  it("/provider key：backend=none 时不收密钥直接提示环境变量方式", async () => {
    const { config, creds } = makeConfig("none");
    const onDone = vi.fn();
    const { lastFrame, unmount } = render(
      inEnv(
        createElement(Probe, {
          config,
          deps: makeDeps(),
          start: { kind: "key", providerId: "deepseek" },
          onDone,
        }),
      ),
    );
    await pause(120);
    expect(lastFrame()).toContain("环境变量");
    expect(creds).toHaveLength(0);
    unmount();
  });
});
