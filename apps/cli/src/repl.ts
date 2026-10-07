/**
 * 交互模式（cli.md 第 3 节）：nctrn> 提示符循环、斜杠命令、
 * 权限确认提示、Ctrl+C/Ctrl+D。只用 node:readline。
 */
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

type HistoryInterface = Interface & { history: string[] };

import {
  completeFileRefs,
  parseSkillSlash,
  type Runtime,
  type RuntimeConfig,
  type RuntimeSession,
  type SessionSummary,
} from "@nocturne/core";
import {
  rewindNotification,
  type RewindMode,
  type RewindTarget,
  type QuestionAnswer,
  type QuestionItem,
  type RuntimeEvent,
} from "@nocturne/core/protocol";
import { completeLine, skillCompletionLines } from "./completer.js";
import { parseExternalAgentSlash, type ExternalSlashAgent } from "@nocturne/tui/slash-catalog";

import { runSlashCommand, type CommandDeps } from "./commands.js";
import {
  createEventWriter,
  renderEvent,
  renderPermissionPrompt,
  renderQuestionPrompt,
} from "./render.js";
import {
  createSetupPrompts,
  runAddWizardInSession,
  runKeyWizardInSession,
  runModelWizardInSession,
} from "./setup.js";
import { sessionOpenNotes, type NewSessionFn, type SessionSwitcher } from "./session-switch.js";

export interface ReplIo {
  stdout: NodeJS.WritableStream & { columns?: number };
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
type PendingRewind =
  { rows: RewindTarget[] } | { target: RewindTarget; mode?: RewindMode | "fork" };

export async function runRepl(
  initialSession: RuntimeSession,
  runtime: Runtime,
  io: ReplIo,
  opts: ReplOptions = {},
): Promise<number> {
  // /resume 切换后 session 指向新会话；事件订阅随之换绑
  let session = initialSession;
  let busy = false;
  let sessionCommand = false;
  /** 进行中的 Turn 的 Promise；close 后由关闭路径等待其收敛 */
  let activeTurn: Promise<unknown> | undefined;
  /** readline 已关闭：此后任何异步回调不得再 rl.prompt() */
  let closed = false;
  /** 等待用户回答的权限请求（permission.requested 优先于普通输入） */
  let pendingPermission: { requestId: string; options: readonly string[] } | undefined;
  /** 等待用户回答的提问（ADR-0032 §6 逐行交互；与权限确认同级优先） */
  let pendingQuestion:
    | {
        requestId: string;
        callId: string;
        questions: QuestionItem[];
        /** 正在回答的题号 */
        index: number;
        answers: QuestionAnswer[];
      }
    | undefined;
  /** /resume 的行内交互状态（编号选择 / 跨目录确认） */
  let pendingResume: PendingResume | undefined;
  let pendingRewind: PendingRewind | undefined;
  // 交互模式全部走 stdout：由写出器补齐流式文本与状态行之间的换行
  const out = createEventWriter((channel, text) => {
    write(io, channel, text);
  });

  /** 打印当前待答题目的逐行提示（ADR-0032 §6） */
  const printQuestion = (): void => {
    const pq = pendingQuestion;
    const q = pq?.questions[pq.index];
    if (pq === undefined || q === undefined) return;
    out.line("stdout", renderQuestionPrompt(q, pq.index, pq.questions.length));
  };

  const onEvent = (ev: RuntimeEvent): void => {
    if (ev.type === "session.rewound") {
      out.line("stdout", rewindNotification(ev.payload, session.durableEvents()));
      return;
    }
    if (ev.type === "question.requested") {
      pendingQuestion = {
        requestId: ev.payload.requestId,
        callId: ev.payload.callId,
        questions: ev.payload.questions,
        index: 0,
        answers: [],
      };
      printQuestion();
      return;
    }
    // 提问随对应调用结算（或 Turn 结束兜底）清除——中断/超时走这里
    if (
      (ev.type === "tool.completed" && pendingQuestion?.callId === ev.payload.callId) ||
      ev.type === "turn.completed"
    ) {
      pendingQuestion = undefined;
    }
    if (ev.type === "permission.requested") {
      pendingPermission = { requestId: ev.payload.requestId, options: ev.payload.options };
      out.line(
        "stdout",
        renderPermissionPrompt(
          ev.payload.subjects,
          ev.payload.reason,
          ev.payload.options,
          io.stdout.columns ?? 80,
        ),
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
  let externalAgents: readonly ExternalSlashAgent[] = (await session.describeExternalAgents())
    .agents;
  const makeRl = (): HistoryInterface =>
    createInterface({
      input: io.stdin,
      output: io.stdout,
      prompt: "nctrn> ",
      terminal: io.stdin.isTTY === true,
      completer: (
        line: string,
        callback: (error: Error | null, result: [string[], string]) => void,
      ) => {
        if (line.startsWith("/provider")) refreshProviders();
        void session
          .describeExternalAgents()
          .then((description) => {
            externalAgents = description.agents;
            const context = {
              effortLevels: session.reasoningEffortInfo().available,
              providerIds,
              skills: session.describeSkills().skills,
              externalAgents,
            };
            if (completeFileRefs(line, line.length, []) === undefined) {
              const lines = skillCompletionLines(line, context);
              if (lines.length) {
                callback(null, [[], line]);
                io.stdout.write(`\n${lines.join("\n")}\n`);
                if (!closed) rl.prompt(true);
                return;
              }
              callback(null, completeLine(line, context, []));
              return;
            }
            void session.fileIndex().then(
              (entries) => {
                callback(null, completeLine(line, context, entries));
              },
              () => {
                callback(null, [[], line]);
              },
            );
          })
          .catch((error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)), [[], line]);
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
    const current = session;
    void current
      .describeExternalAgents()
      .then((description) => {
        if (current !== session || closed) return;
        externalAgents = description.agents;
        rl.prompt();
      })
      .catch((error: unknown) => {
        out.line("stderr", `! ${error instanceof Error ? error.message : String(error)}`);
        if (!closed) rl.prompt();
      });
  };

  /** 会话切换：成功则换绑 session + 重订阅事件 + 打印分隔线 */
  const doSwitch = async (id: string, allowForeign = false): Promise<boolean> => {
    const switchSession = opts.switchSession;
    if (switchSession === undefined) {
      out.line("stdout", "! 当前环境不支持会话切换");
      return false;
    }
    const res = await switchSession(id, { allowForeign });
    if (res.kind === "ok") {
      session = res.session;
      unsubscribe();
      unsubscribe = session.subscribe(onEvent);
      await reloadHistory();
      out.line("stdout", `── 已切换到会话 ${session.id} ──`);
      for (const n of sessionOpenNotes(session)) out.line("stderr", `! ${n}`);
      return true;
    }
    if (res.kind === "foreign") {
      pendingResume = { confirmId: id, root: res.workspaceRoot };
      out.line("stdout", `? 会话绑定到 ${res.workspaceRoot}，与当前目录不同。仍要切换吗？[y/N] `);
      return false;
    }
    if (res.kind === "busy") {
      out.line("stdout", "! 会话忙（Turn 进行中）；先 Ctrl+C 中断再切换");
      return false;
    }
    out.line("stdout", `! ${res.message}`);
    return false;
  };

  const refill = (target: RewindTarget): void => {
    if (target.hasImages) out.line("stdout", "原消息的图片未放回");
    if (io.stdin.isTTY === true && !closed) rl.write(target.text);
    else out.line("stdout", `可修改后重发：${target.text}`);
  };
  const fork = async (target?: RewindTarget): Promise<void> => {
    if (!opts.switchSession) throw new Error("当前环境不支持会话切换");
    const id = await runtime.forkSession(session.id, target ? { targetSeq: target.seq } : {});
    if (await doSwitch(id)) {
      if (target) refill(target);
    }
  };
  const runSessionCommand = (work: () => Promise<void>): void => {
    busy = true;
    sessionCommand = true;
    activeTurn = work()
      .catch((e: unknown) => {
        out.line("stdout", `! ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        sessionCommand = false;
        busy = false;
        activeTurn = undefined;
        prompt();
      });
  };
  const startRewindPick = async (): Promise<void> => {
    const rows = await session.rewindTargets();
    if (!rows.length) {
      out.line("stdout", "当前没有可回退的轮次");
      return;
    }
    pendingRewind = { rows };
    out.line(
      "stdout",
      [
        "选择轮次（输入编号，空行取消）：",
        ...rows.map(
          (target, index) =>
            `  ${index + 1}. ${target.firstLine} · ${target.time} · 改动 ${target.files.length} 个文件${target.untrackedCalls ? " · 含 shell" : ""}`,
        ),
      ].join("\n"),
    );
  };

  const startResumePick = async (): Promise<void> => {
    // 只列当前目录的会话（与 --continue 同口径）；其他目录用 /resume <id>
    const rows = [...(await runtime.listSessions({ cwd: session.state().meta.cwd }))].sort(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
    if (rows.length === 0) {
      out.line("stdout", "（当前目录没有会话）");
      return;
    }
    pendingResume = { rows };
    const lines = rows.map((s, i) => {
      const cur = s.id === session.id ? "（当前）" : "";
      const locked = s.locked === true ? "  [locked]" : "";
      return `  ${i + 1}. ${s.forkedFrom ? "[分叉] " : ""}${s.id}  ${s.createdAt}  ${s.model.provider}/${s.model.model}  ${s.workspaceRoot}${locked}${cur}`;
    });
    out.line("stdout", ["选择要切换的会话（输入编号，空行取消）：", ...lines].join("\n"));
  };

  /** /provider add/key：设置向导工作项并关闭当前 rl——close handler 里
   *  跑向导、结束后重建 readline；Promise 在向导结束时 settle，由
   *  runSlashCommand 的 .then 统一恢复 prompt */
  const startWizard = (
    work: (wio: ReturnType<typeof createSetupPrompts>) => Promise<void>,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      wizardWork = async () => {
        try {
          await work(createSetupPrompts(io.stdin, io.stdout));
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
          const { requestId, options } = pendingPermission;
          const key = line === "" ? "d" : (line.split(/\s+/, 1)[0] ?? "d").toLowerCase();
          const selected = (
            {
              a: "allow_once",
              allow: "allow_once",
              s: "allow_session",
              session: "allow_session",
              p: "allow_project",
              project: "allow_project",
              d: "deny",
              deny: "deny",
              x: "deny_stop",
            } as Record<string, string>
          )[key];
          if (selected === undefined || !options.includes(selected)) {
            write(io, "stdout", "  请输入当前确认框中的选项\n");
            prompt();
            return;
          }
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

        // 提问的逐行回答：编号、拒绝或直接文字；空行重新提示。
        if (pendingQuestion !== undefined) {
          const pq = pendingQuestion;
          const q = pq.questions[pq.index];
          if (q === undefined) {
            pendingQuestion = undefined;
            prompt();
            return;
          }
          if (line === "") {
            printQuestion();
            prompt();
            return;
          }
          const options = q.options ?? [];
          let answer: QuestionAnswer;
          if (/^\d+$/.test(line) && Number(line) === options.length + 1) {
            answer = { declined: true };
          } else if (Array.from(line).length > 2000) {
            out.line("stdout", "! 回答不能超过 2000 字符");
            printQuestion();
            prompt();
            return;
          } else if (options.length === 0 && !/^\d+$/.test(line)) {
            // 自由文本题：整行即回答
            answer = { selected: [], text: line };
          } else {
            const parts = line.split(",").map((s) => s.trim());
            // 全部是数字 → 编号选择；否则整行作为「其他」文本
            if (parts.every((s) => /^\d+$/.test(s))) {
              const picked: string[] = [];
              const bad: string[] = [];
              for (const s of parts) {
                const opt = options[Number.parseInt(s, 10) - 1];
                if (opt === undefined) bad.push(s);
                else if (!picked.includes(opt.label)) picked.push(opt.label);
              }
              if (bad.length > 0) {
                out.line(
                  "stdout",
                  `! 无效编号：${bad.join("，")}（可选 1–${options.length + 1}，拒绝回答须单独选择）`,
                );
                printQuestion();
                prompt();
                return;
              }
              if (q.multiSelect !== true && picked.length > 1) {
                out.line("stdout", "! 本题是单选，只能输入一个编号");
                printQuestion();
                prompt();
                return;
              }
              answer = { selected: picked };
            } else {
              answer = { selected: [], text: line };
            }
          }
          pq.answers.push(answer);
          pq.index += 1;
          if (pq.index < pq.questions.length) {
            printQuestion();
          } else {
            pendingQuestion = undefined;
            void session
              .respondQuestion(pq.requestId, { answers: pq.answers })
              .catch(() => undefined);
          }
          prompt();
          return;
        }

        if (pendingRewind !== undefined) {
          const state = pendingRewind;
          if (line === "") {
            pendingRewind = undefined;
            out.line("stdout", "已取消");
          } else if ("rows" in state) {
            const target = /^\d+$/.test(line) ? state.rows[Number(line) - 1] : undefined;
            if (!target) out.line("stdout", "! 无效轮次编号");
            else {
              pendingRewind = { target };
              const disabled = !target.files.some((file) => file.action !== "untracked");
              out.line(
                "stdout",
                `回退到「${target.firstLine}」之前：\n1. 对话和文件一起回退${disabled ? "（不可用）" : ""}\n2. 只回退对话\n3. 只还原文件${disabled ? "（不可用）" : ""}\n4. 从这里分叉新会话\n5. 取消${disabled ? "\n这一轮之后没有可还原的文件" : ""}`,
              );
            }
          } else if (state.mode === undefined) {
            const modes = ["both", "conversation", "files", "fork"] as const;
            const mode = /^\d+$/.test(line) ? modes[Number(line) - 1] : undefined;
            if (line === "5") {
              pendingRewind = undefined;
              out.line("stdout", "已取消");
            } else if (!mode) out.line("stdout", "! 无效操作编号");
            else if (
              (mode === "both" || mode === "files") &&
              !state.target.files.some((file) => file.action !== "untracked")
            )
              out.line("stdout", "这一轮之后没有可还原的文件");
            else {
              pendingRewind = { target: state.target, mode };
              const target = state.target;
              const lines =
                mode === "fork"
                  ? [
                      "文件保持当前状态；需要文件也回到那一轮，可在原会话里对同一轮执行「只还原文件」",
                    ]
                  : [
                      ...target.files.map(
                        (file) =>
                          `${file.action === "restore" ? "还原" : file.action === "delete" ? "删除" : `无法还原（${file.reason ?? "未追踪"}）`} ${displayPath(file.path, session.state().meta.cwd)}${file.external ? " [已在外部修改]" : ""}`,
                      ),
                      ...(target.untrackedCalls
                        ? [
                            `这一轮之后有 ${target.untrackedCalls} 次 shell/MCP 调用，它们造成的改动不会被还原`,
                          ]
                        : []),
                      ...(mode === "conversation" ? ["文件保持当前状态"] : []),
                    ];
              out.line(
                "stdout",
                [...lines, `确认${mode === "fork" ? "分叉" : "回退"}？[y/N]`].join("\n"),
              );
            }
          } else {
            pendingRewind = undefined;
            if (/^y(es)?$/i.test(line)) {
              runSessionCommand(async () => {
                if (state.mode === "fork") await fork(state.target);
                else {
                  await session.rewind(state.target.seq, state.mode ?? "conversation");
                  if (state.mode !== "files") refill(state.target);
                }
              });
              return;
            }
            out.line("stdout", "已取消");
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
        // ADR-0036 修订：/preset 忙时也可切换（下一次权限判定起生效）
        const busyAllowed = line === "/preset" || line.startsWith("/preset ");
        if (busy && !busyAllowed) {
          out.line("stdout", "会话忙（Turn 进行中）；Ctrl+C 可中断");
          prompt();
          return;
        }
        remember(line);
        if (line.startsWith("/rewind ") || line.startsWith("/fork ")) {
          out.line("stdout", `! 用法：${line.startsWith("/rewind ") ? "/rewind" : "/fork"}`);
          prompt();
          return;
        }
        if (line === "/rewind" || line === "/fork") {
          runSessionCommand(line === "/rewind" ? startRewindPick : () => fork());
          return;
        }
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
        const skill = parseSkillSlash(line, session.describeSkills().skills);
        const delegate = skill
          ? undefined
          : parseExternalAgentSlash(line, externalAgents, session.describeSkills().skills);
        if (delegate?.task.trim() === "") {
          out.line("stdout", `用法：/${delegate.agent} 任务`);
          prompt();
          return;
        }
        if (line.startsWith("/") && !skill && !delegate) {
          const bridge = opts.provider;
          const deps: CommandDeps = {
            ...(bridge !== undefined
              ? {
                  provider: {
                    config: bridge.config,
                    reloadConfig: bridge.reloadConfig,
                    updateProviders: async (rc) => {
                      await runtime.updateProviders(rc);
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
                        updateProviders: async (rc) => {
                          await runtime.updateProviders(rc);
                        },
                      }),
                    ),
                  runLoginWizard: (providerId: string) =>
                    startWizard(async (wio) => {
                      const { runProviderLogin } = await import("@nocturne/tui/provider-login");
                      await runProviderLogin(bridge.config, providerId, wio);
                      await runtime.updateProviders(await bridge.reloadConfig());
                    }),
                  runKeyWizard: (providerId: string) =>
                    startWizard((wio) =>
                      runKeyWizardInSession(wio, {
                        config: bridge.config,
                        providerId,
                        reloadConfig: bridge.reloadConfig,
                        updateProviders: async (rc) => {
                          await runtime.updateProviders(rc);
                        },
                      }),
                    ),
                  runModelWizard: (providerId: string, modelId: string) =>
                    startWizard((wio) =>
                      runModelWizardInSession(wio, {
                        config: bridge.config,
                        providerId,
                        modelId,
                        workspaceRoot: bridge.workspaceRoot,
                        reloadConfig: bridge.reloadConfig,
                        updateProviders: async (rc) => {
                          await runtime.updateProviders(rc);
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
          .submit({ text: line, ...(skill ? { skill } : {}), ...(delegate ? { delegate } : {}) })
          .catch((e: unknown) => {
            out.line("stderr", `! ${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            busy = false;
            prompt();
          });
      });
      r.on("SIGINT", () => {
        if (sessionCommand) {
          out.line("stdout", "操作进行中，请稍候");
          prompt();
          return;
        }
        if (pendingRewind !== undefined) {
          pendingRewind = undefined;
          out.line("stdout", "已取消");
          prompt();
          return;
        }
        if (pendingResume !== undefined) {
          pendingResume = undefined;
          out.line("stdout", "已取消");
          prompt();
          return;
        }
        if (busy || pendingPermission !== undefined || pendingQuestion !== undefined) {
          session.interrupt();
          pendingPermission = undefined;
          pendingQuestion = undefined;
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

/** 工作区内的文件显示相对路径（与 TUI 回退预览一致） */
function displayPath(file: string, cwd: string): string {
  if (cwd === "") return file;
  const rel = path.relative(cwd, file);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}
