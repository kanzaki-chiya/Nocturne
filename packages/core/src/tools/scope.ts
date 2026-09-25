/** ExecutionScope 的组装：Agent Loop 经此把会话级环境与 Turn 级参数合并 */
import type { ExecutionEnvironment, ExecutionScope, TurnCallScope } from "./types.js";

export function createExecutionScope(
  env: ExecutionEnvironment,
  call: TurnCallScope,
): ExecutionScope {
  return {
    cwd: call.cwd,
    workspaceRoot: call.workspaceRoot,
    paths: env.platform.paths,
    sessionId: call.sessionId,
    turnId: call.turnId,
    signal: call.signal,
    platform: env.platform,
    gate: env.gate,
    readState: env.readState,
    events: call.events,
    attachmentsDir: env.attachmentsDir,
    hooks: env.hooks,
    diagnostics: env.diagnostics,
    shellEnvStrip: env.shellEnvStrip,
  };
}
