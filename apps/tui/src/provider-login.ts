/** CLI/TUI 共用的登录客户端；Core 负责授权，客户端负责浏览器与输入。 */
import { execFile } from "node:child_process";
import {
  startProviderLogin,
  type ProviderEntryConfig,
  type RuntimeConfig,
  type WizardIo,
  WizardAbort,
  ProviderLoginError,
} from "@nocturne/core";

export type LoginIo = WizardIo & { cancelPending?: () => void };
export interface LoginClientOptions {
  entry?: ProviderEntryConfig;
  signal?: AbortSignal;
  remote?: boolean;
  openBrowser?: (url: string) => Promise<boolean>;
  onWaiting?: (authorizeUrl: string, browserOpened: boolean) => void;
  showUnstoredKey?: (key: string, envName: string) => Promise<void>;
}

/** 系统打开失败只返回 false，不输出命令、URL 或上游错误。 */
export async function openLoginBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!/^https?:\/\//.test(url) || /["\r\n]/.test(url)) return false;
  const command = platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/d", "/c", 'start "" "%NOCTURNE_AUTHORIZE_URL%"'] : [url];
  return await new Promise<boolean>((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: 10_000,
        env: platform === "win32" ? { ...process.env, NOCTURNE_AUTHORIZE_URL: url } : process.env,
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

export async function runProviderLogin(
  config: RuntimeConfig,
  providerId: string,
  io: LoginIo,
  options: LoginClientOptions = {},
): Promise<void> {
  const remote = options.remote ?? Boolean(process.env.SSH_CONNECTION ?? process.env.SSH_TTY);
  let shown = false;
  const session = await startProviderLogin(config, providerId, {
    ...(options.entry ? { entry: options.entry } : {}),
    remote,
    onUnstoredKey: async (key, envName) => {
      if (shown) return;
      shown = true;
      if (options.showUnstoredKey) await options.showUnstoredKey(key, envName);
      else
        io.print(
          `系统凭据后端不可用；密钥仅显示这一次：\n${key}\n${unstoredKeyCommands(key, envName)}`,
        );
    },
  }).catch((error: unknown) => {
    throw safeLoginError(error);
  });
  const lifecycle = { finished: false };
  const isFinished = () => lifecycle.finished;
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
    if (options.signal?.aborted) throw new WizardAbort();
    const opened =
      !remote &&
      (await (options.openBrowser ?? openLoginBrowser)(session.authorizeUrl).catch(() => false));
    if (options.onWaiting) options.onWaiting(session.authorizeUrl, opened);
    else
      io.print(
        `${session.authorizeUrl}\n${opened ? "已在浏览器打开" : "请复制到浏览器"} · Esc / Ctrl+C 取消`,
      );
    let manualError: unknown;
    void (async () => {
      while (!isFinished()) {
        const text = await io.askSecret(
          session.manualInput === "code" ? "粘贴授权码：" : "粘贴完整回调 URL：",
        );
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
    const outcome = await completion;
    if (manualError instanceof WizardAbort || options.signal?.aborted) throw new WizardAbort();
    if ("error" in outcome) throw outcome.error;
    io.step(
      `已登录 ${outcome.result.providerId}${outcome.result.account ? `（${outcome.result.account}）` : ""}`,
    );
  } finally {
    lifecycle.finished = true;
    options.signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Core 的错误类型只含固定文案；未知异常不能把授权内容带到界面。 */
export function safeLoginError(error: unknown): Error {
  return error instanceof ProviderLoginError || error instanceof WizardAbort
    ? error
    : new Error("登录未完成，请重新运行 /provider login");
}
