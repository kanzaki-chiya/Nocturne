/**
 * 宿主入口给 process.env 写入自己需要的变量（tools.md 第 3 节"子进程环境"）。
 *
 * 只在变量未设置时写入，并登记到 NOCTURNE_HOST_INJECTED_ENV：core 的进程运行器据此不把它
 * 传给工具、Hook、MCP、外部 agent 启动的子进程。用户启动前自己设置的变量原样保留且不登记。
 */
export const HOST_INJECTED_ENV = "NOCTURNE_HOST_INJECTED_ENV";

export function injectHostEnv(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[name] !== undefined) return;
  env[name] = value;
  const registered = (env[HOST_INJECTED_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (!registered.includes(name)) registered.push(name);
  env[HOST_INJECTED_ENV] = registered.join(",");
}
