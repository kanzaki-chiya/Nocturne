#!/usr/bin/env node
/**
 * nctrn 入口（cli.md）：参数解析 → 配置收集 → Runtime → REPL 或单发。
 * 退出码：0 成功 / 1 Turn 失败 / 2 用法或配置错误 / 130 中断。
 */
import { realpathSync } from "node:fs";

import { createRuntime, RuntimeCommandError } from "@nocturne/core";

import { HELP_TEXT, parseArgs, UsageError } from "./args.js";
import { collectConfig } from "./config.js";
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

async function main(): Promise<number> {
  let args;
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

  const collected = collectConfig(args);
  if (!collected.ok) {
    process.stderr.write(`配置不完整：\n${collected.problems.map((p) => `  - ${p}`).join("\n")}\n`);
    return 2;
  }
  const { providerConfig, model } = collected.config;

  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    cwd = process.cwd();
  }

  let prompt: string | undefined = args.prompt;
  if (args.print && prompt === "") {
    process.stderr.write("prompt 为空\n");
    return 2;
  }
  if (args.print && prompt === undefined) {
    if (process.stdin.isTTY) {
      process.stderr.write('非交互模式需要 prompt：nctrn -p "<prompt>" 或经 stdin 传入\n');
      return 2;
    }
    prompt = await readStdin(process.stdin);
    if (prompt === "") {
      process.stderr.write("stdin 为空\n");
      return 2;
    }
  }

  const runtime = await createRuntime({
    cwd,
    providerConfigs: [providerConfig],
    interactive: !args.print,
    permissions: { autoApproveAsk: args.yes },
  });

  let session;
  try {
    session = await runtime.createSession({ model });
  } catch (e) {
    const msg =
      e instanceof RuntimeCommandError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    process.stderr.write(`! ${msg}\n`);
    return 2;
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
