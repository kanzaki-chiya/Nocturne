/**
 * /provider model 行式问答（ADR-0024 第 4 节）：只依赖 Core 的 listModelSettings /
 * saveModelSettings，脚本化的输入原语代替真实终端。
 */
import { describe, expect, it } from "vitest";

import type {
  ModelField,
  ModelSettingsPatch,
  ModelSettingsView,
  ReasoningEffortLevel,
  RuntimeConfig,
} from "@nocturne/core";

import { runProviderModelWizard } from "../src/model-wizard.js";

type Prompts = Parameters<typeof runProviderModelWizard>[0];

/** 脚本化输入：answers 依次应答 ask；print 记入 printed */
function scriptedIo(answers: string[]): { io: Prompts; printed: string[] } {
  const printed: string[] = [];
  const queue = [...answers];
  return {
    printed,
    io: {
      ask: (prompt) => {
        printed.push(prompt);
        const a = queue.shift();
        return a === undefined ? Promise.reject(new Error("脚本输入耗尽")) : Promise.resolve(a);
      },
      print: (text) => printed.push(text),
    },
  };
}

describe("runProviderModelWizard", () => {
  const field = <T>(
    value: T,
    source: ModelSettingsView["fields"]["displayName"]["source"],
    editable = true,
    userValue?: T,
  ): ModelField<T> => ({
    value,
    source,
    editable,
    ...(userValue !== undefined ? { userValue } : {}),
  });

  const baseView = (over?: Partial<ModelSettingsView["fields"]>): ModelSettingsView => ({
    providerId: "corp",
    modelId: "m1",
    readonly: false,
    fields: {
      displayName: field<string | undefined>(undefined, { kind: "upstream" }),
      contextWindow: field<number | undefined>(100_000, { kind: "upstream" }),
      maxOutputTokens: field<number | undefined>(8_000, { kind: "upstream" }),
      reasoning: field<"none" | "hidden" | "visible">("visible", { kind: "upstream" }),
      imageInput: field<boolean | undefined>(false, { kind: "default" }),
      reasoningEffort: field<("low" | "high")[] | undefined>(["low", "high"], {
        kind: "derived",
      }),
      protocol: field<"openai-compatible" | "anthropic" | undefined>("openai-compatible", {
        kind: "entryType",
      }),
      editTool: field<"edit" | "apply_patch" | undefined>("edit", { kind: "default" }),
      ...over,
    } as ModelSettingsView["fields"],
  });

  const makeConfig = (views: ModelSettingsView[]) => {
    const saved: { p: string; m: string; patch: ModelSettingsPatch }[] = [];
    const config = {
      listModelSettings: async () => views,
      saveModelSettings: async (p: string, m: string, patch: ModelSettingsPatch) => {
        saved.push({ p, m, patch });
      },
    } as unknown as RuntimeConfig;
    return { config, saved };
  };

  it("回车保留：patch 为空对象；打印当前值（来源）与「已保存」", async () => {
    const { config, saved } = makeConfig([baseView()]);
    const { io, printed } = scriptedIo(["", "", "", "", "", "", "", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(saved).toEqual([{ p: "corp", m: "m1", patch: {} }]);
    expect(printed.some((l) => l.includes("100000") && l.includes("上游"))).toBe(true);
    expect(printed.at(-1)).toContain("已保存 corp/m1");
  });

  it("正常值解析：正整数 / y / 逗号档位 / none=空数组 / patch=apply_patch", async () => {
    const { config, saved } = makeConfig([baseView()]);
    const { io } = scriptedIo(["命名", "128000", "4096", "y", "y", "low,high", "", "patch"]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(saved[0]?.patch).toEqual({
      displayName: "命名",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      reasoning: "visible",
      imageInput: true,
      reasoningEffort: ["low", "high"],
      editTool: "apply_patch",
    });
    const { config: c2, saved: s2 } = makeConfig([baseView()]);
    const { io: io2 } = scriptedIo(["", "", "", "", "", "none", "", ""]);
    await runProviderModelWizard(io2, c2, "corp", "m1");
    expect(s2[0]?.patch).toEqual({ reasoningEffort: [] });
  });

  it("协议输入 chat / messages / responses 分别映射为三种协议", async () => {
    for (const [input, protocol] of [
      ["chat", "openai-compatible"],
      ["messages", "anthropic"],
      ["responses", "openai-responses"],
    ] as const) {
      const { config, saved } = makeConfig([baseView()]);
      const { io } = scriptedIo(["", "", "", "", "", "", input, ""]);
      await runProviderModelWizard(io, config, "corp", "m1");
      expect(saved[0]?.patch).toEqual({ protocol });
    }
  });

  it("「-」清除用户编辑 → patch 写 null", async () => {
    const { config, saved } = makeConfig([baseView()]);
    const { io } = scriptedIo(["-", "-", "", "", "", "", "", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(saved[0]?.patch).toEqual({ displayName: null, contextWindow: null });
  });

  it("config 来源的只读字段只显示不提问", async () => {
    const view = baseView({
      contextWindow: field<number>(
        42_000,
        { kind: "config", layer: "user", path: "/tmp/config.json" },
        false,
      ),
    });
    const { config } = makeConfig([view]);
    let asks = 0;
    const { io, printed } = scriptedIo(["", "", "", "", "", "", ""]);
    const spyIo: Prompts = { ...io, ask: async (p, o) => ((asks += 1), io.ask(p, o)) };
    await runProviderModelWizard(spyIo, config, "corp", "m1");
    // 8 字段中 contextWindow 只读 → 只问 7 次；显示行含「由 … 决定」
    expect(asks).toBe(7);
    expect(
      printed.some((l) => l.includes("上下文长度") && l.includes("由 /tmp/config.json 决定")),
    ).toBe(true);
  });

  it("推理为否时隐藏档位行", async () => {
    const view = baseView({
      reasoning: field<"none" | "hidden" | "visible">("none", { kind: "user" }, true, "none"),
      reasoningEffort: field<ReasoningEffortLevel[]>([], { kind: "default" }, false),
    });
    const { config } = makeConfig([view]);
    let asks = 0;
    const { io, printed } = scriptedIo(["", "", "", "", "", "", ""]);
    const spyIo: Prompts = { ...io, ask: async (p, o) => ((asks += 1), io.ask(p, o)) };
    await runProviderModelWizard(spyIo, config, "corp", "m1");
    expect(asks).toBe(7);
    expect(printed.some((l) => l.includes("思考档位"))).toBe(false);
  });

  it("保存失败打印原因不保存；无效输入不写文件", async () => {
    const view = baseView();
    const config = {
      listModelSettings: async () => [view],
      saveModelSettings: async () => {
        throw new Error("最大输出超过上下文长度");
      },
    } as unknown as RuntimeConfig;
    const { io, printed } = scriptedIo(["", "", "", "", "", "", "", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(printed.some((l) => l.includes("保存失败") && l.includes("最大输出"))).toBe(true);

    const { config: c2, saved: s2 } = makeConfig([view]);
    const { io: io2, printed: p2 } = scriptedIo(["", "abc"]);
    await runProviderModelWizard(io2, c2, "corp", "m1");
    expect(s2).toHaveLength(0);
    expect(p2.some((l) => l.includes("无效"))).toBe(true);
  });

  it("只读服务商：逐行显示字段与 hint，不提问不保存", async () => {
    const view: ModelSettingsView = {
      ...baseView(),
      readonly: true,
      readonlyHint: "服务商 corp 定义在 /tmp/config.json，请编辑该处配置",
    };
    const { config, saved } = makeConfig([view]);
    let asks = 0;
    const { io, printed } = scriptedIo([]);
    const spyIo: Prompts = { ...io, ask: async (p, o) => ((asks += 1), io.ask(p, o)) };
    await runProviderModelWizard(spyIo, config, "corp", "m1");
    expect(asks).toBe(0);
    expect(saved).toHaveLength(0);
    expect(printed.some((l) => l.includes("请编辑该处配置"))).toBe(true);
  });

  it("模型不在清单 → 提示且不提问", async () => {
    const { config } = makeConfig([baseView()]);
    const { io, printed } = scriptedIo([]);
    await runProviderModelWizard(io, config, "corp", "ghost");
    expect(printed.some((l) => l.includes('"ghost" 不在'))).toBe(true);
  });
});
