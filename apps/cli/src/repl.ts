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
        rl.prompt();
        return;
      }

      if (line === "") {
        rl.prompt();
        return;
      }
      if (busy) {
        write(io, "stdout", "会话忙（Turn 进行中）；Ctrl+C 可中断\n");
        rl.prompt();
        return;
      }
      if (line.startsWith("/")) {
        void runSlashCommand(line, session, runtime, {
          print: (t) => {
            write(io, "stdout", `${t}\n`);
          },
        }).then((outcome) => {
          if (outcome === "exit") rl.close();
          else rl.prompt();
        });
        return;
      }
      busy = true;
      void session
        .submit({ text: line })
        .catch((e: unknown) => {
          write(io, "stderr", `! ${e instanceof Error ? e.message : String(e)}\n`);
        })
        .finally(() => {
          busy = false;
          rl.prompt();
        });
    });
    rl.on("SIGINT", () => {
      if (busy || pendingPermission !== undefined) {
        session.interrupt();
        pendingPermission = undefined;
        busy = false;
        write(io, "stdout", "\n! 已中断\n");
        rl.prompt();
        return;
      }
      rl.close();
    });
    rl.on("close", () => {
      resolve(0);
    });
  });

  rl.prompt();
  const code = await done;
  unsubscribe();
  return code;
}
