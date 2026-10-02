import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { cleanup, render } from "ink-testing-library";
import { createElement, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Core from "@nocturne/core";
import {
  startProviderLogin,
  ProviderLoginError,
  WizardAbort,
  type RuntimeConfig,
} from "@nocturne/core";
import type { LoginSession } from "@nocturne/core/protocol";
import {
  openLoginBrowser,
  runProviderLogin,
  unstoredKeyCommands,
  type LoginIo,
} from "../src/provider-login.js";
import { providerCredentialDescription } from "../src/text-format.js";
import { WizardView } from "../src/components/wizard-view.js";
import { ProviderDialog } from "../src/components/provider-dialog.js";
import { useProviderWizard, type WizardOutcome } from "../src/wizard-io.js";
import { settle } from "./provider-test-utils.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("@nocturne/core", async (original) => ({
  ...(await original<typeof Core>()),
  startProviderLogin: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const entry = {
  id: "openrouter",
  type: "openai-compatible" as const,
  baseURL: "https://openrouter.ai/api/v1",
};
const config = { base: { providers: [entry] } } as unknown as RuntimeConfig;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture");
  return value;
}
function session(manualInput: LoginSession["manualInput"] = "code") {
  let resolve!: (v: { providerId: string }) => void;
  let reject!: (e: Error) => void;
  const completion = new Promise<{ providerId: string }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const s: LoginSession = {
    authorizeUrl: "https://example.test/authorize?state=mock-state&code_challenge=mock-challenge",
    manualInput,
    completion,
    submitManual: vi.fn(async () => {
      resolve({ providerId: entry.id });
    }),
    cancel: vi.fn(() => reject(new ProviderLoginError("cancelled"))),
  };
  vi.mocked(startProviderLogin).mockResolvedValue(s);
  return { s, resolve, reject };
}
function io(): LoginIo {
  return {
    ask: vi.fn(),
    askSecret: vi.fn(() => new Promise<string>(() => undefined)),
    chooseMulti: vi.fn(),
    print: vi.fn(),
    step: vi.fn(),
    busy: vi.fn(),
    cancelPending: vi.fn(),
  };
}
function browser(error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (e: Error | null) => void)(error);
    return {} as ReturnType<typeof execFile>;
  });
}

describe("登录客户端", () => {
  it.each(["win32", "darwin", "linux"] as const)("%s 使用系统浏览器命令", async (platform) => {
    browser();
    expect(
      await openLoginBrowser("https://example.test/a?state=mock&challenge=x%20y", platform),
    ).toBe(true);
    const [command, args, options] = required(vi.mocked(execFile).mock.calls[0]);
    expect(command).toBe(
      platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open",
    );
    if (platform === "win32") {
      expect(args).toEqual(["/d", "/c", 'start "" "%NOCTURNE_AUTHORIZE_URL%"']);
      expect(options).toMatchObject({
        windowsHide: true,
        env: { NOCTURNE_AUTHORIZE_URL: "https://example.test/a?state=mock&challenge=x%20y" },
      });
    } else expect(args).toEqual(["https://example.test/a?state=mock&challenge=x%20y"]);
  });
  it("浏览器失败返回 false，拒绝不安全地址", async () => {
    browser(new Error("mock failure"));
    expect(await openLoginBrowser("https://example.test/")).toBe(false);
    vi.mocked(execFile).mockClear();
    for (const url of ['https://example.test/"', "file:///secret", "https://example.test/\n"])
      expect(await openLoginBrowser(url)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each(["code", "callback-url"] as const)("%s 通过遮罩输入提交并清理会话", async (kind) => {
    const { s } = session(kind);
    const wio = io();
    vi.mocked(wio.askSecret).mockResolvedValueOnce("mock-sensitive-input");
    await runProviderLogin(config, entry.id, wio, { remote: false, openBrowser: async () => true });
    expect(s.submitManual).toHaveBeenCalledWith("mock-sensitive-input");
    expect(wio.ask).not.toHaveBeenCalled();
    expect(wio.print).toHaveBeenCalledWith(expect.stringContaining("已在浏览器打开"));
    expect(JSON.stringify(vi.mocked(wio.print).mock.calls)).not.toContain("mock-sensitive-input");
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(wio.cancelPending).toHaveBeenCalledTimes(1);
  });
  it("远程终端不打开本地浏览器，保留完整授权地址", async () => {
    const { s, resolve } = session();
    const wio = io();
    const openBrowser = vi.fn(async () => true);
    const work = runProviderLogin(config, entry.id, wio, { remote: true, openBrowser });
    await settle(() => vi.mocked(wio.askSecret).mock.calls.length > 0);
    resolve({ providerId: entry.id });
    await work;
    expect(openBrowser).not.toHaveBeenCalled();
    expect(wio.print).toHaveBeenCalledWith(expect.stringContaining(s.authorizeUrl));
    expect(wio.print).toHaveBeenCalledWith(expect.stringContaining("请复制到浏览器"));
  });
  it("浏览器异常仅显示复制提示，不输出异常", async () => {
    session();
    const wio = io();
    vi.mocked(wio.askSecret).mockResolvedValueOnce("mock-code");
    await runProviderLogin(config, entry.id, wio, {
      remote: false,
      openBrowser: async () => {
        throw new Error("mock-private-error");
      },
    });
    expect(wio.print).toHaveBeenCalledWith(expect.stringContaining("请复制到浏览器"));
    expect(JSON.stringify(vi.mocked(wio.print).mock.calls)).not.toContain("mock-private-error");
  });
  it("Esc/Ctrl+C 输入取消会关闭会话", async () => {
    const { s } = session();
    const wio = io();
    vi.mocked(wio.askSecret).mockRejectedValue(new WizardAbort());
    await expect(runProviderLogin(config, entry.id, wio, { remote: true })).rejects.toBeInstanceOf(
      WizardAbort,
    );
    expect(s.cancel).toHaveBeenCalled();
  });
  it.each(["timeout", "network"] as const)("保留 Core %s 安全文案", async (code) => {
    const { reject } = session();
    const work = runProviderLogin(config, entry.id, io(), { remote: true });
    reject(new ProviderLoginError(code));
    await expect(work).rejects.toMatchObject({
      code,
      message: new ProviderLoginError(code).message,
    });
  });
  it("未知 completion 异常不回显授权输入", async () => {
    const { reject } = session();
    const work = runProviderLogin(config, entry.id, io(), { remote: true });
    reject(new Error("mock-token mock-code"));
    await expect(work).rejects.toThrow("登录未完成，请重新运行 /provider login");
  });
  it("未保存的 key 只经过显式一次显示回调", async () => {
    const { resolve } = session();
    const wio = io();
    const showUnstoredKey = vi.fn(async () => undefined);
    const work = runProviderLogin(config, entry.id, wio, { entry, remote: true, showUnstoredKey });
    await settle(() => vi.mocked(wio.askSecret).mock.calls.length > 0);
    const options = required(required(vi.mocked(startProviderLogin).mock.calls[0])[2]);
    const showKey = required(options.onUnstoredKey);
    await showKey("mock-once-key", "OPENROUTER_API_KEY");
    await showKey("mock-once-key", "OPENROUTER_API_KEY");
    resolve({ providerId: entry.id });
    await work;
    expect(showUnstoredKey).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(wio.print).mock.calls)).not.toContain("mock-once-key");
    expect(options.entry).toEqual(entry);
  });
  it("环境变量命令转义并拒绝非法名称", () => {
    expect(unstoredKeyCommands("mock'key", "KEY")).toContain("$env:KEY='mock''key'");
    expect(unstoredKeyCommands("mock'key", "KEY")).toContain("export KEY='mock'\\''key'");
    expect(() => unstoredKeyCommands("mock", "KEY;bad")).toThrow();
  });
  it("Overview 中文描述保留有效期与存储位置", () => {
    expect(
      providerCredentialDescription({
        auth: "ChatGPT 账号 mock@example.test",
        credentialStatus: "expiring",
        credentialStorage: "memory",
      }),
    ).toBe("ChatGPT 账号 mock@example.test • 即将过期 • 仅本次运行");
  });
});

function screen(onDone = vi.fn<(outcome: WizardOutcome) => void>()) {
  function Harness() {
    const wizard = useProviderWizard(config);
    useEffect(() => {
      wizard.start({ kind: "login", providerId: entry.id }, onDone);
    }, []);
    return (
      <WizardView
        title="登录 OpenRouter"
        state={wizard.state}
        active
        width={100}
        height={24}
        onSubmit={wizard.submit}
        onSubmitMulti={wizard.submitMulti}
        onCancel={wizard.cancel}
      />
    );
  }
  return { ...render(createElement(Harness)), onDone };
}
describe("登录等待页实际渲染", () => {
  it("显示完整 URL、浏览器状态，遮罩粘贴且 Esc 清理", async () => {
    const { s } = session();
    browser();
    const ui = screen();
    await settle(() => ui.lastFrame()?.includes("已在浏览器打开") === true);
    const unwrapped = (ui.lastFrame() ?? "")
      .split("\n")
      .map((line) => line.replace(/^[│ ]+|[│ ]+$/g, ""))
      .join("");
    expect(unwrapped).toContain(s.authorizeUrl);
    expect(required(vi.mocked(startProviderLogin).mock.calls[0])[2]?.entry).toEqual(entry);
    ui.stdin.write("mock-secret-code");
    await settle(() => ui.lastFrame()?.includes("****************") === true);
    expect(ui.lastFrame()).not.toContain("mock-secret-code");
    ui.stdin.write("\x1b");
    await settle(() => ui.onDone.mock.calls.length === 1);
    expect(ui.onDone).toHaveBeenCalledWith({ kind: "cancel" });
    expect(s.cancel).toHaveBeenCalled();
  });
  it("一次显示 key，确认后清除，不进日志与下一页", async () => {
    const { resolve } = session();
    browser();
    const ui = screen();
    await settle(() => ui.lastFrame()?.includes("粘贴授权码") === true);
    const callback = required(
      required(required(vi.mocked(startProviderLogin).mock.calls[0])[2]).onUnstoredKey,
    );
    const displaying = callback("mock-once-visible-key", "OPENROUTER_API_KEY");
    await settle(() => ui.lastFrame()?.includes("mock-once-visible-key") === true);
    expect(ui.lastFrame()).toContain("PowerShell:");
    ui.stdin.write("\r");
    await displaying;
    resolve({ providerId: entry.id });
    await settle(() => ui.onDone.mock.calls.length === 1);
    expect(ui.lastFrame()).not.toContain("mock-once-visible-key");
    expect(ui.onDone).toHaveBeenCalledWith({ kind: "logged-in", providerId: entry.id });
  });
  it("mock 等待页与服务商详情帧可截图，不打开真实账号", async () => {
    session();
    browser(new Error("mock unavailable"));
    const ui = screen();
    await settle(() => ui.lastFrame()?.includes("请复制到浏览器") === true);
    ui.stdin.write("mock-screenshot-code");
    await settle(() => ui.lastFrame()?.includes("********************") === true);
    const dir = process.env.NOCTURNE_LOGIN_FRAMES_DIR;
    if (dir) writeFileSync(`${dir}/provider-login-frame.txt`, required(ui.lastFrame()), "utf8");
    const detail = render(
      <ProviderDialog
        providerId="openrouter"
        deleteDisabled={false}
        width={100}
        height={24}
        active={false}
        onActivate={() => undefined}
      />,
    );
    await settle(() => detail.lastFrame()?.includes("重新登录") === true);
    expect(detail.lastFrame()).toContain("退出登录");
    if (dir)
      writeFileSync(`${dir}/provider-detail-frame.txt`, required(detail.lastFrame()), "utf8");
  });
});
