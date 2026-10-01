/**
 * 模型设置编辑测试（ADR-0024）：providers.json userModels 合成层、
 * models 逐字段合并与推理 none 规则、listModelSettings 来源标注、
 * saveModelSettings 校验与原子写、配置警告到达会话。
 * 全部在临时目录中运行，不写真实用户目录。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultEditToolForModel, loadConfig } from "../src/config/index.js";
import { createRuntime } from "../src/index.js";
import { createPlatform, type Platform } from "../src/platform/index.js";
import { FakeProvider } from "../src/provider/index.js";

let root: string;
let home: string;
let workspace: string;
let platform: Platform;

const noEnv = (_n: string) => undefined;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-ms-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  platform = createPlatform();
});

beforeEach(async () => {
  for (const f of ["providers.json", "config.json", "trust.json"]) {
    await fs.rm(path.join(home, f), { force: true });
  }
  await fs.rm(path.join(workspace, ".nocturne"), { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const load = (env: (n: string) => string | undefined = noEnv) =>
  loadConfig(platform, { nocturneHome: home, env });

async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(data)}\n`);
}

const readJson = async (p: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(p, "utf8")) as unknown;

const providersPath = () => path.join(home, "providers.json");
const configPath = () => path.join(home, "config.json");
const projectPath = () => path.join(workspace, ".nocturne", "config.json");

/** 基础服务商条目：上游声明全套字段便于观察逐字段继承 */
const ENTRY = {
  id: "corp",
  type: "openai-compatible",
  baseURL: "https://api.corp.test/v1",
  models: {
    m1: {
      displayName: "Model One",
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      capabilities: {
        reasoning: "visible",
        imageInput: true,
        reasoningEffort: ["low", "medium", "high"],
      },
    },
  },
};

async function writeProviders(providers: unknown[], extra?: Record<string, unknown>) {
  await writeJson(providersPath(), { version: 1, providers, ...extra });
}

const mergedModel = async (modelId = "m1") => {
  const rc = await load();
  return rc.base.providers.find((p) => p.id === "corp")?.models?.[modelId];
};

// ── models 逐字段合并（ADR-0024 第 2 节）────────────────

describe("models 逐字段合并", () => {
  it("config.json 只写 contextWindow：其余字段从上游条目继承", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { contextWindow: 42_000 } },
        },
      ],
    });
    const m = await mergedModel();
    expect(m?.contextWindow).toBe(42_000);
    expect(m?.displayName).toBe("Model One");
    expect(m?.maxOutputTokens).toBe(8_000);
    expect(m?.capabilities?.reasoning).toBe("visible");
    expect(m?.capabilities?.imageInput).toBe(true);
    expect(m?.capabilities?.reasoningEffort).toEqual(["low", "medium", "high"]);
  });

  it("reasoningEffort 数组由高层整体替换：手写 [high] 不并集", async () => {
    await writeProviders([
      {
        ...ENTRY,
        userModels: { m1: { capabilities: { reasoningEffort: ["minimal", "low"] } } },
      },
    ]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { capabilities: { reasoningEffort: ["high"] } } },
        },
      ],
    });
    expect((await mergedModel())?.capabilities?.reasoningEffort).toEqual(["high"]);
    // 显式空数组同样整体生效（reasoning 为 visible，不触发 none 锁定）
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { capabilities: { reasoningEffort: [] } } },
        },
      ],
    });
    expect((await mergedModel())?.capabilities?.reasoningEffort).toEqual([]);
  });

  it("userModels 层：优先于上游、低于手写配置", async () => {
    await writeProviders([{ ...ENTRY, userModels: { m1: { contextWindow: 60_000 } } }]);
    expect((await mergedModel())?.contextWindow).toBe(60_000);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { contextWindow: 42_000 } },
        },
      ],
    });
    expect((await mergedModel())?.contextWindow).toBe(42_000);
  });

  it("userModels 引用清单外模型：不新增条目", async () => {
    await writeProviders([{ ...ENTRY, userModels: { ghost: { contextWindow: 9_999 } } }]);
    const rc = await load();
    const corp = rc.base.providers.find((p) => p.id === "corp");
    expect(corp?.models?.ghost).toBeUndefined();
    expect(corp?.models?.m1).toBeDefined();
  });

  it("上游删除模型后：userModels 条目保留在 providers.json 且不报错", async () => {
    await writeProviders([
      { ...ENTRY, userModels: { m1: { contextWindow: 60_000 }, gone: { contextWindow: 1 } } },
    ]);
    const raw = (await readJson(providersPath())) as {
      providers: { id: string; models?: unknown; userModels?: unknown }[];
    };
    // 模拟 refresh 整换 models：去掉 gone 与 m1，只留 m2
    const corp = raw.providers[0];
    await writeProviders([{ ...corp, models: { m2: { contextWindow: 5_000 } } }]);
    const rc = await load();
    const merged = rc.base.providers.find((p) => p.id === "corp");
    expect(merged?.models?.m2).toBeDefined();
    expect(merged?.models?.m1).toBeUndefined();
    expect(merged?.models?.gone).toBeUndefined();
    // userModels 数据本体仍在文件里（下次模型回来仍可生效）
    const after = (await readJson(providersPath())) as {
      providers: { id: string; userModels?: Record<string, unknown> }[];
    };
    expect(Object.keys(after.providers[0]?.userModels ?? {}).sort()).toEqual(["gone", "m1"]);
  });

  it("未信任项目配置的模型字段不生效", async () => {
    await writeProviders([ENTRY]);
    await writeJson(projectPath(), {
      providers: [
        { id: "corp", baseURL: "https://api.corp.test/v1", models: { m1: { contextWindow: 1 } } },
      ],
    });
    const rc = await load();
    const ws = await rc.forWorkspace(workspace);
    expect(ws.resolved.providers.find((p) => p.id === "corp")?.models?.m1?.contextWindow).toBe(
      100_000,
    );
  });
});

// ── 推理 none 规则 ─────────────────────────────────────

describe("推理 none", () => {
  it("userModels reasoning=none：档位锁为空数组", async () => {
    await writeProviders([
      {
        ...ENTRY,
        userModels: {
          m1: { capabilities: { reasoning: "none", reasoningEffort: ["low", "high"] } },
        },
      },
    ]);
    const m = await mergedModel();
    expect(m?.capabilities?.reasoning).toBe("none");
    expect(m?.capabilities?.reasoningEffort).toEqual(["low", "high"]);
  });

  it("config.json reasoning=none：保留声明供诊断，运行时无档位", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: {
            m1: { capabilities: { reasoning: "none", reasoningEffort: ["low", "high"] } },
          },
        },
      ],
    });
    const m = await mergedModel();
    expect(m?.capabilities?.reasoningEffort).toEqual(["low", "high"]);
  });

  it("user none + 手写非空档位：保留手写档位并警告（含服务商/模型/文件）", async () => {
    await writeProviders([
      { ...ENTRY, userModels: { m1: { capabilities: { reasoning: "none" } } } },
    ]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { capabilities: { reasoningEffort: ["low", "high"] } } },
        },
      ],
    });
    const rc = await load();
    const m = rc.base.providers.find((p) => p.id === "corp")?.models?.m1;
    expect(m?.capabilities?.reasoningEffort).toEqual(["low", "high"]);
    expect(rc.base.warnings.some((x) => x.includes("用户编辑") && x.includes("corp"))).toBe(false);
  });

  it("config none + config 非空档位：保留声明并警告（含文件/服务商/模型）", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: {
            m1: { capabilities: { reasoning: "none", reasoningEffort: ["low", "high"] } },
          },
        },
      ],
    });
    const rc = await load();
    const m = rc.base.providers.find((p) => p.id === "corp")?.models?.m1;
    expect(m?.capabilities?.reasoningEffort).toEqual(["low", "high"]);
    const w = rc.base.warnings.find((x) => x.includes("推理为 none 却声明了思考档位"));
    expect(w).toBeDefined();
    expect(w).toContain(configPath());
    expect(w).toContain("corp");
    expect(w).toContain("m1");
  });

  it("旧服务商级 thinking.levels 不生效", async () => {
    await writeProviders([
      {
        ...ENTRY,
        thinking: { levels: ["low", "high"], source: "user" },
        models: { m1: { contextWindow: 1_000 } },
      },
    ]);
    const rc = await load();
    const views = await rc.listModelSettings("corp");
    const v = views.find((x) => x.modelId === "m1");
    expect(v?.fields.reasoning.value).toBe("none");
    expect(v?.fields.reasoning.source.kind).toBe("default");
    expect(v?.fields.reasoningEffort.value).toBeUndefined();
    expect(v?.fields.reasoningEffort.source.kind).toBe("default");
    expect(v?.fields.reasoningEffort.editable).toBe(false);
  });
});

// ── listModelSettings：来源与可编辑性 ────────────────────

describe("listModelSettings 来源标注", () => {
  it("upstream / user / default / derived", async () => {
    await writeProviders([
      {
        ...ENTRY,
        thinking: { levels: ["minimal", "low"], source: "user" },
        userModels: { m1: { contextWindow: 60_000 } },
        models: {
          m1: {
            displayName: "Model One",
            contextWindow: 100_000,
            capabilities: { reasoning: "visible" },
          },
          m2: { contextWindow: 50_000, capabilities: { reasoning: "hidden" } },
        },
      },
      // derived 由逐模型推理能力推导
      {
        id: "drv",
        type: "openai-compatible",
        baseURL: "https://api.drv.test/v1",
        models: { d1: { capabilities: { reasoning: "visible" } } },
      },
    ]);
    const rc = await load();
    const views = await rc.listModelSettings("corp");
    const v1 = views.find((x) => x.modelId === "m1");
    const v2 = views.find((x) => x.modelId === "m2");
    // upstream：上游声明
    expect(v1?.fields.displayName.source.kind).toBe("upstream");
    expect(v1?.fields.displayName.value).toBe("Model One");
    // user：用户编辑 + userValue/lowerValue
    expect(v1?.fields.contextWindow.source.kind).toBe("user");
    expect(v1?.fields.contextWindow.value).toBe(60_000);
    expect(v1?.fields.contextWindow.userValue).toBe(60_000);
    expect(v1?.fields.contextWindow.lowerValue).toBe(100_000);
    // default：无声明的 imageInput=false、maxOutputTokens=undefined
    expect(v1?.fields.imageInput.value).toBe(false);
    expect(v1?.fields.imageInput.source.kind).toBe("default");
    expect(v1?.fields.maxOutputTokens.value).toBeUndefined();
    expect(v1?.fields.maxOutputTokens.source.kind).toBe("default");
    // derived：reasoning≠none 且无任何档位声明 → 全档
    const dv = (await rc.listModelSettings("drv")).find((x) => x.modelId === "d1");
    expect(dv?.fields.reasoningEffort.source.kind).toBe("derived");
    expect(dv?.fields.reasoningEffort.value).toHaveLength(6);
    expect(v1?.fields.reasoningEffort.source.kind).toBe("derived");
    expect(v2?.fields.reasoningEffort.source.kind).toBe("derived");
    expect(v2?.fields.reasoningEffort.value).toHaveLength(6);
    // 列表按模型 id 排序且只含清单内模型
    expect(views.map((x) => x.modelId)).toEqual(["m1", "m2"]);
    expect(views.every((x) => x.readonly === false)).toBe(true);
  });

  it("config（user 层）来源的字段不可编辑", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { contextWindow: 42_000 } },
        },
      ],
    });
    const rc = await load();
    const v = (await rc.listModelSettings("corp")).find((x) => x.modelId === "m1");
    const f = v?.fields.contextWindow;
    expect(f?.value).toBe(42_000);
    expect(f?.source).toEqual({ kind: "config", layer: "user", path: configPath() });
    expect(f?.editable).toBe(false);
    // 同模型的其他字段仍可编辑
    expect(v?.fields.displayName.editable).toBe(true);
  });

  it("config（project 层）来源的字段不可编辑", async () => {
    await writeProviders([ENTRY]);
    await writeJson(projectPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { contextWindow: 7_000 } },
        },
      ],
    });
    const rc = await load();
    await rc.setWorkspaceTrusted(workspace, true);
    const v = (await rc.listModelSettings("corp", workspace)).find((x) => x.modelId === "m1");
    const f = v?.fields.contextWindow;
    expect(f?.value).toBe(7_000);
    expect(f?.source.kind).toBe("config");
    if (f?.source.kind === "config") {
      expect(f.source.layer).toBe("project");
      expect(f.source.path).toContain("config.json");
    }
    expect(f?.editable).toBe(false);
  });

  it("builtin 来源：内置目录给出、无任何层声明的字段", async () => {
    await writeProviders([
      {
        id: "deepseek",
        type: "openai-compatible",
        baseURL: "https://api.deepseek.test/v1",
        models: { "internal-test-model": { capabilities: { reasoning: "visible" } } },
      },
    ]);
    const rc = await loadConfig(platform, {
      nocturneHome: home,
      env: noEnv,
      builtinModel: (pid, mid) =>
        pid === "deepseek" && mid === "internal-test-model"
          ? { contextWindow: 64_000, capabilities: { imageInput: false } }
          : undefined,
    });
    const v = (await rc.listModelSettings("deepseek")).find(
      (x) => x.modelId === "internal-test-model",
    );
    expect(v?.fields.contextWindow.value).toBe(64_000);
    expect(v?.fields.contextWindow.source.kind).toBe("builtin");
    expect(v?.fields.imageInput.source.kind).toBe("builtin");
    // reasoning 仍由上游声明
    expect(v?.fields.reasoning.source.kind).toBe("upstream");
  });

  it("推理为 none 时没有档位", async () => {
    await writeProviders([
      { ...ENTRY, userModels: { m1: { capabilities: { reasoning: "none" } } } },
    ]);
    const rc = await load();
    const v = (await rc.listModelSettings("corp")).find((x) => x.modelId === "m1");
    expect(v?.fields.reasoning.value).toBe("none");
    expect(v?.fields.reasoning.source.kind).toBe("user");
    expect(v?.fields.reasoningEffort.value).toBeUndefined();
    expect(v?.fields.reasoningEffort.editable).toBe(false);
  });

  it("整个服务商不在 providers.json：readonly + hint", async () => {
    await writeJson(configPath(), {
      providers: [
        { id: "cfg", baseURL: "https://api.cfg.test/v1", models: { m1: { contextWindow: 1_000 } } },
      ],
    });
    const rc = await load();
    const views = await rc.listModelSettings("cfg");
    const v = views.find((x) => x.modelId === "m1");
    expect(v?.readonly).toBe(true);
    expect(v?.readonlyHint).toContain(configPath());
    expect(v?.fields.contextWindow.editable).toBe(false);
  });

  // ADR-0026 §2/§7：第七个字段「协议」——无声明回落条目 type（entryType 来源）
  it("协议：无任何声明时来源 entryType、取条目 type", async () => {
    await writeProviders([ENTRY]);
    const rc = await load();
    const v = (await rc.listModelSettings("corp")).find((x) => x.modelId === "m1");
    expect(v?.fields.protocol.value).toBe("openai-compatible");
    expect(v?.fields.protocol.source.kind).toBe("entryType");
    expect(v?.fields.protocol.editable).toBe(true);
    expect(v?.unavailable).toBeUndefined();
  });

  it("协议：endpoints 推导 → 上游/接口声明来源；/responses → openai-responses；无法识别 → unavailable", async () => {
    await writeProviders([
      {
        ...ENTRY,
        models: {
          m1: { endpoints: ["/messages"] },
          m2: { endpoints: ["/responses"] },
          m4: { endpoints: ["/embeddings"] },
        },
      },
    ]);
    // 手写层声明 endpoints → 协议值按接口声明推导（derived 来源）
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m3: { endpoints: ["/v1/chat/completions/"] } },
        },
      ],
    });
    const rc = await load();
    const views = await rc.listModelSettings("corp");
    const v1 = views.find((x) => x.modelId === "m1");
    const v2 = views.find((x) => x.modelId === "m2");
    const v3 = views.find((x) => x.modelId === "m3");
    const v4 = views.find((x) => x.modelId === "m4");
    // 条目 type=openai-compatible 但模型只有 /messages → 推导为 anthropic；
    // endpoints 由上游（providers.json refresh 位）声明 → upstream 来源
    expect(v1?.fields.protocol.value).toBe("anthropic");
    expect(v1?.fields.protocol.source.kind).toBe("upstream");
    // 只有 /responses → openai-responses（ADR-0031 §1），照常可用
    expect(v2?.fields.protocol.value).toBe("openai-responses");
    expect(v2?.fields.protocol.source.kind).toBe("upstream");
    expect(v2?.unavailable).toBeUndefined();
    // 无可识别接口：模型照常列出，视图带 unavailable 原因
    expect(v4?.fields.protocol.value).toBeUndefined();
    expect(v4?.unavailable?.reason).toContain("没有可用的服务协议");
    // 路径末尾归一化：/v1/chat/completions/ ≡ /chat/completions；
    // 手写层声明的 endpoints → 按接口声明推导
    expect(v3?.fields.protocol.value).toBe("openai-compatible");
    expect(v3?.fields.protocol.source.kind).toBe("derived");
  });

  it("协议：userModels 编辑 → user 来源；手写 config 声明 → config 来源只读", async () => {
    await writeProviders([
      {
        ...ENTRY,
        userModels: { m1: { protocol: "anthropic" } },
        models: { m1: { endpoints: ["/chat/completions"] }, m2: {} },
      },
    ]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m2: { protocol: "anthropic" } },
        },
      ],
    });
    const rc = await load();
    const views = await rc.listModelSettings("corp");
    const v1 = views.find((x) => x.modelId === "m1");
    const v2 = views.find((x) => x.modelId === "m2");
    // userModels.protocol 压过 endpoints 推导（ADR-0026 §2 优先级）
    expect(v1?.fields.protocol.value).toBe("anthropic");
    expect(v1?.fields.protocol.source.kind).toBe("user");
    expect(v1?.fields.protocol.userValue).toBe("anthropic");
    // 手写 models.<id>.protocol → config 来源、只读
    expect(v2?.fields.protocol.value).toBe("anthropic");
    expect(v2?.fields.protocol.source.kind).toBe("config");
    expect(v2?.fields.protocol.editable).toBe(false);
  });
});

// ── 编辑工具字段（ADR-0035 §5）───────────────────────────

describe("编辑工具字段（ADR-0035 §5）", () => {
  it("默认表：模型 id 末段含 gpt/codex → apply_patch，其余 → edit", async () => {
    // 函数本身：最后一段、不区分大小写
    expect(defaultEditToolForModel("openai/gpt-5-codex")).toBe("apply_patch");
    expect(defaultEditToolForModel("gpt-6.1-sol")).toBe("apply_patch");
    expect(defaultEditToolForModel("gpt-6-astra")).toBe("apply_patch");
    expect(defaultEditToolForModel("GPT-4.1")).toBe("apply_patch");
    expect(defaultEditToolForModel("codex-mini")).toBe("apply_patch");
    expect(defaultEditToolForModel("claude-sonnet-4")).toBe("edit");
    expect(defaultEditToolForModel("deepseek-v3.2")).toBe("edit");
    expect(defaultEditToolForModel("qwen3-coder")).toBe("edit");

    await writeProviders([
      {
        ...ENTRY,
        models: {
          "gpt-6.1-sol": { contextWindow: 100_000 },
          "codex-mini": { contextWindow: 100_000 },
          m1: ENTRY.models.m1,
        },
      },
    ]);
    const rc = await load();
    const views = await rc.listModelSettings("corp");
    const at = (id: string) => views.find((v) => v.modelId === id)?.fields.editTool;
    expect(at("gpt-6.1-sol")).toMatchObject({ value: "apply_patch" });
    expect(at("gpt-6.1-sol")?.source.kind).toBe("default");
    expect(at("codex-mini")?.value).toBe("apply_patch");
    expect(at("m1")?.value).toBe("edit");
  });

  it("手写 config capabilities.editTool 覆盖默认表；config 来源只读", async () => {
    await writeProviders([
      { ...ENTRY, models: { "gpt-6.1-sol": { contextWindow: 100_000 }, m1: ENTRY.models.m1 } },
    ]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { "gpt-6.1-sol": { capabilities: { editTool: "edit" } } },
        },
      ],
    });
    const rc = await load();
    const v = (await rc.listModelSettings("corp")).find((x) => x.modelId === "gpt-6.1-sol");
    const f = v?.fields.editTool;
    expect(f?.value).toBe("edit");
    expect(f?.source.kind).toBe("config");
    expect(f?.editable).toBe(false);
    // patch 触及 config 来源字段被拒绝
    await expect(
      rc.saveModelSettings("corp", "gpt-6.1-sol", { editTool: "apply_patch" }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("userModels 覆盖默认表：保存写 capabilities.editTool，清除回落默认表", async () => {
    await writeProviders([
      { ...ENTRY, models: { "gpt-6.1-sol": { contextWindow: 100_000 }, m1: ENTRY.models.m1 } },
    ]);
    const rc = await load();
    // m1 默认 edit → 用户改 apply_patch
    await rc.saveModelSettings("corp", "m1", { editTool: "apply_patch" });
    let raw = (await readJson(providersPath())) as {
      providers: {
        id: string;
        userModels?: Record<string, { capabilities?: Record<string, unknown> }>;
      }[];
    };
    expect(raw.providers[0]?.userModels?.m1).toEqual({
      capabilities: { editTool: "apply_patch" },
    });
    let v = (await rc.listModelSettings("corp")).find((x) => x.modelId === "m1");
    expect(v?.fields.editTool.value).toBe("apply_patch");
    expect(v?.fields.editTool.source.kind).toBe("user");
    // 清除 → 回落默认表（m1 → edit）
    await rc.saveModelSettings("corp", "m1", { editTool: null });
    raw = (await readJson(providersPath())) as typeof raw;
    expect(raw.providers[0]?.userModels).toBeUndefined();
    v = (await rc.listModelSettings("corp")).find((x) => x.modelId === "m1");
    expect(v?.fields.editTool.value).toBe("edit");
    expect(v?.fields.editTool.source.kind).toBe("default");
    // 非法值拒绝
    await expect(
      rc.saveModelSettings("corp", "m1", { editTool: "sed" } as never),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });
});

// ── saveModelSettings ──────────────────────────────────

describe("saveModelSettings", () => {
  const bytes = async () => fs.readFile(providersPath(), "utf8");

  it("服务商不在 providers.json：拒绝且不写文件", async () => {
    await writeProviders([ENTRY]);
    const rc = await load();
    await expect(rc.saveModelSettings("absent", "m1", { contextWindow: 1 })).rejects.toMatchObject({
      code: "config_invalid",
    });
    // 仅在 config.json 定义的服务商同样拒绝（hint 指向该文件）
    await writeJson(configPath(), {
      providers: [{ id: "cfg", baseURL: "https://api.corp.test/v1", models: { m1: {} } }],
    });
    await expect(rc.saveModelSettings("cfg", "m1", { contextWindow: 1 })).rejects.toMatchObject({
      code: "config_invalid",
    });
  });

  it("模型不在清单：拒绝", async () => {
    await writeProviders([ENTRY]);
    const rc = await load();
    await expect(rc.saveModelSettings("corp", "ghost", { contextWindow: 1 })).rejects.toMatchObject(
      { code: "config_invalid", message: expect.stringContaining("ghost") },
    );
  });

  it("patch 触及 config 来源字段：拒绝且 providers.json 字节不变", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { contextWindow: 42_000 } },
        },
      ],
    });
    const before = await bytes();
    const rc = await load();
    await expect(
      rc.saveModelSettings("corp", "m1", { contextWindow: 60_000 }),
    ).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("config.json"),
    });
    expect(await bytes()).toBe(before);
  });

  it("非正整数与非整数：拒绝", async () => {
    await writeProviders([ENTRY]);
    const rc = await load();
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      await expect(
        rc.saveModelSettings("corp", "m1", { contextWindow: bad }),
      ).rejects.toMatchObject({ code: "config_invalid" });
    }
  });

  it("按最终生效值比较：上下文来自上游，用户改最大输出超过它 → 拒绝", async () => {
    await writeProviders([ENTRY]); // contextWindow 100_000（上游）
    const before = await bytes();
    const rc = await load();
    await expect(
      rc.saveModelSettings("corp", "m1", { maxOutputTokens: 200_000 }),
    ).rejects.toMatchObject({ code: "config_invalid" });
    expect(await bytes()).toBe(before);
  });

  it("用户把推理设为 none 而生效档位来自 config 且非空：拒绝", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { capabilities: { reasoningEffort: ["low", "high"] } } },
        },
      ],
    });
    const rc = await load();
    await expect(rc.saveModelSettings("corp", "m1", { reasoning: "none" })).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("不能把推理设为 none"),
    });
  });

  it("生效推理为 none（user 来源）时保存非空用户档位：拒绝", async () => {
    await writeProviders([
      { ...ENTRY, userModels: { m1: { capabilities: { reasoning: "none" } } } },
    ]);
    const before = await bytes();
    const rc = await load();
    await expect(
      rc.saveModelSettings("corp", "m1", { reasoningEffort: ["low"] }),
    ).rejects.toMatchObject({ code: "config_invalid" });
    expect(await bytes()).toBe(before);
  });

  it("正常保存写 userModels；清除值回落到下层；空条目删除", async () => {
    await writeProviders([ENTRY]);
    const cfgBefore = await fs.readFile(configPath(), "utf8").catch(() => undefined);
    const rc = await load();
    await rc.saveModelSettings("corp", "m1", {
      contextWindow: 60_000,
      imageInput: false,
      reasoning: "hidden",
    });
    let raw = (await readJson(providersPath())) as {
      providers: { id: string; userModels?: Record<string, Record<string, unknown>> }[];
    };
    expect(raw.providers[0]?.userModels?.m1).toEqual({
      contextWindow: 60_000,
      capabilities: { imageInput: false, reasoning: "hidden" },
    });
    // 生效值立即反映（新 load 也一致）
    expect((await mergedModel())?.contextWindow).toBe(60_000);
    // 清除 → 回落上游
    await rc.saveModelSettings("corp", "m1", { contextWindow: null });
    raw = (await readJson(providersPath())) as typeof raw;
    expect(raw.providers[0]?.userModels?.m1?.contextWindow).toBeUndefined();
    expect((await mergedModel())?.contextWindow).toBe(100_000);
    // 全部清除 → 条目与 userModels 字段一并消失
    await rc.saveModelSettings("corp", "m1", { imageInput: null, reasoning: null });
    raw = (await readJson(providersPath())) as typeof raw;
    expect(raw.providers[0]?.userModels).toBeUndefined();
    // config.json 从未被写
    expect(await fs.readFile(configPath(), "utf8").catch(() => undefined)).toBe(cfgBefore);
  });

  it("协议字段：写入 userModels.protocol；清除回落；非法值拒绝", async () => {
    await writeProviders([ENTRY]);
    const rc = await load();
    await rc.saveModelSettings("corp", "m1", { protocol: "anthropic" });
    let raw = (await readJson(providersPath())) as {
      providers: { id: string; userModels?: Record<string, Record<string, unknown>> }[];
    };
    expect(raw.providers[0]?.userModels?.m1).toEqual({ protocol: "anthropic" });
    expect((await mergedModel())?.protocol).toBe("anthropic");
    // 清除 → 回落条目 type
    await rc.saveModelSettings("corp", "m1", { protocol: null });
    raw = (await readJson(providersPath())) as typeof raw;
    expect(raw.providers[0]?.userModels).toBeUndefined();
    expect((await mergedModel())?.protocol).toBeUndefined();
    // 非法协议值拒绝且文件不变
    const before = await fs.readFile(providersPath(), "utf8");
    await expect(
      rc.saveModelSettings("corp", "m1", { protocol: "grpc" } as never),
    ).rejects.toMatchObject({ code: "config_invalid" });
    expect(await fs.readFile(providersPath(), "utf8")).toBe(before);
  });

  it("config 来源的协议字段：patch 拒绝", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: { m1: { protocol: "anthropic" } },
        },
      ],
    });
    const rc = await load();
    const before = await fs.readFile(providersPath(), "utf8");
    await expect(
      rc.saveModelSettings("corp", "m1", { protocol: "openai-compatible" }),
    ).rejects.toMatchObject({ code: "config_invalid" });
    expect(await fs.readFile(providersPath(), "utf8")).toBe(before);
  });

  it("refresh 不覆盖 userModels", async () => {
    await writeProviders([{ ...ENTRY, userModels: { m1: { contextWindow: 60_000 } } }]);
    const rc = await loadConfig(platform, {
      nocturneHome: home,
      env: noEnv,
      upstreamFetch: async () => [{ id: "m1", contextWindow: 999_999 }],
    });
    await rc.refreshUpstreamLimits("corp");
    const raw = (await readJson(providersPath())) as {
      providers: { id: string; userModels?: Record<string, unknown> }[];
    };
    expect(raw.providers[0]?.userModels?.m1).toEqual({ contextWindow: 60_000 });
    // 用户编辑仍压过刷新后的上游值
    expect((await mergedModel())?.contextWindow).toBe(60_000);
  });

  it("/provider add 同名整换保留 userModels", async () => {
    const creds = undefined;
    void creds;
    await writeProviders([{ ...ENTRY, userModels: { m1: { contextWindow: 60_000 } } }]);
    const rc = await load();
    await rc.saveSetupProvider({
      id: "corp",
      type: "openai-compatible",
      baseURL: "https://api.corp.test/v2",
      models: { m9: {} },
    });
    const raw = (await readJson(providersPath())) as {
      providers: { id: string; models?: unknown; userModels?: Record<string, unknown> }[];
    };
    expect(raw.providers[0]?.userModels?.m1).toEqual({ contextWindow: 60_000 });
    expect(Object.keys(raw.providers[0]?.models ?? {})).toEqual(["m9"]);
  });

  it("removeSetupProvider 连带删除 userModels", async () => {
    await writeProviders([{ ...ENTRY, userModels: { m1: { contextWindow: 60_000 } } }]);
    const rc = await load();
    await rc.removeSetupProvider("corp");
    const raw = (await readJson(providersPath())) as { providers: unknown[] };
    expect(raw.providers).toHaveLength(0);
  });
});

// ── 配置警告到达会话（runtime.warning / session.warnings）───

describe("配置警告到达会话", () => {
  it("旧服务商档位在启动时提示；编辑模型后清理旧字段", async () => {
    await writeProviders([
      { ...ENTRY, thinking: { format: "openrouter", levels: ["low"], source: "user" } },
    ]);
    const rc = await load();
    expect(rc.base.providerThinkingWarnings).toEqual(["corp"]);
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      config: rc,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    expect(session.warnings).toContain(
      "服务商 corp：服务商级思考档位已停用，模型能力改由上游与 models.dev 提供，个别模型可在编辑模型里修改",
    );
    await session.close();
    await rc.saveModelSettings("corp", "m1", { contextWindow: 60_000 });
    const raw = (await readJson(providersPath())) as {
      providers: { thinking?: { format?: string; levels?: string[]; source?: string } }[];
    };
    expect(raw.providers[0]?.thinking).toEqual({ format: "openrouter" });
    expect((await load()).base.providerThinkingWarnings).toBeUndefined();
  });

  it("显式 none 冲突警告进 session.warnings", async () => {
    await writeProviders([ENTRY]);
    await writeJson(configPath(), {
      providers: [
        {
          id: "corp",
          baseURL: "https://api.corp.test/v1",
          models: {
            m1: { capabilities: { reasoning: "none", reasoningEffort: ["low", "high"] } },
          },
        },
      ],
    });
    const rc = await load();
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      config: rc,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    expect(
      session.warnings.some(
        (w) => w.includes("corp") && w.includes("m1") && w.includes("推理为 none"),
      ),
    ).toBe(true);
    await session.close();
  });
});
