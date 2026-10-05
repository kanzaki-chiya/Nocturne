import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Core from "@nocturne/core";
import type * as LoginClient from "@nocturne/tui/provider-login";
import {
  logoutProvider,
  ProviderLoginError,
  type RuntimeConfig,
  type RuntimeSession,
} from "@nocturne/core";
import { runSlashCommand } from "../src/commands.js";
import { createSetupPrompts, runProviderSetupWizard, SetupAbort } from "../src/setup.js";
import { runProviderLogin } from "@nocturne/tui/provider-login";

vi.mock("@nocturne/core", async (original) => ({
  ...(await original<typeof Core>()),
  logoutProvider: vi.fn(),
}));
vi.mock("@nocturne/tui/provider-login", async (original) => ({
  ...(await original<typeof LoginClient>()),
  runProviderLogin: vi.fn(async (): Promise<{ loginId?: string }> => ({ loginId: "login-1" })),
}));
afterEach(() => vi.clearAllMocks());
const config = { base: { providers: [] } } as unknown as RuntimeConfig;
const session = {
  state: () => ({ config: { model: { provider: "openrouter" } } }),
} as unknown as RuntimeSession;
function bridge() {
  const deps = {
    provider: { config, reloadConfig: vi.fn(async () => config), updateProviders: vi.fn() },
    runLoginWizard: vi.fn(async (_id: string) => undefined),
  };
  const lines: string[] = [];
  return { deps, lines, io: { print: (text: string) => lines.push(text) } };
}
describe("CLI 服务商登录入口", () => {
  it("/provider login 交给 REPL 向导桥", async () => {
    const { deps, io } = bridge();
    await runSlashCommand("/provider login openrouter", session, {} as never, io, deps);
    expect(deps.runLoginWizard).toHaveBeenCalledWith("openrouter");
  });
  it("/provider logout 删除凭据后刷新配置", async () => {
    const { deps, io, lines } = bridge();
    await runSlashCommand("/provider logout openrouter", session, {} as never, io, deps);
    expect(logoutProvider).toHaveBeenCalledWith(config, "openrouter");
    expect(deps.provider.updateProviders).toHaveBeenCalledWith(config);
    expect(lines).toContain("已退出登录 openrouter");
  });
  it("缺少名称与非交互入口给用法", async () => {
    const { deps, io, lines } = bridge();
    await runSlashCommand("/provider login", session, {} as never, io, deps);
    await runSlashCommand("/provider logout", session, {} as never, io, deps);
    await runSlashCommand("/provider login openrouter", session, {} as never, io, {
      provider: deps.provider,
    });
    expect(lines.filter((text) => text.includes("需要服务商名"))).toHaveLength(2);
    expect(lines.at(-1)).toContain("需要交互式终端");
  });
  it("安全 Core 错误保留，未知错误不回显 token", async () => {
    const { deps, io, lines } = bridge();
    deps.runLoginWizard.mockRejectedValueOnce(new ProviderLoginError("timeout"));
    await runSlashCommand("/provider login openrouter", session, {} as never, io, deps);
    expect(lines.at(-1)).toContain(new ProviderLoginError("timeout").message);
    deps.runLoginWizard.mockRejectedValueOnce(new Error("mock-secret-token"));
    await runSlashCommand("/provider login openrouter", session, {} as never, io, deps);
    expect(lines.join("\n")).not.toContain("mock-secret-token");
  });
  it("setup 向导：OpenRouter 选浏览器登录时以草稿（预设、名称、地址）和原 IO 调登录客户端", async () => {
    const prompts = {
      ask: async () => "",
      askSecret: async () => "",
      chooseMulti: async () => [0],
      busy: () => undefined,
      step: () => undefined,
      print: () => undefined,
    };
    const loginConfig = {
      credentials: { backend: () => "memory", has: () => false },
      base: { providers: [] },
      findProviderConflict: async () => undefined,
    } as unknown as RuntimeConfig;
    // loginId 不是 Core 登记的草稿登录（客户端已被 mock），提交阶段按字段 credential 拒绝
    await expect(
      runProviderSetupWizard(prompts, loginConfig, { presetId: "openrouter" }),
    ).rejects.toMatchObject({ field: "credential" });
    expect(runProviderLogin).toHaveBeenCalledWith(
      loginConfig,
      { presetId: "openrouter", name: "openrouter", baseURL: "https://openrouter.ai/api/v1" },
      prompts,
    );
  });
  it("Overview 输出中文鉴权状态与保存位置", async () => {
    const { deps, io, lines } = bridge();
    deps.provider.config = {
      describeProviders: async () => [
        {
          id: "p",
          type: "openai-compatible",
          keySource: "credential",
          origin: "setup",
          overridden: false,
          modelCount: 1,
          managed: true,
          auth: "浏览器登录",
          credentialStatus: "valid",
          credentialStorage: "system",
        },
      ],
    } as unknown as RuntimeConfig;
    await runSlashCommand("/provider", session, {} as never, io, deps);
    expect(lines.join("\n")).toContain("浏览器登录 • 有效 • 系统保存");
  });
});
describe("CLI 登录输入清理", () => {
  function tty() {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn<(mode: boolean) => void>>;
    };
    stdin.isTTY = true;
    stdin.setRawMode = vi.fn<(mode: boolean) => void>();
    const chunks: string[] = [];
    const stdout = new Writable({
      write: (chunk, _encoding, callback) => {
        chunks.push(String(chunk));
        callback();
      },
    });
    return { stdin, chunks, io: createSetupPrompts(stdin, stdout) };
  }
  it("授权输入遮罩，Esc 取消恢复 raw mode", async () => {
    const { stdin, chunks, io } = tty();
    const work = io.askSecret("粘贴授权码：");
    const rejected = expect(work).rejects.toBeInstanceOf(SetupAbort);
    stdin.write("mock-private-code\x1b");
    await rejected;
    expect(chunks.join("")).not.toContain("mock-private-code");
    expect(chunks.join("")).toContain("****");
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });
  it("回调成功可取消挂起输入，恢复 stdin 后继续问答", async () => {
    const { stdin, io } = tty();
    const work = io.askSecret("粘贴授权码：");
    const rejected = expect(work).rejects.toBeInstanceOf(SetupAbort);
    io.cancelPending();
    await rejected;
    const next = io.ask("模型：");
    stdin.write("mock-model\r");
    expect(await next).toBe("mock-model");
  });
});
