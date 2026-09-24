/**
 * 交互模式（cli.md 第 3 节）：nctrn> 提示符循环、斜杠命令、
 * 权限确认提示、Ctrl+C/Ctrl+D。只用 node:readline。
 */
import { createInterface, type Interface } from "node:readline";

import type { Runtime, RuntimeSession } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";

import { runSlashCommand } from "./commands.js";
import { renderEvent, renderPermissionPrompt } from "./render.js";

export interface ReplIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

function write(io: ReplIo, channel: "stdout" | "stderr", text: string): void {
  (channel === "stdout" ? io.stdout : io.stderr).write(text);
}

export async function runRepl(
  session: RuntimeSession,
  runtime: Runtime,
  io: ReplIo,
): Promise<number> {
  let busy = false;
  /** 进行中的 Turn 的 Promise；close 后由关闭路径等待其收敛 */
  let activeTurn: Promise<unknown> | undefined;
  /** readline 已关闭：此后任何异步回调不得再 rl.prompt() */
  let closed = false;
  /** 等待用户回答的权限请求（permission.requested 优先于普通输入） */
  let pendingPermission: { requestId: string } | undefined;
  let lastAssistantHadText = false;

  const unsubscribe = session.subscribe((ev: RuntimeEvent) => {
    if (ev.type === "permission.requested") {
      pendingPermission = { requestId: ev.payload.requestId };
      write(io, "stdout", `${renderPermissionPrompt(ev.payload.subjects, ev.payload.reason)}\n`);
      return;
    }
    for (const r of renderEvent(ev, "interactive")) {
      write(io, r.channel, r.channel === "stdout" ? r.text : `${r.text}\n`);
    }
    if (ev.type === "message.assistant.delta") {
      lastAssistantHadText = true;
    }
    if (ev.type === "turn.completed") {
      if (lastAssistantHadText) write(io, "stdout", "\n");
      lastAssistantHadText = false;
    }
  });

  const rl: Interface = createInterface({
    input: io.stdin,
    output: io.stdout,
    prompt: "nctrn> ",
    terminal: io.stdin.isTTY === true,
  });

  const prompt = (): void => {
    if (!closed) rl.prompt();
  };

  const done = new Promise<number>((resolve) => {
    rl.on("line", (raw) => {
      const line = raw.trim();

      // 权限确认优先（cli.md 第 6 节）：只允许 a/d
      if (pendingPermission !== undefined) {
        const { requestId } = pendingPermission;
        if (line === "a" || line === "allow") {
          pendingPermission = undefined;
          void session.respondPermission(requestId, { decision: "allow" });
        } else if (line === "d" || line === "deny" || line === "") {
          pendingPermission = undefined;
          void session.respondPermission(requestId, { decision: "deny" });
        } else {
          write(io, "stdout", "  请输入 a（允许一次）或 d（拒绝）\n");
        }
        prompt();
        return;
      }

      if (line === "") {
        prompt();
        return;
      }
      if (busy) {
        write(io, "stdout", "会话忙（Turn 进行中）；Ctrl+C 可中断\n");
        prompt();
        return;
      }
      if (line.startsWith("/")) {
        void runSlashCommand(line, session, runtime, {
          print: (t) => {
            write(io, "stdout", `${t}\n`);
          },
        }).then((outcome) => {
          if (outcome === "exit") rl.close();
          else prompt();
        });
        return;
      }
      busy = true;
      activeTurn = session
        .submit({ text: line })
        .catch((e: unknown) => {
          write(io, "stderr", `! ${e instanceof Error ? e.message : String(e)}\n`);
        })
        .finally(() => {
          busy = false;
          prompt();
        });
    });
    rl.on("SIGINT", () => {
      if (busy || pendingPermission !== undefined) {
        session.interrupt();
        pendingPermission = undefined;
        busy = false;
        write(io, "stdout", "\n! 已中断\n");
        prompt();
        return;
      }
      rl.close();
    });
    rl.on("close", () => {
      closed = true;
      // Turn 仍在进行：中断并等其收敛（finally 回调由 closed 守护），
      // 保证不会有 prompt-after-close
      if (busy && activeTurn !== undefined) {
        session.interrupt();
        void activeTurn.finally(() => {
          resolve(0);
        });
        return;
      }
      resolve(0);
    });
  });

  prompt();
  const code = await done;
  unsubscribe();
  return code;
}
