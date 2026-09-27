/**
 * 复制到剪贴板（ADR-0021 第 1 条）：两条路同时走——系统剪贴板命令与
 * OSC 52 序列，任一成功即算成功。剪贴板写入在 TUI 内完成，不经过 Core；
 * 命令行参数固定，文本一律经子进程 stdin 传入（不拼进命令行）。
 */
import { spawn as nodeSpawn } from "node:child_process";

/** OSC 52：终端自己的剪贴板通道（Windows Terminal 可放行） */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export interface CopyDeps {
  platform?: NodeJS.Platform | undefined;
  spawn?: typeof nodeSpawn | undefined;
  /** 往终端写 OSC 52（经 cursor.ts 的帧外写出通道）；返回 false 视为失败 */
  osc52?: ((seq: string) => boolean) | undefined;
}

type SpawnFn = typeof nodeSpawn;

const POWERSHELL_COPY = [
  "powershell",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
  ],
] as const;

function candidates(platform: NodeJS.Platform): readonly (readonly [string, readonly string[]])[] {
  switch (platform) {
    case "win32":
      return [POWERSHELL_COPY];
    case "darwin":
      return [["pbcopy", []]];
    default:
      return [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
      ];
  }
}

function tryClipboardCommand(
  cmd: string,
  args: readonly string[],
  text: string,
  spawn: SpawnFn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [...args], { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    child.once("error", () => {
      done(false);
    });
    child.once("exit", (code) => {
      done(code === 0);
    });
    child.stdin.once("error", () => {
      done(false);
    });
    try {
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      done(false);
    }
  });
}

async function systemCopy(
  text: string,
  platform: NodeJS.Platform,
  spawn: SpawnFn,
): Promise<boolean> {
  for (const [cmd, args] of candidates(platform)) {
    if (await tryClipboardCommand(cmd, args, text, spawn)) return true;
  }
  return false;
}

/**
 * 复制文本：系统剪贴板与 OSC 52 并行。返回成功通道；都失败返回空数组。
 */
export async function copyText(
  text: string,
  deps: CopyDeps = {},
): Promise<readonly ("system" | "osc52")[]> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const osc = deps.osc52;
  const oscResult = Promise.resolve().then(() => {
    if (osc === undefined) return false;
    return osc(osc52Sequence(text));
  });
  const [systemOk, oscOk] = await Promise.all([systemCopy(text, platform, spawnFn), oscResult]);
  const ok: ("system" | "osc52")[] = [];
  if (systemOk) ok.push("system");
  if (oscOk) ok.push("osc52");
  return ok;
}
