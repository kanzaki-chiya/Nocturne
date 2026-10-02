/**
 * CLI 与 TUI 共用 runProviderLogin。这里用真实逐行 IO 证明不会默认选明文。
 */
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Core from "@nocturne/core";
import { startProviderLogin, type RuntimeConfig } from "@nocturne/core";
import { runProviderLogin } from "@nocturne/tui/provider-login";
import { createWizardIo } from "../src/setup.js";

vi.mock("@nocturne/core", async (original) => ({
  ...(await original<typeof Core>()),
  startProviderLogin: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

const config = { base: { providers: [] } } as unknown as RuntimeConfig;

describe("CLI 账号凭据保存选择", () => {
  it("空选和多选都重问，只接受明确的一项", async () => {
    const stdin = new PassThrough();
    const out: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        out.push(String(chunk));
        callback();
      },
    });
    const io = createWizardIo(stdin, stdout);
    let resolveLogin: (value: { providerId: string; account?: string }) => void = () => undefined;
    const promise = new Promise<{ providerId: string; account?: string }>((resolve) => {
      resolveLogin = resolve;
    });
    let storage: "plaintext" | "memory" | undefined;
    let choose: (() => Promise<"plaintext" | "memory">) | undefined;
    vi.mocked(startProviderLogin).mockImplementation(async (_config, _id, options) => {
      if (options?.chooseAccountStorage === undefined)
        throw new Error("missing chooseAccountStorage");
      choose = options.chooseAccountStorage;
      return {
        authorizeUrl: "http://127.0.0.1/authorize?state=mock-state",
        manualInput: "callback-url",
        completion: promise,
        submitManual: async () => undefined,
        cancel: () => undefined,
      };
    });
    const work = runProviderLogin(config, "chatgpt", io, { remote: true });
    await vi.waitFor(() => expect(out.join("")).toContain("粘贴完整回调 URL"));
    if (choose === undefined) throw new Error("choose was not captured");
    const choosing = choose().catch((error: unknown) => {
      out.push(
        `CHOICE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      throw error;
    });
    void choosing.then((chosen) => {
      storage = chosen;
      resolveLogin({ providerId: "chatgpt", account: chosen });
    });
    await vi.waitFor(() => expect(out.join("")).toContain("必须选择一项"));
    stdin.write("\n");
    await vi.waitFor(() => expect(out.join("")).toContain("请只选择一项"));
    stdin.write("1,2\n");
    await vi.waitFor(() => expect(out.join("").split("请只选择一项").length).toBeGreaterThan(2));
    stdin.write("2\n");
    await work;
    expect(storage).toBe("memory");
    expect(out.join("")).toContain("不会默认选择明文");
    expect(out.join("")).toContain("文件被备份、同步或拷走");
  });
});
