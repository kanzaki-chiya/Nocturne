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

const ACCOUNT_STORAGE_RISK =
  "明文保存在 credentials.json。文件被备份、同步或拷走时凭据随之泄漏；refresh token 在被撤销前可以持续使用。不会默认选择明文。";

async function askAccountStorage(io: LoginIo): Promise<"plaintext" | "memory"> {
  io.print(`系统凭据后端不可用。${ACCOUNT_STORAGE_RISK}`);
  for (;;) {
    const picked = await io.chooseMulti(
      "账号凭据保存方式（必须选择一项）：",
      ["保存到 credentials.json（明文，仅你可读）", "仅本次运行（退出后丢失，下次启动重新登录）"],
      { hint: ACCOUNT_STORAGE_RISK },
    );
    if (picked.length === 1 && picked[0] === 0) return "plaintext";
    if (picked.length === 1 && picked[0] === 1) return "memory";
    io.print("请只选择一项，不能留空。");
  }
}

export async function runProviderLogin(
  config: RuntimeConfig,
  providerId: string,
  io: LoginIo,
  options: LoginClientOptions = {},
): Promise<void> {
  const remote = options.remote ?? Boolean(process.env.SSH_CONNECTION ?? process.env.SSH_TTY);
  let shown = false;
  const phase = { choosingStorage: false, finished: false };
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
    chooseAccountStorage: async () => {
      phase.choosingStorage = true;
      io.cancelPending?.();
      try {
        return await askAccountStorage(io);
      } catch (error) {
        if (error instanceof WizardAbort) throw new ProviderLoginError("cancelled");
        throw error;
      }
    },
  }).catch((error: unknown) => {
    throw safeLoginError(error);
  });
  const isFinished = () => phase.finished;
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
            if (phase.choosingStorage || isFinished()) return;
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
        if (isFinished() || phase.choosingStorage || (shown && !options.signal?.aborted)) return;
        manualError = error;
        session.cancel();
      });
    }
    const outcome = await completion;
    if (manualError instanceof WizardAbort || options.signal?.aborted) throw new WizardAbort();
    if ("error" in outcome) throw outcome.error;
    io.step(
      `已登录 ${outcome.result.providerId}${outcome.result.account ? `（${outcome.result.account}）` : ""}`,
    );
  } finally {
    phase.finished = true;
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
