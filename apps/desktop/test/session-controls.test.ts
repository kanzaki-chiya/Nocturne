import { describe, expect, it } from "vitest";

import type { RpcRuntime } from "@nocturne/rpc/client";

import { modelGroups, refKey } from "../src/session-controls";

type ModelInfo = Awaited<ReturnType<RpcRuntime["listModels"]>>[number];

const caps = {
  toolCalls: true,
  parallelToolCalls: true,
  reasoning: "none" as const,
  imageInput: false,
  promptCache: false,
  editTool: "edit" as const,
};

const model = (provider: string, id: string): ModelInfo => ({
  ref: { provider, model: id },
  capabilities: caps,
});

describe("modelGroups（U-06）", () => {
  it("最近使用在前，其余按服务商分组且组序为首见顺序", () => {
    const models = [
      model("anthropic", "claude-a"),
      model("openai", "gpt-a"),
      model("anthropic", "claude-b"),
      model("zhipu", "glm-a"),
      model("openai", "gpt-b"),
    ];
    const groups = modelGroups(models, [
      { provider: "openai", model: "gpt-b" },
      { provider: "anthropic", model: "claude-b" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["最近使用", "anthropic", "openai", "zhipu"]);
    expect(groups[0]?.options.map((o) => o.value)).toEqual(["openai/gpt-b", "anthropic/claude-b"]);
    // 已进最近使用的模型不再出现在服务商组里
    expect(groups[1]?.options.map((o) => o.value)).toEqual(["anthropic/claude-a"]);
    expect(groups[2]?.options.map((o) => o.value)).toEqual(["openai/gpt-a"]);
    expect(groups[3]?.options.map((o) => o.value)).toEqual(["zhipu/glm-a"]);
  });

  it("recents 引用清单外模型时跳过且不产生空组", () => {
    const groups = modelGroups(
      [model("p1", "m1")],
      [
        { provider: "ghost", model: "gone" },
        { provider: "p1", model: "m1" },
      ],
    );
    expect(groups.map((g) => g.label)).toEqual(["最近使用"]);
  });

  it("没有最近使用时只有服务商组", () => {
    const groups = modelGroups([model("b", "m2"), model("a", "m1")], []);
    expect(groups.map((g) => g.label)).toEqual(["b", "a"]);
  });

  it("refKey 与菜单 value 一致（选择回传可反查模型）", () => {
    expect(refKey({ provider: "p", model: "m" })).toBe("p/m");
  });
});
