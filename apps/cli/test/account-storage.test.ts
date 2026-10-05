/**
 * CLI 与 TUI 共用 runProviderLogin。这里用真实逐行 IO 证明：无系统后端时先让用户显式选择，
 * 空选和多选都重问，不会默认选明文；选定的位置作为登录参数 accountStorage 传给 Core。
 */
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Core from "@nocturne/core";
import { startProviderLogin, type RuntimeConfig } from "@nocturne/core";
import { runProviderLogin } from "@nocturne/tui/provider-login";
import { createSetupPrompts } from "../src/setup.js";

vi.mock("@nocturne/core", async (original) => ({
  ...(await original<typeof Core>()),
  startProviderLogin: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

const config = {
  credentials: { backend: () => "none" },
  base: {
    providers: [{ id: "chatgpt", type: "openai-compatible", auth: { kind: "openai-siwc" } }],
  },
} as unknown as RuntimeConfig;

describe("CLI 账号凭据保存选择", () => {
  it("授权前先选保存位置：空选和多选都重问，只接受明确的一项", async () => {
    const stdin = new PassThrough();
    const out: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        out.push(String(chunk));
        callback();
      },
    });
    const io = createSetupPrompts(stdin, stdout);
    vi.mocked(startProviderLogin).mockImplementation(async () => ({
      authorizeUrl: "http://127.0.0.1/authorize?state=mock-state",
      manualInput: "callback-url",
      expiresAt: Date.now() + 300_000,
      completion: Promise.resolve({ providerId: "chatgpt", account: "ada@example.test" }),
      submitManual: async () => undefined,
      cancel: () => undefined,
    }));
    const work = runProviderLogin(config, "chatgpt", io, { remote: true });
    await vi.waitFor(() => expect(out.join("")).toContain("必须选择一项"));
    expect(startProviderLogin).not.toHaveBeenCalled();
    stdin.write("\n");
    await vi.waitFor(() => expect(out.join("")).toContain("请只选择一项"));
    stdin.write("1,2\n");
    await vi.waitFor(() => expect(out.join("").split("请只选择一项").length).toBeGreaterThan(2));
    expect(startProviderLogin).not.toHaveBeenCalled();
    stdin.write("2\n");
    await work;
    expect(vi.mocked(startProviderLogin).mock.calls[0]?.[2]).toMatchObject({
      accountStorage: "memory",
    });
    expect(out.join("")).toContain("不会默认选择明文");
    expect(out.join("")).toContain("文件被备份、同步或拷走");
  });
});
