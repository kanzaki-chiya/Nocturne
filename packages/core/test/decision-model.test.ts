import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { fetchGeminiDecisionModels } from "../src/config/reviewer.js";
import { parseConfigFile } from "../src/config/schema.js";
import type { DecisionModelConfig } from "../src/config/types.js";
import { REVIEWER_SAMPLES, createRuntime } from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import { FakeProvider } from "../src/provider/index.js";

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("decisionModel schema 与配置分层", () => {
  it("接受合法的 Gemini 与 Jev 形状以及 permission.reviewer decision 后端", () => {
    const validDecisionModels: DecisionModelConfig[] = [
      {
        source: "gemini",
        endpoint: "ai-studio",
        model: "gemini-decision-1",
        credential: { stored: true },
      },
      {
        source: "gemini",
        endpoint: "custom",
        baseURL: "https://gateway.example.invalid/v1beta",
        model: "gemini-decision-1",
        credential: { env: "GEMINI_API_KEY" },
      },
      {
        source: "jev",
        endpoint: "typesafe",
        model: "jev-latest",
        credential: { stored: true },
      },
      {
        source: "jev",
        endpoint: "opencode-zen",
        model: "jev-1.13-free",
        credential: { provider: "opencode-go" },
      },
      {
        source: "jev",
        endpoint: "custom",
        baseURL: "http://127.0.0.1:8787/v1",
        model: "jev-latest",
        credential: { env: "CUSTOM_JEV_KEY" },
      },
    ];
    for (const decisionModel of validDecisionModels) {
      expect(
        parseConfigFile(JSON.parse(JSON.stringify({ decisionModel })), "test").decisionModel,
      ).toEqual(decisionModel);
    }
    expect(
      parseConfigFile(
        { permission: { reviewer: { backend: "decision", minConfidence: 0.75 } } },
        "test",
      ).permission?.reviewer,
    ).toEqual({ backend: "decision", minConfidence: 0.75 });
  });

  it.each([
    {
      source: "gemini",
      endpoint: "ai-studio",
      model: "gemini-decision-1",
      credential: { stored: true },
      extra: 1,
    },
    {
      source: "gemini",
      endpoint: "ai-studio",
      model: "gemini-decision-1",
      credential: { stored: true },
      apiKey: "inline-secret",
    },
    {
      source: "gemini",
      endpoint: "ai-studio",
      model: "gemini-decision-1",
      credential: { key: "inline-secret" },
    },
    {
      source: "gemini",
      endpoint: "ai-studio",
      model: "gemini-decision-1",
      credential: { provider: "opencode-go" },
    },
    {
      source: "jev",
      endpoint: "typesafe",
      model: "jev-latest",
      credential: { provider: "opencode-go" },
    },
    {
      source: "gemini",
      endpoint: "ai-studio",
      baseURL: "https://gateway.example.invalid/v1beta",
      model: "gemini-decision-1",
      credential: { stored: true },
    },
    {
      source: "gemini",
      endpoint: "custom",
      model: "gemini-decision-1",
      credential: { stored: true },
    },
    {
      source: "gemini",
      endpoint: "custom",
      baseURL: "https://user:pass@gateway.example.invalid/v1beta",
      model: "gemini-decision-1",
      credential: { stored: true },
    },
    {
      source: "gemini",
      endpoint: "custom",
      baseURL: "https://gateway.example.invalid/v1beta?a=1",
      model: "gemini-decision-1",
      credential: { stored: true },
    },
    {
      source: "gemini",
      endpoint: "custom",
      baseURL: "file:///tmp",
      model: "gemini-decision-1",
      credential: { stored: true },
    },
  ])("拒绝非法 decisionModel：%j", (decisionModel) => {
    expect(() => parseConfigFile({ decisionModel }, "test")).toThrow();
  });

  it("项目不可信时忽略 decisionModel，信任后生效", async () => {
    const home = await makeTempDir("nocturne-dm-home-");
    const workspace = await makeTempDir("nocturne-dm-ws-");
    await mkdir(join(workspace, ".nocturne"), { recursive: true });
    await writeFile(
      join(workspace, ".nocturne", "config.json"),
      JSON.stringify({
        decisionModel: {
          source: "gemini",
          endpoint: "ai-studio",
          model: "gemini-decision-1",
          credential: { env: "GEMINI_API_KEY" },
        },
      }),
    );

    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    const untrusted = await config.forWorkspace(workspace);
    expect(untrusted.resolved.decisionModel).toBeUndefined();

    await config.setWorkspaceTrusted(workspace, true);
    const trusted = await config.forWorkspace(workspace);
    expect(trusted.resolved.decisionModel).toEqual({
      source: "gemini",
      endpoint: "ai-studio",
      model: "gemini-decision-1",
      credential: { env: "GEMINI_API_KEY" },
    });
  });

  it("fetchGeminiDecisionModels 去掉 models/ 前缀并过滤含 decision 的项，失败退回默认", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          models: [
            { name: "models/gemini-2.5-flash" },
            { name: "models/gemini-decision-1" },
            { name: "models/gemini-decision-1" },
            { name: "models/gemini-decision-2-preview" },
          ],
        }),
      ),
    );
    const ok = await fetchGeminiDecisionModels(
      { baseURL: "https://example.invalid/v1beta", key: async () => "fake-key" },
      "gemini-decision-1",
    );
    expect(ok).toEqual({ models: ["gemini-decision-1", "gemini-decision-2-preview"] });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("network")));
    const fallback = await fetchGeminiDecisionModels(
      { baseURL: "https://example.invalid/v1beta", key: async () => "fake-key" },
      "gemini-decision-1",
    );
    expect(fallback.models).toEqual(["gemini-decision-1"]);
    expect(fallback.warning).toBeTruthy();
  });
});

describe("backend: decision、旧 Jev 迁移与环境变量剥离", () => {
  it("旧 Jev 配置不保存时行为不变；保存后原子改写为新形状并迁移 stored 密钥", async () => {
    const home = await makeTempDir("nocturne-legacy-home-");
    const workspace = await makeTempDir("nocturne-legacy-ws-");
    const sessionsDir = await makeTempDir("nocturne-legacy-sessions-");
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        permission: {
          reviewer: {
            backend: "jev",
            endpoint: "typesafe",
            model: "jev-latest",
            credential: { stored: true },
            minConfidence: 0.75,
          },
        },
      }),
    );

    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    await config.setCredential("reviewer", "legacy-stored-secret");

    const runtime = await createRuntime({
      cwd: workspace,
      sessionsDir,
      providers: [new FakeProvider({})],
      config,
      interactive: false,
    });

    // 保存前：describeSettings 从旧 Jev 派生生效 decisionModel
    const before = runtime.describeSettings();
    const dmBefore = before.find((s) => s.key === "decisionModel");
    expect(dmBefore?.decisionModel?.effective).toEqual({
      source: "jev",
      endpoint: "typesafe",
      model: "jev-latest",
      credential: { stored: true },
    });
    expect(dmBefore?.decisionModel?.saved).toBeUndefined();

    // 保存审查器为 decision 后端：一次原子写入同时写出 decisionModel 与新 permission.reviewer，并迁移密钥
    await runtime.updateSettings({
      "permission.reviewer": { backend: "decision", minConfidence: 0.8 },
    });

    const rawSettings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    expect(rawSettings.decisionModel).toEqual({
      source: "jev",
      endpoint: "typesafe",
      model: "jev-latest",
      credential: { stored: true },
    });
    expect(rawSettings.permission.reviewer).toEqual({
      backend: "decision",
      minConfidence: 0.8,
    });
    expect(await config.credentials.get("decision-model")).toBe("legacy-stored-secret");
    expect(await config.credentials.get("reviewer")).toBeUndefined();
  });

  it("backend: decision 未设置决策模型时返回 unsure 决策模型未设置；Gemini 与 Jev 均可审查", async () => {
    const home = await makeTempDir("nocturne-rev-home-");
    const workspace = await makeTempDir("nocturne-rev-ws-");
    const sessionsDir = await makeTempDir("nocturne-rev-sessions-");
    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    const runtime = await createRuntime({
      cwd: workspace,
      sessionsDir,
      providers: [new FakeProvider({})],
      config,
      interactive: false,
    });

    const sampleId = REVIEWER_SAMPLES[0]!.id;
    await runtime.updateSettings({
      "permissions.preset": "smart",
      "permission.reviewer": { backend: "decision" },
    });
    await expect(runtime.testReviewerSample(sampleId)).rejects.toThrow("决策模型未设置");

    // smart 会话下决策模型未设置时，送审返回 unsure 决策模型未设置
    const unsetProvider = new FakeProvider({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "tc-unset",
            name: "shell",
            input: { command: "git push origin main" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const unsetRuntime = await createRuntime({
      cwd: workspace,
      sessionsDir,
      providers: [unsetProvider],
      config,
      interactive: false,
      permissions: { preset: "smart" },
    });
    const unsetSession = await unsetRuntime.createSession({
      model: { provider: "fake", model: "fake-1" },
      workspaceRoot: workspace,
    });
    const reviewed: { verdict: string; reason: string }[] = [];
    unsetSession.subscribe((ev) => {
      if (ev.type === "permission.reviewed") {
        reviewed.push({ verdict: ev.payload.verdict, reason: ev.payload.reason });
      }
    });
    await unsetSession.submit({ text: "push changes" });
    expect(reviewed).toEqual([{ verdict: "unsure", reason: "决策模型未设置" }]);
    await unsetSession.close();

    // 配置 Gemini 决策模型并 mock fetch
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        answers: {
          "1": { type: "choice", choice: "no", confidence: 0.95 },
          "2": { type: "choice", choice: "no", confidence: 0.95 },
          "3": { type: "choice", choice: "no", confidence: 0.95 },
          "4": { type: "choice", choice: "no", confidence: 0.95 },
          "5": { type: "choice", choice: "no", confidence: 0.95 },
          "6": { type: "choice", choice: "no", confidence: 0.95 },
          "7": { type: "choice", choice: "no", confidence: 0.95 },
        },
        usage: { total_input_tokens: 100 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runtime.updateSettings(
      {
        decisionModel: {
          source: "gemini",
          endpoint: "custom",
          baseURL: "http://127.0.0.1:19999/v1beta",
          model: "gemini-decision-1",
          credential: { stored: true },
        },
      },
      { decisionModelKey: "fake-gemini-key" },
    );
    const geminiResult = await runtime.testReviewerSample(sampleId);
    expect(geminiResult.actual).toBe("allow");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:19999/v1beta/decisions");

    // 切换为 Jev 决策模型并 mock fetch
    fetchMock.mockClear();
    await runtime.updateSettings({
      decisionModel: {
        source: "jev",
        endpoint: "custom",
        baseURL: "http://127.0.0.1:19999/v1",
        model: "jev-latest",
        credential: { stored: true },
      },
    });
    const jevResult = await runtime.testReviewerSample(sampleId);
    expect(jevResult.actual).toBe("allow");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:19999/v1/systemone");
  });

  it("shell 子进程剥离 GEMINI_API_KEY 与用户所选决策模型环境变量", async () => {
    const home = await makeTempDir("nocturne-strip-home-");
    const workspace = await makeTempDir("nocturne-strip-ws-");
    const sessionsDir = await makeTempDir("nocturne-strip-sessions-");
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevCustom = process.env.MY_DECISION_SECRET;
    process.env.GEMINI_API_KEY = "fake-gemini-env-val";
    process.env.MY_DECISION_SECRET = "fake-custom-env-val";
    try {
      const provider = new FakeProvider({
        scripts: [
          [
            {
              type: "tool_call",
              toolCallId: "tc1",
              name: "shell",
              input: {
                command:
                  'node -e "console.log(JSON.stringify([process.env.GEMINI_API_KEY ?? null, process.env.MY_DECISION_SECRET ?? null]))"',
              },
            },
            { type: "finish", reason: "tool_calls" },
          ],
          [
            { type: "text_delta", text: "done" },
            { type: "finish", reason: "stop" },
          ],
        ],
      });
      const config = await loadConfig(createPlatform(), { nocturneHome: home });
      const runtime = await createRuntime({
        cwd: workspace,
        sessionsDir,
        providers: [provider],
        config,
        interactive: false,
        permissions: { preset: "bypass" },
      });
      await runtime.updateSettings({
        "permissions.preset": "bypass",
        decisionModel: {
          source: "gemini",
          endpoint: "custom",
          baseURL: "http://127.0.0.1:19999/v1beta",
          model: "gemini-decision-1",
          credential: { env: "MY_DECISION_SECRET" },
        },
      });
      const session = await runtime.createSession({
        model: { provider: "fake", model: "fake-1" },
        workspaceRoot: workspace,
      });
      let toolContent = "";
      session.subscribe((event) => {
        if (event.type === "tool.completed") {
          toolContent = event.payload.modelContent;
        }
      });
      await session.submit({ text: "check env" });
      expect(toolContent).toContain("[null,null]");
      await session.close();
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevCustom === undefined) delete process.env.MY_DECISION_SECRET;
      else process.env.MY_DECISION_SECRET = prevCustom;
    }
  });
});
