#!/usr/bin/env node
/**
 * nctrn 入口（cli.md）：参数解析 → 分层配置 → 会话选择（新建/恢复）→ REPL 或单发。
 * 退出码：0 成功 / 1 Turn 失败 / 2 用法、配置或恢复错误 / 130 中断。
 */
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  createPlatform,
  createRuntime,
  RuntimeCommandError,
  SessionError,
  type RuntimeSession,
} from "@nocturne/core";

import { HELP_TEXT, parseArgs, UsageError, type CliArgs } from "./args.js";
import { collectConfig, effectiveProviderId, normalizeModelRef } from "./config.js";
import { renderEvent } from "./render.js";
import { runRepl } from "./repl.js";

const VERSION = "0.0.0";

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function exitCodeFor(reason: string): number {
  if (reason === "done") return 0;
  if (reason === "aborted") return 130;
  return 1;
}

function errorText(e: unknown): string {
  if (e instanceof RuntimeCommandError || e instanceof SessionError) {
    return `${e.code}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 恢复摘要（cli.md 第 2 节）：有修复才打印 */
function printRecovery(session: RuntimeSession): void {
  const r = session.recovery;
  if (r === undefined) return;
  const parts: string[] = [];
  if (r.truncatedTail !== undefined) parts.push(`损坏尾部已截断（另存 ${r.truncatedTail}）`);
  if (r.interruptedCalls > 0) parts.push(`${r.interruptedCalls} 个未完成调用标记为 interrupted`);
  if (r.recoveredTurns > 0)
    parts.push(`${r.recoveredTurns} 个未完成 Turn 已按 process_exited 收束`);
  if (parts.length > 0) {
    process.stderr.write(`! 会话恢复时已修复：${parts.join("；")}\n`);
  }
}

/** 跨目录恢复的交互确认（cli.md 第 2 节：默认拒绝） */
async function confirmForeignWorkspace(workspaceRoot: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `? 会话绑定到 ${workspaceRoot}，与当前目录不同。仍要恢复吗？[y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${HELP_TEXT}`);
      return 2;
    }
    throw e;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const platform = createPlatform();
  let cwd: string;
  try {
    cwd = await platform.resolveReal(process.cwd());
  } catch {
    try {
      cwd = realpathSync(process.cwd());
    } catch {
      cwd = process.cwd();
    }
  }

  // trust / untrust：只写 trust.json，不校验 Provider（cli.md 第 2 节）
  if (args.command !== undefined) {
    const collected = await collectConfig(args, platform, undefined, { requireModel: false });
    if (!collected.ok) {
      process.stderr.write(`配置错误：\n${collected.problems.map((p) => `  - ${p}`).join("\n")}\n`);
      return 2;
    }
    const trusted = args.command === "trust";
    try {
      await collected.config.runtime.setWorkspaceTrusted(cwd, trusted);
    } catch (e) {
      process.stderr.write(`! ${errorText(e)}\n`);
      return 1;
    }
    process.stdout.write(trusted ? `已信任当前目录：${cwd}\n` : `已取消信任当前目录：${cwd}\n`);
    return 0;
  }

  const isResume = args.resume !== undefined || args.continueSession;
  const collected = await collectConfig(args, platform, undefined, {
    requireModel: !isResume,
  });
  if (!collected.ok) {
    process.stderr.write(`配置不完整：\n${collected.problems.map((p) => `  - ${p}`).join("\n")}\n`);
    return 2;
  }
  const { runtime: runtimeConfig, model } = collected.config;
  for (const w of collected.config.warnings) {
    process.stderr.write(`! ${w}\n`);
  }

  const runtime = await createRuntime({
    cwd,
    config: runtimeConfig,
    interactive: !args.print,
    permissions: { autoApproveAsk: args.yes },
  });

  // --sessions：只读列表（cli.md 第 2 节）
  if (args.sessions) {
    const list = await runtime.listSessions();
    const rows = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (rows.length === 0) {
      process.stdout.write("（没有会话）\n");
      return 0;
    }
    for (const s of rows) {
      const locked = s.locked === true ? "  [locked]" : "";
      process.stdout.write(
        `${s.id}  ${s.createdAt}  ${s.model.provider}/${s.model.model}  ${s.workspaceRoot}${locked}\n`,
      );
    }
    return 0;
  }

  // ── 会话选择：新建 / --resume / --continue ──
  // --preset 只对新建会话生效（cli.md 第 2 节）：恢复会话时预设以日志为准
  const continueCandidates = args.continueSession ? await runtime.listSessions({ cwd }) : [];
  const resumeTarget = args.resume !== undefined || continueCandidates.length > 0;
  if (resumeTarget && args.preset !== undefined) {
    process.stderr.write("! --preset 仅对新建会话生效；恢复会话请用 /preset 切换\n");
    return 2;
  }

  let session: RuntimeSession;
  try {
    if (args.resume !== undefined) {
      const override =
        args.model !== undefined
          ? normalizeModelRef(args.model, effectiveProviderId(args))
          : undefined;
      if (override !== undefined && !override.ok) {
        process.stderr.write(`! ${override.problem}\n`);
        return 2;
      }
      session = await runtime.resumeSession(args.resume, {
        force: args.forceUnlock,
        ...(override?.ok === true ? { model: override.ref } : {}),
      });
    } else if (args.continueSession) {
      const latest = continueCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (latest !== undefined) {
        session = await runtime.resumeSession(latest.id, { force: args.forceUnlock });
      } else {
        if (model === undefined) {
          process.stderr.write("! 缺少模型：--model <id> / NOCTURNE_MODEL / 配置文件 model\n");
          return 2;
        }
        session = await runtime.createSession({
          model,
          ...(args.preset !== undefined ? { permissionPreset: args.preset } : {}),
        });
      }
    } else {
      if (model === undefined) {
        process.stderr.write("! 缺少模型：--model <id> / NOCTURNE_MODEL / 配置文件 model\n");
        return 2;
      }
      session = await runtime.createSession({
        model,
        ...(args.preset !== undefined ? { permissionPreset: args.preset } : {}),
      });
    }
  } catch (e) {
    process.stderr.write(`! ${errorText(e)}\n`);
    return 2;
  }

  // 跨目录恢复：交互模式确认（默认拒绝），非交互直接报错（cli.md 第 2 节）
  const sessionRoot = session.state().meta.workspaceRoot;
  if (!platform.paths.equals(sessionRoot, cwd)) {
    if (args.print) {
      process.stderr.write(
        `! 会话绑定到 ${sessionRoot}，与当前目录 ${cwd} 不同；非交互模式拒绝跨目录恢复\n`,
      );
      await session.close();
      return 2;
    }
    const ok = await confirmForeignWorkspace(sessionRoot);
    if (!ok) {
      process.stderr.write("! 已取消恢复\n");
      await session.close();
      return 2;
    }
  }

  printRecovery(session);
  for (const w of session.warnings) {
    process.stderr.write(`! ${w}\n`);
  }

  let prompt: string | undefined = args.prompt;
  if (args.print && prompt === "") {
    process.stderr.write("prompt 为空\n");
    await session.close();
    return 2;
  }
  if (args.print && prompt === undefined) {
    if (process.stdin.isTTY) {
      process.stderr.write('非交互模式需要 prompt：nctrn -p "<prompt>" 或经 stdin 传入\n');
      await session.close();
      return 2;
    }
    prompt = await readStdin(process.stdin);
    if (prompt === "") {
      process.stderr.write("stdin 为空\n");
      await session.close();
      return 2;
    }
  }

  if (!args.print) {
    process.on("SIGINT", () => {
      /* REPL 自己处理 SIGINT（rl "SIGINT" 事件）；这里兜底防意外退出 */
    });
    const code = await runRepl(session, runtime, {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
    });
    await session.close();
    return code;
  }

  // 非交互模式：模型文本 → stdout，其余 → stderr（render.ts 输出分流）
  const onSigint = () => {
    session.interrupt();
  };
  process.on("SIGINT", onSigint);
  const unsubscribe = session.subscribe((ev) => {
    for (const r of renderEvent(ev, "print")) {
      const stream = r.channel === "stdout" ? process.stdout : process.stderr;
      stream.write(r.channel === "stdout" ? r.text : `${r.text}\n`);
    }
  });

  let code = 0;
  try {
    const reason = await session.submit({ text: prompt });
    code = exitCodeFor(reason);
  } catch (e) {
    process.stderr.write(`! ${e instanceof Error ? e.message : String(e)}\n`);
    code = 1;
  } finally {
    process.off("SIGINT", onSigint);
    unsubscribe();
    await session.close();
  }
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`! ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
