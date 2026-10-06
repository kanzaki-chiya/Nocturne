import { spawnSync } from "node:child_process";

/**
 * Windows 下 npm/pnpm 等 .cmd 包装的可执行文件必须经 cmd.exe 调用
 * （Node 拒绝在没有 shell 的情况下直接 spawn .cmd/.bat）。
 * shell 模式下 Node 只做空格拼接，需要自行给参数加引号并拼成
 * 单条命令字符串，避免 args+shell 的 DEP0190 警告。
 */
function quoteWin(arg) {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * 运行子进程并透传输出；失败时抛出带退出码的错误。
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean }} [options]
 * @returns {string} capture 时返回 stdout 文本，否则为空串
 */
export function run(cmd, args = [], options = {}) {
  const win = process.platform === "win32";
  const command = win ? [cmd, ...args].map(quoteWin).join(" ") : cmd;
  const result = spawnSync(command, win ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    shell: win,
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 退出码 ${result.status}`);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}
