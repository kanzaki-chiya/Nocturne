/**
 * 交互模式（cli.md 第 3 节）：nctrn> 提示符循环、斜杠命令、
 * 权限确认提示、Ctrl+C/Ctrl+D。只用 node:readline。
 */
import { createInterface, type Interface } from "node:readline";

import type { Runtime, RuntimeSession } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";

import { runSlashCommand } from "./commands.js";
import { createEventWriter, renderEvent, renderPermissionPrompt } from "./render.js";

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
  // 交互模式全部走 stdout：由写出器补齐流式文本与状态行之间的换行
  const out = createEventWriter((channel, text) => {
    write(io, channel, text);
  });

  const unsubscribe = session.subscribe((ev: RuntimeEvent) => {
    if (ev.type === "permission.requested") {
      pendingPermission = { requestId: ev.payload.requestId };
      out.line(
        "stdout",
        renderPermissionPrompt(ev.payload.subjects, ev.payload.reason, ev.payload.options),
      );
      return;
    }
    out.write(renderEvent(ev, "interactive"));
    // 提示符前回到行首（交互模式的 turn.completed 总带用量行，这里是兜底）
    if (ev.type === "turn.completed") out.endLine("stdout");
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

      // 权限确认优先（cli.md 第 6 节）：a/s/p/d/x；
      // "d <文本>" 把其余内容作为给模型的反馈
      if (pendingPermission !== undefined) {
        const { requestId } = pendingPermission;
        const key = line === "" ? "d" : (line.split(/\s+/, 1)[0] ?? "d").toLowerCase();
        const feedback = line.length > key.length ? line.slice(key.length).trim() : undefined;
        const reply = (r: Parameters<typeof session.respondPermission>[1]) => {
          pendingPermission = undefined;
          void session.respondPermission(requestId, r);
        };
        if (key === "a" || key === "allow") {
          reply({ decision: "allow" });
        } else if (key === "s" || key === "session") {
          reply({ decision: "allow", remember: "session" });
        } else if (key === "p" || key === "project") {
          reply({ decision: "allow", remember: "project" });
        } else if (key === "x") {
          reply({ decision: "deny", stop: true });
        } else if (key === "d" || key === "deny") {
          reply({ decision: "deny", ...(feedback !== undefined ? { feedback } : {}) });
        } else {
          write(
            io,
            "stdout",
            "  请输入 a（允许一次）/ s（本会话允许）/ p（本项目始终允许）/ d（拒绝）/ x（拒绝并停止）\n",
          );
        }
        prompt();
        return;
      }

      if (line === "") {
        prompt();
        return;
      }
      if (busy) {
        out.line("stdout", "会话忙（Turn 进行中）；Ctrl+C 可中断");
        prompt();
        return;
      }
      if (line.startsWith("/")) {
        void runSlashCommand(line, session, runtime, {
          print: (t) => {
            out.line("stdout", t);
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
          out.line("stderr", `! ${e instanceof Error ? e.message : String(e)}`);
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
        out.line("stdout", "! 已中断");
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
