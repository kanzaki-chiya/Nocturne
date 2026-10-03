/** CLI/TUI 共用的登录客户端；Core 负责授权，客户端负责浏览器与输入。 */
import { execFile } from "node:child_process";
import {
  describeAccountStorage,
  describeProviderSetup,
  startDraftProviderLogin,
  startProviderLogin,
  type AccountStorageSetup,
  type DraftLoginTarget,
  type ProviderEntryConfig,
  type RuntimeConfig,
  ProviderLoginError,
} from "@nocturne/core";

import { SetupAbort, type SetupPrompts } from "./provider-prompts.js";

export type LoginPrompts = SetupPrompts & { cancelPending?: () => void };
export interface LoginClientOptions {
  entry?: ProviderEntryConfig;
  signal?: AbortSignal;
  remote?: boolean;
  openBrowser?: (url: string) => Promise<boolean>;
  onWaiting?: (authorizeUrl: string, browserOpened: boolean, userCode?: string) => void;
  showUnstoredKey?: (key: string, envName: string) => Promise<void>;
}

/** 系统打开失败只返回 false，不输出命令、URL 或上游错误。 */
export async function openLoginBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!/^https?:\/\//.test(url) || /["\r\n]/.test(url)) return false;
  // Windows 不经 cmd：Node 给 cmd 参数加的反斜杠转义 cmd 不认，地址里的 & 会被当成命令分隔符。
  const command =
    platform === "win32" ? "rundll32.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return await new Promise<boolean>((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: 10_000,
      },
      (error) => {
        resolve(error === null);
      },
    );
  });
}

export function unstoredKeyCommands(key: string, envName: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error("环境变量名称无效");
  const shellKey = key.replace(/'/g, "'\\''");
  const powershellKey = key.replace(/'/g, "''");
  return `PowerShell: $env:${envName}='${powershellKey}'\nbash: export ${envName}='${shellKey}'`;
}

/** 无系统凭据后端的账号型登录：先让用户显式选择保存位置，选定后才启动登录（没有默认值） */
async function askAccountStorage(
  io: LoginPrompts,
  setup: AccountStorageSetup,
): Promise<"plaintext" | "memory"> {
  io.print(setup.notice);
  for (;;) {
    const picked = await io.chooseMulti(
      setup.prompt,
      setup.options.map((option) => option.label),
      { hint: setup.hint },
    );
    const only = picked.length === 1 ? setup.options[picked[0] ?? -1] : undefined;
    if (only !== undefined) return only.value;
    io.print(setup.retry);
  }
}

/**
 * 登录已保存的服务商（凭据直接写入凭据存储），或登录表单里尚未保存的草稿
 * （凭据暂存在 Core，返回的 loginId 交给 addProvider 提交）。
 */
export async function runProviderLogin(
  config: RuntimeConfig,
  target: string | DraftLoginTarget,
  io: LoginPrompts,
  options: LoginClientOptions = {},
): Promise<{ loginId?: string }> {
  const remote = options.remote ?? Boolean(process.env.SSH_CONNECTION ?? process.env.SSH_TTY);
  let shown = false;
  const phase = { finished: false };
  const isFinished = () => phase.finished;
  const loginOptions = {
    remote,
    onUnstoredKey: async (key: string, envName: string) => {
      if (shown) return;
      shown = true;
      if (options.showUnstoredKey) await options.showUnstoredKey(key, envName);
      else
        io.print(
          `系统凭据后端不可用；密钥仅显示这一次：\n${key}\n${unstoredKeyCommands(key, envName)}`,
        );
    },
  };
  const storage = await (async () => {
    const setup =
      typeof target === "string"
        ? describeAccountStorage(
            config,
            options.entry ?? config.base.providers.find((item) => item.id === target) ?? {},
          )
        : describeProviderSetup(config, target.presetId).credential.accountStorage;
    return setup === undefined ? undefined : await askAccountStorage(io, setup);
  })().catch((error: unknown) => {
    throw safeLoginError(error);
  });
  const session = await (
    typeof target === "string"
      ? startProviderLogin(config, target, {
          ...loginOptions,
          ...(options.entry ? { entry: options.entry } : {}),
          ...(storage !== undefined ? { accountStorage: storage } : {}),
        })
      : startDraftProviderLogin(config, target, {
          ...loginOptions,
          ...(storage !== undefined ? { accountStorage: storage } : {}),
        })
  ).catch((error: unknown) => {
    throw safeLoginError(error);
  });
  const cancel = () => {
    session.cancel();
    io.cancelPending?.();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  // 立即接住 completion 的拒绝，避免打开浏览器期间超时产生未处理拒绝。
  const completion = session.completion.then(
    (result) => ({ result }),
    (error: unknown) => ({ error: safeLoginError(error) }),
  );
  try {
    if (options.signal?.aborted) throw new SetupAbort();
    const opened =
      !remote &&
      (await (options.openBrowser ?? openLoginBrowser)(session.authorizeUrl).catch(() => false));
    const hint = [
      session.authorizeUrl,
      ...(session.userCode !== undefined ? [`确认码 ${session.userCode}`] : []),
      `${opened ? "已在浏览器打开" : "请复制到浏览器"} · Esc / Ctrl+C 取消`,
      ...(session.manualInput === "none" ? ["在浏览器确认后等待完成，无需粘贴"] : []),
    ].join("\n");
    if (options.onWaiting) options.onWaiting(session.authorizeUrl, opened, session.userCode);
    else io.print(hint);
    let manualError: unknown;
    if (session.manualInput !== "none") {
      void (async () => {
        while (!isFinished()) {
          let text: string;
          try {
            text = await io.askSecret(
              session.manualInput === "code" ? "粘贴授权码：" : "粘贴完整回调 URL：",
            );
          } catch (error) {
            if (isFinished()) return;
            throw error;
          }
          if (isFinished()) return;
          try {
            await session.submitManual(text.trim());
          } catch {
            if (!isFinished()) io.print("授权输入未被接受，请重新粘贴");
          }
        }
      })().catch((error: unknown) => {
        if (isFinished() || (shown && !options.signal?.aborted)) return;
        manualError = error;
        session.cancel();
      });
    }
    const outcome = await completion;
    if (manualError instanceof SetupAbort || options.signal?.aborted) throw new SetupAbort();
    if ("error" in outcome) throw outcome.error;
    io.step(
      `已登录 ${outcome.result.providerId}${outcome.result.account ? `（${outcome.result.account}）` : ""}`,
    );
    return session.loginId !== undefined ? { loginId: session.loginId } : {};
  } finally {
    phase.finished = true;
    options.signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Core 的错误类型只含固定文案；未知异常不能把授权内容带到界面。 */
export function safeLoginError(error: unknown): Error {
  return error instanceof ProviderLoginError || error instanceof SetupAbort
    ? error
    : new Error("登录未完成，请重新运行 /provider login");
}
