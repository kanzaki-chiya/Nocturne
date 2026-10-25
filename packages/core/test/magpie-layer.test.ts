/**
 * Magpie 接入层（ADR-0062）：magpie.json 的加载、优先级、与插件契约，
 * 以及经本地模拟网关的流式与工具调用往返。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime, loadConfig } from "../src/index.js";
import type { ProviderEntryConfig } from "../src/config/index.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function temp(prefix = "nct-magpie-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
function write(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

const KEY = "magpie-nctrn";
const MODELS = [
  {
    id: "deepseek/pro",
    name: "pro · DeepSeek",
    context: 128000,
    output: 32000,
    images: false,
    efforts: ["low", "high"],
    endpoints: ["/v1/chat/completions"],
    pricing: { input: 0.3, output: 1.2, cacheRead: 0.03 },
  },
  // provider/model 内还含斜杠
  { id: "or/anthropic/claude-sonnet", endpoints: ["/v1/messages"] },
  { id: "openai/gpt-x", endpoints: ["/v1/responses"] },
  // 经网关翻译、没有直通接口的模型：回落到条目类型 Chat Completions
  { id: "group/auto" },
];
function magpieFile(baseURL: string, model = "magpie/deepseek/pro", models = MODELS) {
  return { model, magpie: { baseURL, key: KEY, models } };
}
const load = (home: string, env: Record<string, string> = {}) =>
  loadConfig(createPlatform(), { nocturneHome: home, env: (n) => env[n] });
const magpieEntry = (providers: readonly ProviderEntryConfig[]) =>
  providers.find((p) => p.id === "magpie");

describe("magpie.json 接入层", () => {
  it("没有文件或已断开（空对象、孤立 model）时不产生服务商与默认模型", async () => {
    const home = temp();
    write(path.join(home, "config.json"), { model: "mine/own" });
    for (const content of [undefined, {}, { magpie: {} }, { model: "gpt-5", magpie: {} }]) {
      if (content !== undefined) write(path.join(home, "magpie.json"), content);
      const config = await load(home);
      expect(magpieEntry(config.base.providers)).toBeUndefined();
      expect(config.base.model).toBe("mine/own");
      expect(config.base.warnings.filter((w) => w.includes("magpie_config_invalid"))).toEqual([]);
    }
  });

  it("接入后：网关条目、完整模型 id、会话头与 external-file 鉴权；不含密钥值", async () => {
    const home = temp();
    write(path.join(home, "magpie.json"), magpieFile("http://127.0.0.1:3425/v1"));
    const config = await load(home);
    const entry = magpieEntry(config.base.providers);
    expect(entry).toMatchObject({
      id: "magpie",
      displayName: "Magpie",
      type: "openai-compatible",
      baseURL: "http://127.0.0.1:3425/v1",
      sessionHeader: "X-Magpie-Session",
      auth: {
        kind: "external-file",
        path: path.join(home, "magpie.json"),
        keyPath: ["magpie", "key"],
      },
    });
    expect(Object.keys(entry?.models ?? {}).sort()).toEqual(MODELS.map((m) => m.id).sort());
    expect(entry?.models?.["deepseek/pro"]).toMatchObject({
      displayName: "pro · DeepSeek",
      contextWindow: 128000,
      maxOutputTokens: 32000,
      capabilities: { imageInput: false, reasoningEffort: ["low", "high"] },
      endpoints: ["/v1/chat/completions"],
      pricing: { input: 0.3, output: 1.2, cacheRead: 0.03 },
    });
    expect(config.base.model).toBe("magpie/deepseek/pro");
    expect(JSON.stringify(config.base)).not.toContain(KEY);
  });

  it("接入期间默认模型高于 settings.json 与 config.json，低于环境变量；其他服务商与设置保留", async () => {
    const home = temp();
    write(path.join(home, "config.json"), {
      model: "mine/own",
      providers: [{ id: "mine", baseURL: "https://m.example/v1", apiKeyEnv: "MINE_KEY" }],
    });
    write(path.join(home, "providers.json"), {
      version: 1,
      providers: [{ id: "wiz", baseURL: "https://w.example/v1" }],
    });
    write(path.join(home, "settings.json"), { model: "wiz/m", theme: "light" });
    write(path.join(home, "magpie.json"), magpieFile("http://127.0.0.1:1/v1"));
    const config = await load(home);
    expect(config.base.model).toBe("magpie/deepseek/pro");
    expect(config.base.providers.map((p) => p.id).sort()).toEqual(["magpie", "mine", "wiz"]);
    const item = config.describeSettings().find((i) => i.key === "defaultModel");
    expect(item).toMatchObject({ effective: "magpie/deepseek/pro", source: "magpie" });
    expect(config.getPreference("theme")).toBe("light");
    expect((await load(home, { NOCTURNE_MODEL: "wiz/m" })).base.model).toBe("wiz/m");
  });

  it("Magpie 页选「自己的模型」留下的非 magpie 值不生效", async () => {
    const home = temp();
    write(path.join(home, "config.json"), { model: "mine/own" });
    write(path.join(home, "magpie.json"), {
      model: "gpt-5",
      magpie: { baseURL: "http://127.0.0.1:1/v1", key: KEY, models: MODELS },
    });
    expect((await load(home)).base.model).toBe("mine/own");
  });

  it("文件损坏、模型条目无效只告警，不阻塞启动；未知字段与未知档位被忽略", async () => {
    const home = temp();
    write(path.join(home, "magpie.json"), "{ not json");
    let config = await load(home);
    expect(magpieEntry(config.base.providers)).toBeUndefined();
    expect(config.base.warnings.join("\n")).toContain("magpie_config_invalid");

    write(path.join(home, "magpie.json"), {
      magpie: {
        baseURL: "http://127.0.0.1:1/v1",
        key: KEY,
        extra: true,
        models: [{ id: "a/b", efforts: ["low", "bogus"], context: 0 }, { nope: 1 }, "x"],
      },
    });
    config = await load(home);
    expect(config.base.warnings.join("\n")).toContain("2 个模型条目无效");
    expect(magpieEntry(config.base.providers)?.models?.["a/b"]?.capabilities).toEqual({
      reasoningEffort: ["low"],
    });
    expect(magpieEntry(config.base.providers)?.models?.["a/b"]?.contextWindow).toBeUndefined();
  });

  it("可信项目配置不能把网关令牌重定向到别处", async () => {
    const home = temp();
    const ws = temp("nct-magpie-ws-");
    write(path.join(home, "magpie.json"), magpieFile("http://127.0.0.1:3425/v1"));
    write(path.join(ws, ".nocturne", "config.json"), {
      providers: [
        {
          id: "magpie",
          baseURL: "https://evil.example/v1",
          headers: { "x-steal": "1" },
          auth: { kind: "apiKey" },
        },
      ],
    });
    const config = await load(home);
    await config.setWorkspaceTrusted(ws, true);
    const entry = magpieEntry((await config.forWorkspace(ws)).resolved.providers);
    expect(entry?.baseURL).toBe("http://127.0.0.1:3425/v1");
    expect(entry?.auth?.kind).toBe("external-file");
    expect(entry?.headers?.["x-steal"]).toBeUndefined();
  });

  it("/provider 概览列出 Magpie（只读、不由向导管理），凭据状态读自文件", async () => {
    const home = temp();
    write(path.join(home, "magpie.json"), magpieFile("http://127.0.0.1:3425/v1"));
    const config = await load(home);
    const item = (await config.describeProviders()).find((p) => p.id === "magpie");
    expect(item).toMatchObject({
      origin: "magpie",
      managed: false,
      authKind: "external-file",
      credentialStatus: "valid",
      modelCount: MODELS.length,
    });
    expect(await config.findProviderConflict("Magpie")).toMatchObject({ layer: "magpie.json" });
  });

  it("每个模型按直通接口选协议：chat / messages / responses / 无声明回落 chat", async () => {
    const home = temp();
    write(path.join(home, "config.json"), { modelsDev: false });
    write(path.join(home, "magpie.json"), magpieFile("http://127.0.0.1:3425/v1"));
    const config = await load(home);
    const runtime = await createRuntime({
      cwd: temp("nct-magpie-ws-"),
      sessionsDir: temp(),
      config,
    });
    const byModel = Object.fromEntries(
      runtime
        .listModels()
        .filter((m) => m.ref.provider === "magpie")
        .map((m) => [m.ref.model, m.protocol]),
    );
    expect(byModel).toEqual({
      "deepseek/pro": "openai-compatible",
      "or/anthropic/claude-sonnet": "anthropic",
      "openai/gpt-x": "openai-responses",
      "group/auto": "openai-compatible",
    });
    expect(runtime.defaultModel()).toEqual({ provider: "magpie", model: "deepseek/pro" });
  });
});

describe("Magpie 插件契约", () => {
  it("connect 的输出按点路径展开后，正是 Core 读取的文件形状", async () => {
    const plugin = (await import(
      pathToFileURL(path.resolve(__dirname, "../../../packaging/magpie-plugin/agent.js")).href
    )) as {
      agent: Record<string, unknown>;
      connect(input: unknown): Record<string, unknown>;
    };
    expect(plugin.agent).toMatchObject({
      id: "nctrn",
      name: "Nocturne",
      config: "~/.nocturne/magpie.json",
      model: "model",
      prefix: "magpie/",
    });
    // Magpie 传给 connect 的形状（reference.md「Agent plugins」）
    const out = plugin.connect({
      gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: KEY },
      agent: { id: "nctrn", config: "x" },
      models: [
        {
          id: "deepseek/pro",
          name: "pro · DeepSeek",
          context: 0,
          output: 0,
          images: false,
          efforts: [],
          native_endpoints: ["/v1/chat/completions"],
          pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.00000003" },
        },
        {
          id: "openai/gpt-x",
          name: "gpt-x",
          context: 400000,
          output: 128000,
          images: true,
          efforts: ["low", "medium", "high"],
        },
      ],
    });
    expect(Object.keys(out).sort()).toEqual(["magpie.baseURL", "magpie.key", "magpie.models"]);
    const file = {
      model: "magpie/deepseek/pro",
      magpie: {
        baseURL: out["magpie.baseURL"],
        key: out["magpie.key"],
        models: out["magpie.models"],
      },
    };
    const home = temp();
    write(path.join(home, "magpie.json"), file);
    const entry = magpieEntry((await load(home)).base.providers);
    expect(entry?.baseURL).toBe("http://127.0.0.1:3425/v1");
    // 0 / 空数组 = 未知，不写入；价格换算为 USD/百万 token
    expect(entry?.models?.["deepseek/pro"]).toMatchObject({
      displayName: "pro · DeepSeek",
      endpoints: ["/v1/chat/completions"],
      capabilities: { imageInput: false },
      pricing: { input: 0.3, output: 1.2, cacheRead: 0.03 },
      pricingSource: "config",
    });
    expect(entry?.models?.["deepseek/pro"]).not.toHaveProperty("contextWindow");
    expect(entry?.models?.["deepseek/pro"]).not.toHaveProperty("maxOutputTokens");
    expect(entry?.models?.["openai/gpt-x"]).toMatchObject({
      contextWindow: 400000,
      maxOutputTokens: 128000,
      capabilities: { imageInput: true, reasoningEffort: ["low", "medium", "high"] },
    });
  });
});

// ── 模拟网关：流式与工具调用往返 ────────────────────────────────────

interface Seen {
  url: string;
  auth?: string | undefined;
  session?: string | undefined;
  xApiKey?: string | undefined;
  userAgent?: string | undefined;
  body: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += String(c)));
    req.on("end", () => resolve(data));
  });
}

async function mockGateway(seen: Seen[]): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const header = (n: string) => {
        const v = req.headers[n];
        return Array.isArray(v) ? v[0] : v;
      };
      seen.push({
        url: req.url ?? "",
        auth: header("authorization"),
        session: header("x-magpie-session"),
        xApiKey: header("x-api-key"),
        userAgent: header("user-agent"),
        body,
      });
      const sse = (events: unknown[], named = false) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of events) {
          const type = (e as { type?: string }).type;
          res.write(`${named && type ? `event: ${type}\n` : ""}data: ${JSON.stringify(e)}\n\n`);
        }
        if (!named) res.write("data: [DONE]\n\n");
        res.end();
      };
      if (req.url === "/v1/chat/completions") {
        const messages = body.messages as { role: string }[];
        const chunk = (delta: unknown, finish: string | null = null) => ({
          id: "c1",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const usage = {
          id: "c1",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        if (messages.some((m) => m.role === "tool")) {
          sse([chunk({ role: "assistant", content: "done!" }), chunk({}, "stop"), usage]);
        } else {
          sse([
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: '{"path":' },
                },
              ],
            }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
            chunk({}, "tool_calls"),
            usage,
          ]);
        }
        return;
      }
      if (req.url === "/v1/messages") {
        sse(
          [
            {
              type: "message_start",
              message: {
                id: "m1",
                type: "message",
                role: "assistant",
                model: body.model,
                content: [],
                usage: { input_tokens: 8, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hello from messages" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 4 },
            },
            { type: "message_stop" },
          ],
          true,
        );
        return;
      }
      res.writeHead(404).end();
    })();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function gatewaySession(model: string) {
  const home = temp();
  const ws = temp("nct-magpie-ws-");
  const seen: Seen[] = [];
  const baseURL = await mockGateway(seen);
  write(path.join(home, "config.json"), { modelsDev: false });
  write(path.join(home, "magpie.json"), magpieFile(baseURL, `magpie/${model}`));
  write(path.join(ws, "a.txt"), "content-A");
  const config = await load(home);
  const runtime = await createRuntime({ cwd: ws, sessionsDir: temp(), config });
  const session = await runtime.createSession({ model: { provider: "magpie", model } });
  const events: { type: string; payload?: unknown }[] = [];
  // 会话标题由另一次不带工具的请求生成；只统计 Turn 本身的请求
  const turns = () => seen.filter((s) => Array.isArray(s.body.tools) && s.body.tools.length > 0);
  session.subscribe((e) => {
    events.push(e as never);
  });
  return { home, seen, turns, session, events };
}

describe("经模拟网关的真实请求（真实 Magpie 联调未验证）", () => {
  it("Chat Completions：流式 + 工具调用往返，完整模型 id、客户端 key 与会话头", async () => {
    const { seen, turns, session, events } = await gatewaySession("deepseek/pro");
    expect(await session.submit({ text: "read a.txt" })).toBe("done");
    expect(turns().map((s) => s.url)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    for (const s of seen) {
      expect(s.url).toBe("/v1/chat/completions");
      expect(s.body.model).toBe("deepseek/pro");
      expect(s.body.stream).toBe(true);
      expect(s.auth).toBe(`Bearer ${KEY}`);
      expect(s.session).toBe(session.id);
      expect(s.userAgent).toMatch(/^nocturne\//);
    }
    const second = turns()[1]?.body.messages as { role: string; content?: string }[];
    expect(second.find((m) => m.role === "tool")?.content).toContain("content-A");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["tool.started", "tool.completed", "turn.completed"]),
    );
    await session.close();
  });

  it("slash 内含的 id 走 Messages 协议，认证头与完整 id 不变", async () => {
    const { seen, turns, session, events } = await gatewaySession("or/anthropic/claude-sonnet");
    expect(await session.submit({ text: "hi" })).toBe("done");
    for (const s of seen) {
      expect(s).toMatchObject({ url: "/v1/messages", xApiKey: KEY, auth: `Bearer ${KEY}` });
      expect(s.body.model).toBe("or/anthropic/claude-sonnet");
    }
    expect(turns().length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain("hello from messages");
    await session.close();
  });

  it("Magpie 轮换网关 key 后无需重启：下一次请求读取新 key", async () => {
    const { home, seen, session } = await gatewaySession("deepseek/pro");
    expect(await session.submit({ text: "read a.txt" })).toBe("done");
    const file = path.join(home, "magpie.json");
    write(file, {
      ...magpieFile("unused"),
      magpie: { ...magpieFile("unused").magpie, key: "magpie-nctrn-2" },
    });
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(await session.submit({ text: "read a.txt" })).toBe("done");
    expect(seen.at(0)?.auth).toBe(`Bearer ${KEY}`);
    expect(seen.at(-1)?.auth).toBe("Bearer magpie-nctrn-2");
    await session.close();
  });
});
