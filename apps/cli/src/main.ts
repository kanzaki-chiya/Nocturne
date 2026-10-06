#!/usr/bin/env node
/**
 * nctrn 入口（cli.md）：参数解析 → 分层配置 → 会话选择（新建/恢复）→ REPL 或单发。
 * 退出码：0 成功 / 1 Turn 失败 / 2 用法、配置或恢复错误 / 130 中断。
 */
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { createAcpConnector } from "@nocturne/acp";
import {
  configureEnvProxy,
  createPlatform,
  createRuntime,
  RuntimeCommandError,
  SessionError,
  type RuntimeSession,
} from "@nocturne/core";
import { createMcpConnector } from "@nocturne/mcp";

import { HELP_TEXT, parseArgs, resolveUiMode, UsageError, type CliArgs } from "./args.js";
import {
  collectConfig,
  configProblemsReport,
  effectiveProviderId,
  makeConfigLoader,
  normalizeModelRef,
} from "./config.js";
import { createEventWriter, renderEvent } from "./render.js";
import { runRepl } from "./repl.js";
import { runRpcStdio } from "./rpc.js";
import {
  createNewSession,
  createSessionSwitcher,
  sessionOpenNotes,
  type SessionHolder,
} from "./session-switch.js";
import { createSetupPrompts, runProviderSetupWizard, SetupAbort } from "./setup.js";

const VERSION = "0.6.0";

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

/** 打开会话后的提示（恢复修复摘要 + 聚合警告）：有内容才打印 */
function printSessionNotes(session: RuntimeSession): void {
  for (const n of sessionOpenNotes(session)) {
    process.stderr.write(`! ${n}\n`);
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
  // React/Ink 按 NODE_ENV 选构建：开发版渲染器每次提交都记 performance.measure 且不清理，
  // 长会话会攒到上百万条（内存泄漏并触发 MaxPerformanceEntryBufferExceededWarning）。
  // TUI 是动态导入，这里先设好；用户显式设置时尊重其值
  process.env.NODE_ENV ??= "production";
  const proxyWarning = configureEnvProxy();
  if (proxyWarning !== undefined) process.stderr.write(`! ${proxyWarning}\n`);

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

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  // 界面选择（cli.md §2）：TTY 默认 TUI；--cli 或非 TTY 行式；
  // 显式 --tui 在非 TTY 下报用法错（不降级）
  const uiMode = resolveUiMode(args, interactive);
  if (typeof uiMode === "object") {
    process.stderr.write(`! ${uiMode.error}\n`);
    return 2;
  }

  // 诊断开关（observability.md 第 1 节）：--debug / NOCTURNE_DEBUG；
  // 文件位置只由 --debug-file / NOCTURNE_DEBUG_FILE 决定，"-" 写 stderr
  const debugEnabled = args.debug || /^(1|true|yes|on)$/i.test(process.env.NOCTURNE_DEBUG ?? "");

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

  // rpc --stdio：RPC 服务端（ADR-0044）。stdout 被协议独占；正常情况下清理完成后事件循环自然排空，
  // 为防 MCP/HTTP 连接留有句柄，另设一个不阻止自然退出的兜底定时器强制结束
  // （不在这里直接 process.exit：Windows 上对仍在关闭的句柄调用会触发 libuv 断言崩溃）
  if (args.command === "rpc") {
    const code = await runRpcStdio({
      args,
      platform,
      cwd,
      version: VERSION,
      io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    });
    setTimeout(() => process.exit(code), 3000).unref();
    return code;
  }

  // setup：服务商配置向导（provider-setup.md 第 1 节）。
  // TTY 默认打开全屏服务商页（第 1 步）→ 无默认模型时模型页（第 2 步）；
  // --cli 用行式向导；stdin/stdout 非 TTY 时退出码 2 并提示手写配置
  if (args.command === "setup") {
    if (!interactive) {
      process.stderr.write(
        "! nctrn setup 需要交互式终端；非交互环境请手写 <NOCTURNE_HOME>/config.json（见 README）\n",
      );
      return 2;
    }
    const collected = await collectConfig(args, platform, undefined, { requireModel: false });
    if (!collected.ok) {
      process.stderr.write(`配置错误：\n${collected.problems.map((p) => `  - ${p}`).join("\n")}\n`);
      return 2;
    }
    if (!args.cli) {
      const runtime = await createRuntime({
        cwd,
        config: collected.config.runtime,
        interactive: true,
        permissions: { autoApproveAsk: args.yes },
        mcp: createMcpConnector(),
        externalAgents: createAcpConnector(platform, collected.config.runtime.base.externalAgents),
        debug: {
          enabled: debugEnabled,
          file: args.debugFile ?? process.env.NOCTURNE_DEBUG_FILE,
        },
      });
      const { runTui } = await import("@nocturne/tui");
      return await runTui({ setup: {} }, runtime, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        provider: {
          config: collected.config.runtime,
          reloadConfig: makeConfigLoader(args, platform),
          updateProviders: async (rc) => {
            await runtime.updateProviders(rc);
          },
          workspaceRoot: cwd,
        },
      });
    }
    try {
      await runProviderSetupWizard(
        createSetupPrompts(process.stdin, process.stdout),
        collected.config.runtime,
      );
    } catch (e) {
      if (e instanceof SetupAbort) {
        process.stdout.write("已取消\n");
        return 0;
      }
      process.stderr.write(`! ${errorText(e)}\n`);
      return 1;
    }
    return 0;
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
    // 交互模式（非 --print）且配置可在向导内补齐 → 首次配置流程
    // （ADR-0019 第 4 条）：无服务商来源 → 第 1 步服务商页；
    // 已有服务商但缺模型 → 第 2 步模型页。其余问题维持错误报告。
    // --cli 时首个服务商用行式向导；"缺模型"在行式下没有选模型页，维持错误报告。
    const missingModelOnly =
      collected.problems.length === 1 && collected.problems[0] !== undefined
        ? collected.problems[0].startsWith("缺少模型")
        : false;
    const setupStep = !collected.hasProviderSource ? 1 : missingModelOnly ? 2 : 0;
    if (setupStep > 0 && interactive && !args.print) {
      const runtimeConfig = await makeConfigLoader(args, platform)();
      if (args.cli) {
        if (setupStep === 2) {
          process.stderr.write(
            configProblemsReport(collected.problems, {
              tty: true,
              hasProviderSource: true,
            }),
          );
          return 2;
        }
        try {
          await runProviderSetupWizard(
            createSetupPrompts(process.stdin, process.stdout),
            runtimeConfig,
          );
          process.stdout.write("配置完成：运行 nctrn 启动；用 /model 选择模型\n");
          return 0;
        } catch (e) {
          if (e instanceof SetupAbort) {
            process.stdout.write("已取消\n");
            return 0;
          }
          process.stderr.write(`! ${errorText(e)}\n`);
          return 1;
        }
      }
      const runtime = await createRuntime({
        cwd,
        config: runtimeConfig,
        interactive: true,
        permissions: { autoApproveAsk: args.yes },
        mcp: createMcpConnector(),
        externalAgents: createAcpConnector(platform, runtimeConfig.base.externalAgents),
        debug: {
          enabled: debugEnabled,
          file: args.debugFile ?? process.env.NOCTURNE_DEBUG_FILE,
        },
      });
      // 会话由 setup.openSession 在流程完成后创建；holder 那一刻才被填充
      // （/resume 只可能出现在会话已挂载的主界面里，不会读到空槽）
      const holder: SessionHolder = { current: undefined as unknown as RuntimeSession };
      let created: RuntimeSession | undefined;
      const { runTui } = await import("@nocturne/tui");
      const code = await runTui(
        {
          setup: {
            step: setupStep as 1 | 2,
            openSession: async (ref: string) => {
              created = await runtime.createSession({
                model: ref,
                ...(args.preset !== undefined ? { permissionPreset: args.preset } : {}),
              });
              holder.current = created;
              return created;
            },
          },
        },
        runtime,
        {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          inline: args.inline,
          provider: {
            config: runtimeConfig,
            reloadConfig: makeConfigLoader(args, platform),
            updateProviders: async (rc) => {
              await runtime.updateProviders(rc);
            },
            workspaceRoot: cwd,
          },
          switchSession: createSessionSwitcher({ runtime, platform, cwd, holder }),
        },
      );
      await created?.close();
      return code;
    }
    // cli.md 第 2 节：交互终端提示 nctrn setup；非 TTY 输出保持脚本可解析
    process.stderr.write(
      configProblemsReport(collected.problems, {
        tty: interactive,
        hasProviderSource: collected.hasProviderSource,
      }),
    );
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
    mcp: createMcpConnector(),
    externalAgents: createAcpConnector(platform, runtimeConfig.base.externalAgents),
    debug: {
      enabled: debugEnabled,
      file: args.debugFile ?? process.env.NOCTURNE_DEBUG_FILE,
    },
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

  // TTY 默认 TUI（--cli 或非 TTY 走行式；--tui 为兼容参数）。
  // TUI 下打开提示由欢迎框下的通知块呈现（ADR-0019），此处不预打印
  const useTui = uiMode === "tui";
  if (!useTui) printSessionNotes(session);

  // /resume 会话切换：打开逻辑只有这一份，REPL 与 TUI 注入同一个 switcher；
  // holder 跟踪当前会话，退出时关闭的是切换后的那个
  const holder: SessionHolder = { current: session };
  const switchSession = createSessionSwitcher({ runtime, platform, cwd, holder });
  const newSession = createNewSession({ runtime, holder });

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
    if (useTui) {
      // 惰性加载 TUI：cli 的日常路径不支付 ink/react 的启动开销（ADR-0010）
      const { runTui } = await import("@nocturne/tui");
      const code = await runTui({ session }, runtime, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        inline: args.inline,
        switchSession,
        newSession,
        provider: {
          config: runtimeConfig,
          reloadConfig: makeConfigLoader(args, platform),
          updateProviders: async (rc) => {
            await runtime.updateProviders(rc);
          },
          workspaceRoot: cwd,
        },
      });
      await holder.current.close();
      return code;
    }
    process.on("SIGINT", () => {
      /* REPL 自己处理 SIGINT（rl "SIGINT" 事件）；这里兜底防意外退出 */
    });
    const code = await runRepl(
      session,
      runtime,
      {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
      },
      {
        switchSession,
        newSession,
        provider: {
          config: runtimeConfig,
          reloadConfig: makeConfigLoader(args, platform),
          workspaceRoot: cwd,
        },
      },
    );
    process.stdout.write(`会话 ${holder.current.id} 已保存，nctrn -c 继续\n`);
    await holder.current.close();
    return code;
  }

  // 非交互模式：模型文本 → stdout，其余 → stderr（render.ts 输出分流）
  const onSigint = () => {
    session.interrupt();
  };
  process.on("SIGINT", onSigint);
  const out = createEventWriter((channel, text) => {
    (channel === "stdout" ? process.stdout : process.stderr).write(text);
  });
  const unsubscribe = session.subscribe((ev) => {
    out.write(renderEvent(ev, "print"));
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
