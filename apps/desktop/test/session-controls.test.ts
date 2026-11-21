import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionView, type ModelRef, type SessionView } from "@nocturne/core/protocol";
import type { RpcRuntime, RpcSession } from "@nocturne/rpc/client";

import {
  clearModelCatalogCache,
  modelGroups,
  refKey,
  useSessionControls,
} from "../src/session-controls";

type ModelInfo = Awaited<ReturnType<RpcRuntime["listModels"]>>[number];

const caps = {
  toolCalls: true,
  parallelToolCalls: true,
  reasoning: "none" as const,
  imageInput: false,
  promptCache: false,
  editTool: "edit" as const,
};

const model = (provider: string, id: string, displayName?: string): ModelInfo => ({
  ref: { provider, model: id },
  ...(displayName !== undefined ? { displayName } : {}),
  capabilities: caps,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeView(ref: ModelRef): SessionView {
  const view = createSessionView();
  view.config.model = ref;
  return view;
}

function makeSession(ref: ModelRef) {
  const setModel = vi.fn(async () => undefined);
  const session = {
    state: vi.fn(async () => ({ config: { model: ref } })),
    reasoningEffortInfo: vi.fn(async () => ({
      available: ["low", "high"],
      current: "low",
      effective: "low",
    })),
    shellInfo: vi.fn(async () => ({})),
    setModel,
  } as unknown as RpcSession;
  return { session, setModel };
}

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

  it("modelGroups 为每项填充纯字符串 icon 键（品牌或 box_3 回退）", () => {
    const groups = modelGroups(
      [model("kiro", "claude-opus-5.5"), model("group", "never-stuck")],
      [],
    );
    expect(groups[0]?.options[0]?.icon).toBe("claude-color");
    expect(groups[1]?.options[0]?.icon).toBe("box_3");
  });
});

describe("useSessionControls 模型清单缓存", () => {
  afterEach(() => {
    cleanup();
    clearModelCatalogCache();
  });

  const hydrogenRef: ModelRef = { provider: "devin", model: "gemini-4-hydrogen" };
  const sonnetRef: ModelRef = { provider: "anthropic", model: "claude-sonnet" };
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("第一次打开无缓存时先显示原始模型 ID，清单返回后更新为显示名", async () => {
    const pendingModels = deferred<ModelInfo[]>();
    const runtime = {
      listModels: vi.fn(() => pendingModels.promise),
      listRecentModels: vi.fn(async () => []),
    } as unknown as RpcRuntime;
    const { session } = makeSession(hydrogenRef);
    const view = makeView(hydrogenRef);

    const hook = renderHook(() => useSessionControls(session, runtime, view, undefined, 0, "/ws"));

    expect(hook.result.current.controls.model.label).toBe("gemini-4-hydrogen");
    expect(hook.result.current.controls.model.icon).toBe("gemini-color");
    expect(hook.result.current.controls.model.groups).toEqual([]);
    expect(hook.result.current.controls.effort.heading).toBe("思考档位（gemini-4-hydrogen）");

    pendingModels.resolve([model("devin", "gemini-4-hydrogen", "Gemini 4 Hydrogen · Devin")]);
    await flush();

    expect(hook.result.current.controls.model.label).toBe("Gemini 4 Hydrogen · Devin");
    expect(hook.result.current.controls.effort.heading).toBe(
      "思考档位（Gemini 4 Hydrogen · Devin）",
    );
  });

  it("切换会话且清单请求未返回时，标签、图标、下拉分组、档位标题与 onSelect 均使用缓存", async () => {
    const catalog = [
      model("devin", "gemini-4-hydrogen", "Gemini 4 Hydrogen · Devin"),
      model("anthropic", "claude-sonnet", "Claude Sonnet"),
    ];
    let hold = false;
    const pendingNext = deferred<ModelInfo[]>();
    const runtime = {
      listModels: vi.fn(() => (hold ? pendingNext.promise : Promise.resolve(catalog))),
      listRecentModels: vi.fn(async () => [sonnetRef]),
    } as unknown as RpcRuntime;

    const first = makeSession(hydrogenRef);
    const view1 = makeView(hydrogenRef);
    const hook = renderHook(
      ({ s, v }) => useSessionControls(s, runtime, v, undefined, 0, "/ws-a"),
      { initialProps: { s: first.session, v: view1 } },
    );
    await flush();
    expect(hook.result.current.controls.model.label).toBe("Gemini 4 Hydrogen · Devin");

    // 切到新会话，同时让 listModels 挂起不返回
    hold = true;
    const second = makeSession(hydrogenRef);
    const view2 = makeView(hydrogenRef);
    await act(async () => {
      hook.rerender({ s: second.session, v: view2 });
    });

    expect(hook.result.current.controls.model.label).toBe("Gemini 4 Hydrogen · Devin");
    expect(hook.result.current.controls.model.icon).toBe("gemini-color");
    expect(hook.result.current.controls.effort.heading).toBe(
      "思考档位（Gemini 4 Hydrogen · Devin）",
    );
    expect(hook.result.current.controls.model.groups.map((g) => g.label)).toEqual([
      "最近使用",
      "devin",
    ]);
    expect(hook.result.current.controls.model.groups[0]?.options.map((o) => o.label)).toEqual([
      "Claude Sonnet",
    ]);

    // snapshot 为 null 时选择模型也用缓存反查 info.ref
    await act(async () => {
      hook.result.current.controls.model.onSelect("anthropic/claude-sonnet");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(second.setModel).toHaveBeenCalledWith(sonnetRef);

    // 桌面端切换会话会按 key 重挂组件：新挂载首帧同样直接命中缓存
    const third = makeSession(hydrogenRef);
    const remounted = renderHook(() =>
      useSessionControls(third.session, runtime, makeView(hydrogenRef), undefined, 0, "/ws-a"),
    );
    expect(remounted.result.current.controls.model.label).toBe("Gemini 4 Hydrogen · Devin");
    expect(remounted.result.current.controls.effort.heading).toBe(
      "思考档位（Gemini 4 Hydrogen · Devin）",
    );
  });

  it("缓存按工作区区分，工作区 A 的清单不用于工作区 B，未传工作区使用固定键", async () => {
    const catalogA = [model("devin", "gemini-4-hydrogen", "Gemini A")];
    const catalogDefault = [model("devin", "gemini-4-hydrogen", "Gemini Default")];
    let hold = false;
    const runtime = {
      listModels: vi.fn((scope?: { workspaceRoot?: string }) => {
        if (hold) return deferred<ModelInfo[]>().promise;
        if (scope?.workspaceRoot === "/ws-a") return Promise.resolve(catalogA);
        if (scope === undefined) return Promise.resolve(catalogDefault);
        return Promise.resolve([]);
      }),
      listRecentModels: vi.fn(async () => []),
    } as unknown as RpcRuntime;

    const firstA = makeSession(hydrogenRef);
    const hookA = renderHook(() =>
      useSessionControls(firstA.session, runtime, makeView(hydrogenRef), undefined, 0, "/ws-a"),
    );
    await flush();
    expect(hookA.result.current.controls.model.label).toBe("Gemini A");

    const firstDefault = makeSession(hydrogenRef);
    const hookDefault = renderHook(() =>
      useSessionControls(firstDefault.session, runtime, makeView(hydrogenRef), undefined, 0),
    );
    await flush();
    expect(hookDefault.result.current.controls.model.label).toBe("Gemini Default");

    // 之后所有 listModels 请求挂起，验证工作区 B 不复用 A，未传工作区命中固定键
    hold = true;
    const sessionB = makeSession(hydrogenRef);
    const hookB = renderHook(() =>
      useSessionControls(sessionB.session, runtime, makeView(hydrogenRef), undefined, 0, "/ws-b"),
    );
    expect(hookB.result.current.controls.model.label).toBe("gemini-4-hydrogen");
    expect(hookB.result.current.controls.model.groups).toEqual([]);

    const secondDefault = makeSession(hydrogenRef);
    const hookDefault2 = renderHook(() =>
      useSessionControls(secondDefault.session, runtime, makeView(hydrogenRef), undefined, 0),
    );
    expect(hookDefault2.result.current.controls.model.label).toBe("Gemini Default");
  });

  it("providersVersion 变化后重新拉取并覆盖缓存，切会话使用新清单", async () => {
    let version = 0;
    let hold = false;
    const runtime = {
      listModels: vi.fn(() => {
        if (hold) return deferred<ModelInfo[]>().promise;
        return Promise.resolve([
          model("devin", "gemini-4-hydrogen", version === 0 ? "Gemini Old" : "Gemini New"),
        ]);
      }),
      listRecentModels: vi.fn(async () => []),
    } as unknown as RpcRuntime;

    const first = makeSession(hydrogenRef);
    const view = makeView(hydrogenRef);
    const hook = renderHook(
      ({ s, providersVersion }) =>
        useSessionControls(s, runtime, view, undefined, providersVersion, "/ws-a"),
      { initialProps: { s: first.session, providersVersion: 0 } },
    );
    await flush();
    expect(hook.result.current.controls.model.label).toBe("Gemini Old");

    version = 1;
    await act(async () => {
      hook.rerender({ s: first.session, providersVersion: 1 });
    });
    await flush();
    expect(hook.result.current.controls.model.label).toBe("Gemini New");

    hold = true;
    const second = makeSession(hydrogenRef);
    await act(async () => {
      hook.rerender({ s: second.session, providersVersion: 1 });
    });
    expect(hook.result.current.controls.model.label).toBe("Gemini New");
    expect(hook.result.current.controls.effort.heading).toBe("思考档位（Gemini New）");
  });

  it("只读观察模式（observed）切会话在清单未返回前同样使用缓存", async () => {
    let hold = false;
    const runtime = {
      listModels: vi.fn(() =>
        hold
          ? deferred<ModelInfo[]>().promise
          : Promise.resolve([model("devin", "gemini-4-hydrogen", "Gemini 4 Hydrogen · Devin")]),
      ),
      listRecentModels: vi.fn(async () => [hydrogenRef]),
    } as unknown as RpcRuntime;

    const first = makeSession(hydrogenRef);
    const view = makeView(hydrogenRef);
    const hook = renderHook(
      ({ s }) => useSessionControls(s, runtime, view, undefined, 0, "/ws-obs", false, true),
      { initialProps: { s: first.session } },
    );
    await flush();
    expect(first.session.state).not.toHaveBeenCalled();
    expect(hook.result.current.controls.model.label).toBe("Gemini 4 Hydrogen · Devin");

    hold = true;
    const second = makeSession(hydrogenRef);
    await act(async () => {
      hook.rerender({ s: second.session });
    });
    expect(second.session.state).not.toHaveBeenCalled();
    expect(hook.result.current.controls.model.label).toBe("Gemini 4 Hydrogen · Devin");
    expect(hook.result.current.controls.effort.heading).toBe(
      "思考档位（Gemini 4 Hydrogen · Devin）",
    );
    expect(hook.result.current.controls.model.groups[0]?.label).toBe("最近使用");
  });
});
