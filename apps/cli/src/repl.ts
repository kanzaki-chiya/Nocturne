/**
 * 交互模式（cli.md 第 3 节）：nctrn> 提示符循环、斜杠命令、
 * 权限确认提示、Ctrl+C/Ctrl+D。只用 node:readline。
 */
import { createInterface, type Interface } from "node:readline";

type HistoryInterface = Interface & { history: string[] };

import type { Runtime, RuntimeConfig, RuntimeSession, SessionSummary } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { readlineCompleter } from "@nocturne/tui/slash-catalog";

import { runSlashCommand, type CommandDeps } from "./commands.js";
import { createEventWriter, renderEvent, renderPermissionPrompt } from "./render.js";
import {
  createWizardIo,
  runAddWizardInSession,
  runKeyWizardInSession,
  runThinkingWizardInSession,
} from "./setup.js";
import { sessionOpenNotes, type NewSessionFn, type SessionSwitcher } from "./session-switch.js";

export interface ReplIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

export interface ReplOptions {
  /** /resume 会话切换（cli.md 第 4 节）；缺省时 /resume 提示不可用 */
  switchSession?: SessionSwitcher | undefined;
  newSession?: NewSessionFn | undefined;
  /** /provider 命令桥（cli.md 第 4 节）；缺省时 /provider 提示不可用 */
  provider?:
    | {
        config: RuntimeConfig;
        reloadConfig: () => Promise<RuntimeConfig>;
        workspaceRoot?: string | undefined;
      }
    | undefined;
}

function write(io: ReplIo, channel: "stdout" | "stderr", text: string): void {
  (channel === "stdout" ? io.stdout : io.stderr).write(text);
}

/** /resume 待决状态：编号选择中 或 跨目录确认中 */
type PendingResume = { rows: SessionSummary[] } | { confirmId: string; root: string };

export async function runRepl(
  initialSession: RuntimeSession,
  runtime: Runtime,
  io: ReplIo,
  opts: ReplOptions = {},
): Promise<number> {
  // /resume 切换后 session 指向新会话；事件订阅随之换绑
  let session = initialSession;
  let busy = false;
  /** 进行中的 Turn 的 Promise；close 后由关闭路径等待其收敛 */
  let activeTurn: Promise<unknown> | undefined;
  /** readline 已关闭：此后任何异步回调不得再 rl.prompt() */
  let closed = false;
  /** 等待用户回答的权限请求（permission.requested 优先于普通输入） */
  let pendingPermission: { requestId: string } | undefined;
  /** /resume 的行内交互状态（编号选择 / 跨目录确认） */
  let pendingResume: PendingResume | undefined;
  // 交互模式全部走 stdout：由写出器补齐流式文本与状态行之间的换行
  const out = createEventWriter((channel, text) => {
    write(io, channel, text);
  });

  const onEvent = (ev: RuntimeEvent): void => {
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
  };
  let unsubscribe = session.subscribe(onEvent);

  /** 向导运行中：/provider add/key 暂停外层 readline（readline 内部对
   *  stdin 的 keypress/回显监听无法干净摘除，只能整实例重建） */
  let wizardWork: (() => Promise<void>) | undefined;

  let providerIds: string[] = [...new Set(runtime.listModels().map((model) => model.ref.provider))];
  const refreshProviders = (): void => {
    const bridge = opts.provider;
    if (bridge === undefined) return;
    void bridge.config.describeProviders(bridge.workspaceRoot).then(
      (rows) => {
        providerIds = rows.map((row) => row.id);
      },
      () => {
        /* 补全用上一份缓存 */
      },
    );
  };
  refreshProviders();
  const makeRl = (): HistoryInterface =>
    createInterface({
      input: io.stdin,
      output: io.stdout,
      prompt: "nctrn> ",
      terminal: io.stdin.isTTY === true,
      completer: (line: string) => {
        if (line.startsWith("/provider")) refreshProviders();
        return readlineCompleter(line, {
          effortLevels: session.reasoningEffortInfo().available,
          providerIds,
        });
      },
    }) as HistoryInterface;
  let rl = makeRl();
  if (io.stdin.isTTY === true) rl.history = (await session.readInputHistory()).reverse();
  let historyWrite = Promise.resolve();
  const remember = (line: string): void => {
    if (io.stdin.isTTY !== true) return;
    const current = session;
    historyWrite = historyWrite.then(() => current.recordInputHistory(line));
  };
  const reloadHistory = async (): Promise<void> => {
    if (io.stdin.isTTY !== true) return;
    await historyWrite;
    rl.history = (await session.readInputHistory()).reverse();
  };

  const prompt = (): void => {
    if (!closed) rl.prompt();
  };

  /** 会话切换：成功则换绑 session + 重订阅事件 + 打印分隔线 */
  const doSwitch = async (id: string, allowForeign = false): Promise<void> => {
    const switchSession = opts.switchSession;
    if (switchSession === undefined) {
      out.line("stdout", "! 当前环境不支持会话切换");
      return;
    }
    const res = await switchSession(id, { allowForeign });
    if (res.kind === "ok") {
      session = res.session;
      unsubscribe();
      unsubscribe = session.subscribe(onEvent);
      await reloadHistory();
      out.line("stdout", `── 已切换到会话 ${session.id} ──`);
      for (const n of sessionOpenNotes(session)) out.line("stderr", `! ${n}`);
      return;
    }
    if (res.kind === "foreign") {
      pendingResume = { confirmId: id, root: res.workspaceRoot };
      out.line("stdout", `? 会话绑定到 ${res.workspaceRoot}，与当前目录不同。仍要切换吗？[y/N] `);
      return;
    }
    if (res.kind === "busy") {
      out.line("stdout", "! 会话忙（Turn 进行中）；先 Ctrl+C 中断再切换");
      return;
    }
    out.line("stdout", `! ${res.message}`);
  };

  const startResumePick = async (): Promise<void> => {
    const rows = [...(await runtime.listSessions())].sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (rows.length === 0) {
      out.line("stdout", "（没有会话）");
      return;
    }
    pendingResume = { rows };
    const lines = rows.map((s, i) => {
      const cur = s.id === session.id ? "（当前）" : "";
      const locked = s.locked === true ? "  [locked]" : "";
      return `  ${i + 1}. ${s.id}  ${s.createdAt}  ${s.model.provider}/${s.model.model}  ${s.workspaceRoot}${locked}${cur}`;
    });
    out.line("stdout", ["选择要切换的会话（输入编号，空行取消）：", ...lines].join("\n"));
  };

  /** /provider add/key：设置向导工作项并关闭当前 rl——close handler 里
   *  跑向导、结束后重建 readline；Promise 在向导结束时 settle，由
   *  runSlashCommand 的 .then 统一恢复 prompt */
  const startWizard = (
    work: (wio: ReturnType<typeof createWizardIo>) => Promise<void>,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      wizardWork = async () => {
        try {
          await work(createWizardIo(io.stdin, io.stdout));
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      rl.close();
    });

  const done = new Promise<number>((resolve) => {
    const attach = (r: Interface): void => {
      r.on("line", (raw) => {
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

        // /resume 的行内交互：编号选择 / 跨目录确认（沿用启动的默认拒绝语义）
        if (pendingResume !== undefined) {
          const state = pendingResume;
          pendingResume = undefined;
          if ("rows" in state) {
            if (line === "") {
              out.line("stdout", "已取消");
            } else {
              const n = Number.parseInt(line, 10);
              const row = Number.isInteger(n) && n >= 1 ? state.rows[n - 1] : undefined;
              if (row === undefined) {
                out.line("stdout", `! 无效编号：${line}`);
              } else {
                void doSwitch(row.id).finally(prompt);
                return;
              }
            }
          } else if (/^y(es)?$/i.test(line)) {
            void doSwitch(state.confirmId, true).finally(prompt);
            return;
          } else {
            out.line("stdout", "已取消切换");
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
        remember(line);
        if (line === "/resume" || line.startsWith("/resume ")) {
          const arg = line.slice("/resume".length).trim();
          void (arg === "" ? startResumePick() : doSwitch(arg)).finally(prompt);
          return;
        }
        if (line === "/new" || line === "/clear") {
          void (async () => {
            if (opts.newSession === undefined) {
              out.line("stdout", "! 当前环境不支持新建会话");
              return;
            }
            const res = await opts.newSession();
            if (res.kind === "ok") {
              session = res.session;
              unsubscribe();
              unsubscribe = session.subscribe(onEvent);
              await reloadHistory();
              out.line("stdout", `── 新会话 ${session.id} ──`);
              for (const n of sessionOpenNotes(session)) out.line("stderr", `! ${n}`);
            } else {
              out.line(
                "stdout",
                res.kind === "busy"
                  ? "! 会话忙（Turn 进行中）；先中断再新建"
                  : `! ${res.kind === "error" ? res.message : "新建会话失败"}`,
              );
            }
          })().finally(prompt);
          return;
        }
        if (line.startsWith("/")) {
          const bridge = opts.provider;
          const deps: CommandDeps = {
            ...(bridge !== undefined
              ? {
                  provider: {
                    config: bridge.config,
                    reloadConfig: bridge.reloadConfig,
                    updateProviders: (rc) => {
                      runtime.updateProviders(rc);
                    },
                    workspaceRoot: bridge.workspaceRoot,
                  },
                }
              : {}),
            ...(bridge !== undefined && io.stdin.isTTY === true
              ? {
                  runAddWizard: () =>
                    startWizard((wio) =>
                      runAddWizardInSession(wio, {
                        config: bridge.config,
                        session,
                        reloadConfig: bridge.reloadConfig,
                        updateProviders: (rc) => {
                          runtime.updateProviders(rc);
                        },
                      }),
                    ),
                  runKeyWizard: (providerId: string) =>
                    startWizard((wio) =>
                      runKeyWizardInSession(wio, {
                        config: bridge.config,
                        providerId,
                        reloadConfig: bridge.reloadConfig,
                        updateProviders: (rc) => {
                          runtime.updateProviders(rc);
                        },
                      }),
                    ),
                  runThinkingWizard: (providerId: string) =>
                    startWizard((wio) =>
                      runThinkingWizardInSession(wio, {
                        config: bridge.config,
                        providerId,
                        reloadConfig: bridge.reloadConfig,
                        updateProviders: (rc) => {
                          runtime.updateProviders(rc);
                        },
                      }),
                    ),
                }
              : {}),
          };
          void runSlashCommand(
            line,
            session,
            runtime,
            {
              print: (t) => {
                out.line("stdout", t);
              },
            },
            deps,
          ).then((outcome) => {
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
      r.on("SIGINT", () => {
        if (pendingResume !== undefined) {
          pendingResume = undefined;
          out.line("stdout", "已取消");
          prompt();
          return;
        }
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
      r.on("close", () => {
        // 向导接管：跑向导（异常经 wizardWork 的 Promise 回到命令分发），
        // 结束后重建 readline；prompt 由 runSlashCommand 的 .then 恢复
        if (wizardWork !== undefined) {
          const work = wizardWork;
          wizardWork = undefined;
          void work().finally(async () => {
            closed = false;
            rl = makeRl();
            await reloadHistory();
            attach(rl);
          });
          return;
        }
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
    };
    attach(rl);
  });

  prompt();
  const code = await done;
  await historyWrite;
  unsubscribe();
  return code;
}
