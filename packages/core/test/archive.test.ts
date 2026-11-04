/**
 * 会话归档（ADR-0080）：旁路状态、列表/搜索过滤、忙判定、自动恢复与不写日志。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  type Runtime,
  type RuntimeSession,
  type RuntimeOptions,
} from "../src/index.js";
import { FakeProvider, type FakeHandler, type FakeScript } from "../src/provider/index.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const textScript = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

interface SetupOptions {
  scripts?: FakeScript[] | undefined;
  handler?: FakeHandler | undefined;
  runtime?: Partial<RuntimeOptions> | undefined;
}

interface Setup {
  root: string;
  runtime: Runtime;
  provider: FakeProvider;
  sessionsDir: string;
  diag: string;
  create(): Promise<RuntimeSession>;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const root = mkdtempSync(path.join(tmpdir(), "nct-archive-"));
  roots.push(root);
  const workspace = path.join(root, "ws");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(workspace);
  const diag = path.join(root, "diagnostic.jsonl");
  const provider = new FakeProvider({
    ...(options.scripts !== undefined ? { scripts: options.scripts } : {}),
    ...(options.handler !== undefined ? { handler: options.handler } : {}),
  });
  const runtime = await createRuntime({
    cwd: workspace,
    sessionsDir,
    providers: [provider],
    debug: { enabled: true, file: diag },
    ...options.runtime,
  });
  return {
    root,
    runtime,
    provider,
    sessionsDir,
    diag,
    create: () => runtime.createSession({ model: "fake/fake-1" }),
  };
}

function archivePath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.archive.json`);
}

function logBytes(sessionsDir: string, id: string): string {
  return readFileSync(path.join(sessionsDir, `${id}.jsonl`), "utf8");
}

function logMtime(sessionsDir: string, id: string): number {
  return statSync(path.join(sessionsDir, `${id}.jsonl`)).mtimeMs;
}

async function waitForDiagnostic(file: string, needle: string): Promise<void> {
  await vi.waitFor(
    () => {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      expect(text).toContain(needle);
    },
    { timeout: 5000 },
  );
}

describe("Core 会话归档", () => {
  it("未打开会话：归档/恢复不改日志字节与 mtime，列表和搜索默认隐藏", async () => {
    const s = await setup({ scripts: [textScript("归档 needle 会话")] });
    const session = await s.create();
    await session.submit({ text: "归档 needle 会话" });
    const id = session.id;
    await session.close();
    // 损坏尾部不能被归档路径“修复”（不调用 loadEvents/repair）
    appendFileSync(path.join(s.sessionsDir, `${id}.jsonl`), '{"type":"truncated"');

    const before = logBytes(s.sessionsDir, id);
    const mtime = logMtime(s.sessionsDir, id);

    await s.runtime.archiveSession(id);
    expect(readdirSync(s.sessionsDir).some((name) => name.endsWith(".tmp"))).toBe(false);
    const sidecar = JSON.parse(readFileSync(archivePath(s.sessionsDir, id), "utf8")) as {
      archivedAt: string;
    };
    expect(Number.isNaN(Date.parse(sidecar.archivedAt))).toBe(false);
    expect(logBytes(s.sessionsDir, id)).toBe(before);
    expect(logMtime(s.sessionsDir, id)).toBe(mtime);
    expect(await s.runtime.listSessions()).toEqual([]);
    expect((await s.runtime.listSessions({ includeArchived: true }))[0]).toMatchObject({
      id,
      archivedAt: sidecar.archivedAt,
    });
    expect(await s.runtime.searchSessions("needle")).toEqual([]);
    expect(
      (await s.runtime.searchSessions("needle", { includeArchived: true }))[0]?.sessionId,
    ).toBe(id);

    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);
    expect(logBytes(s.sessionsDir, id)).toBe(before);
    expect(logMtime(s.sessionsDir, id)).toBe(mtime);
    expect((await s.runtime.listSessions())[0]?.id).toBe(id);
    expect((await s.runtime.listSessions())[0]?.archivedAt).toBeUndefined();
  });

  it("已打开会话：归档/恢复保持摘要 mtime，submit 自动恢复并通知", async () => {
    const s = await setup({ scripts: [textScript("一"), textScript("二")] });
    const session = await s.create();
    await session.submit({ text: "第一条" });
    const id = session.id;
    const mtime = logMtime(s.sessionsDir, id);
    const notifications: number[] = [];
    const off = s.runtime.onSessionsChanged(() => notifications.push(1));

    await s.runtime.archiveSession(id);
    expect((await s.runtime.listSessions()).some((item) => item.id === id)).toBe(false);
    expect((await s.runtime.listSessions({ includeArchived: true }))[0]?.mtimeMs).toBe(mtime);
    expect(notifications.length).toBe(1);

    await s.runtime.unarchiveSession(id);
    expect((await s.runtime.listSessions())[0]?.mtimeMs).toBe(mtime);
    expect(notifications.length).toBe(2);

    await s.runtime.archiveSession(id);
    await session.submit({ text: "第二条" });
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);
    expect((await s.runtime.listSessions())[0]?.archivedAt).toBeUndefined();
    expect(notifications.length).toBe(4);
    off();
    await session.close();
  });

  it("列表与搜索的 includeArchived 缺省为 false，归档摘要带 archivedAt", async () => {
    const s = await setup({
      scripts: [textScript("a"), textScript("b"), textScript("c")],
    });
    const one = await s.create();
    await one.submit({ text: "needle one" });
    const two = await s.create();
    await two.submit({ text: "needle two" });
    const three = await s.create();
    await three.submit({ text: "needle three" });
    await Promise.all([one.close(), two.close(), three.close()]);
    await s.runtime.archiveSession(one.id);
    await s.runtime.archiveSession(three.id);

    expect((await s.runtime.listSessions()).map((item) => item.id)).toEqual([two.id]);
    expect(
      (await s.runtime.listSessions({ includeArchived: true })).map((item) => item.id).sort(),
    ).toEqual([one.id, two.id, three.id].sort());
    expect((await s.runtime.searchSessions("needle")).map((item) => item.sessionId)).toEqual([
      two.id,
    ]);
    expect(
      (await s.runtime.searchSessions("needle", { includeArchived: true })).map(
        (item) => item.sessionId,
      ),
    ).toEqual(expect.arrayContaining([one.id, two.id, three.id]));
  });

  it.each(["{not json", "null", '{"archivedAt":12}', '{"archivedAt":"123"}'])(
    "损坏的归档旁路按未归档处理并记诊断：%s",
    async (content) => {
      const s = await setup();
      const session = await s.create();
      const id = session.id;
      await session.close();
      writeFileSync(archivePath(s.sessionsDir, id), content);

      expect((await s.runtime.listSessions())[0]?.id).toBe(id);
      expect(
        (await s.runtime.listSessions({ includeArchived: true }))[0]?.archivedAt,
      ).toBeUndefined();
      await waitForDiagnostic(s.diag, "session.archive_sidecar_invalid");

      await s.runtime.archiveSession(id);
      expect((await s.runtime.listSessions()).some((item) => item.id === id)).toBe(false);
      expect((await s.runtime.listSessions({ includeArchived: true }))[0]?.archivedAt).toBeTruthy();
    },
  );

  it("非法 id 在构造路径前拒绝", async () => {
    const s = await setup();
    for (const bad of ["../escape", "a/b", "a\\b", "a b"]) {
      await expect(s.runtime.archiveSession(bad)).rejects.toMatchObject({
        code: "invalid_session_id",
      });
      await expect(s.runtime.unarchiveSession(bad)).rejects.toMatchObject({
        code: "invalid_session_id",
      });
    }
    expect(readdirSync(s.sessionsDir)).toEqual([]);
  });

  it("子会话不能归档或恢复（打开与未打开都返回 invalid_command）", async () => {
    const s = await setup();
    const parent = await s.create();
    const child = await s.runtime.createSession({
      model: "fake/fake-1",
      parent: { sessionId: parent.id, callId: "call-1" },
    });
    const childId = child.id;

    await expect(s.runtime.archiveSession(childId)).rejects.toMatchObject({
      code: "invalid_command",
    });
    await expect(s.runtime.unarchiveSession(childId)).rejects.toMatchObject({
      code: "invalid_command",
    });
    await child.close();
    await expect(s.runtime.archiveSession(childId)).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(existsSync(archivePath(s.sessionsDir, childId))).toBe(false);

    writeFileSync(
      archivePath(s.sessionsDir, childId),
      JSON.stringify({ archivedAt: new Date().toISOString() }),
    );
    await expect(s.runtime.unarchiveSession(childId)).rejects.toMatchObject({
      code: "invalid_command",
    });
    await parent.close();
  });

  it("Turn 与待发输入进行中拒绝归档", async () => {
    const s = await setup({ scripts: [[{ type: "wait" }]] });
    const session = await s.create();
    const turn = session.submit({ text: "turn" });
    await expect(s.runtime.archiveSession(session.id)).rejects.toMatchObject({
      code: "session_busy",
    });
    const { id: pendingId } = await session.enqueueInput("queue", { text: "pending" });
    await expect(s.runtime.archiveSession(session.id)).rejects.toMatchObject({
      code: "session_busy",
    });
    session.interrupt();
    await turn;
    expect(session.pendingInputs().items.length).toBe(1);
    await expect(s.runtime.archiveSession(session.id)).rejects.toMatchObject({
      code: "session_busy",
    });
    await session.cancelInput(pendingId);
    await session.close();
  });

  it("压缩与回退进行中拒绝归档", async () => {
    const s = await setup({ scripts: [textScript("seed"), [{ type: "wait" }]] });
    const session = await s.create();
    await session.submit({ text: "rewind target" });
    const target = session.state().history.find((entry) => entry.kind === "user")?.seq;
    if (target === undefined) throw new Error("缺少回退目标");

    const compacting = session.compact();
    await expect(s.runtime.archiveSession(session.id)).rejects.toMatchObject({
      code: "session_busy",
    });
    session.interrupt();
    await compacting.catch(() => undefined);

    const rewinding = session.rewind(target, "conversation");
    await expect(s.runtime.archiveSession(session.id)).rejects.toMatchObject({
      code: "session_busy",
    });
    await rewinding;
    await session.close();
  });

  it("关闭中与外部锁都映射为 session_busy", async () => {
    const s = await setup({ scripts: [textScript("seed")] });
    const session = await s.create();
    const id = session.id;
    const closing = session.close();
    await expect(s.runtime.archiveSession(id)).rejects.toMatchObject({ code: "session_busy" });
    await closing;

    writeFileSync(
      path.join(s.sessionsDir, `${id}.lock`),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now(), token: "t" }),
    );
    await expect(s.runtime.archiveSession(id)).rejects.toMatchObject({ code: "session_busy" });
    rmSync(path.join(s.sessionsDir, `${id}.lock`));
  });

  it("恢复会话不判断忙、不取会话锁，旁路文件不存在也视为成功", async () => {
    let parentCalls = 0;
    const s = await setup({
      handler: (request) => {
        if (request.tools.some((tool) => tool.name === "finish")) {
          return [
            { type: "wait", ms: 2000 },
            {
              type: "tool_call",
              toolCallId: "finish",
              name: "finish",
              input: { result: "child result" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const lastText = JSON.stringify(request.messages.at(-1) ?? "");
        if (
          lastText.includes("启动后台子代理") ||
          JSON.stringify(request.messages).includes("启动后台子代理")
        ) {
          parentCalls += 1;
          return parentCalls === 1
            ? [
                {
                  type: "tool_call",
                  toolCallId: "bg-1",
                  name: "task",
                  input: { task: "research", background: true, preset: "explore" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : textScript("bg started");
        }
        if (lastText.includes("种子消息")) {
          return textScript("种子回复");
        }
        return [{ type: "wait" }];
      },
      runtime: { subagent: { background: true }, permissions: { autoApproveAsk: true } },
    });
    const session = await s.create();
    const id = session.id;
    const markArchived = () => {
      writeFileSync(
        archivePath(s.sessionsDir, id),
        JSON.stringify({ archivedAt: new Date().toISOString() }),
      );
    };

    // 1. 旁路文件本来不存在时（已打开），恢复成功
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);
    await expect(s.runtime.unarchiveSession(id)).resolves.toBeUndefined();

    // 先跑一轮种子消息，供后续压缩使用
    await session.submit({ text: "种子消息" });

    // 2. Turn 进行中恢复成功，且有待发输入时恢复也成功
    const turn = session.submit({ text: "挂起轮" });
    await vi.waitFor(() => {
      expect(s.provider.waitState.waiting).toBe(1);
    });
    markArchived();
    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);

    const { id: pendingId } = await session.enqueueInput("queue", { text: "待发条目" });
    markArchived();
    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);

    session.interrupt();
    await turn;
    // Turn 中断后待发输入处于暂停态，恢复仍成功
    expect(session.pendingInputs().items).toHaveLength(1);
    markArchived();
    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);
    await session.cancelInput(pendingId);

    // 3. 压缩进行中恢复成功
    await s.runtime.archiveSession(id);
    const compacting = session.compact();
    await vi.waitFor(() => {
      expect(s.provider.waitState.waiting).toBe(1);
    });
    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);
    session.interrupt();
    await compacting.catch(() => undefined);

    // 4. 后台子代理运行中恢复成功
    await session.submit({ text: "启动后台子代理" });
    await vi.waitFor(async () => {
      expect((await s.runtime.listSubagents({ parentSessionId: id })).length).toBe(1);
    });
    markArchived();
    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);

    await session.close();

    // 5. 未打开会话被外部锁占用时恢复仍成功（不取会话锁），且文件不存在时也成功
    markArchived();
    writeFileSync(
      path.join(s.sessionsDir, `${id}.lock`),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now(), token: "t" }),
    );
    await s.runtime.unarchiveSession(id);
    expect(existsSync(archivePath(s.sessionsDir, id))).toBe(false);
    await expect(s.runtime.unarchiveSession(id)).resolves.toBeUndefined();
    rmSync(path.join(s.sessionsDir, `${id}.lock`));
  }, 20_000);

  it("后台子代理运行中拒绝归档", async () => {
    let parentCalls = 0;
    const s = await setup({
      handler: (request) => {
        if (request.tools.some((tool) => tool.name === "finish"))
          return [
            { type: "wait", ms: 2000 },
            {
              type: "tool_call",
              toolCallId: "finish",
              name: "finish",
              input: { result: "child result" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        parentCalls += 1;
        return parentCalls === 1
          ? [
              {
                type: "tool_call",
                toolCallId: "bg",
                name: "task",
                input: { task: "research", background: true, preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ]
          : textScript("started");
      },
      runtime: { subagent: { background: true }, permissions: { autoApproveAsk: true } },
    });
    const session = await s.create();
    await session.submit({ text: "launch" });
    await vi.waitFor(async () => {
      expect((await s.runtime.listSubagents({ parentSessionId: session.id })).length).toBe(1);
    });
    await expect(s.runtime.archiveSession(session.id)).rejects.toMatchObject({
      code: "session_busy",
    });
    await session.close();
  }, 20_000);

  it("submit 删除归档旁路失败只记诊断，不挡发送", async () => {
    const s = await setup({ scripts: [textScript("a"), textScript("b")] });
    const session = await s.create();
    await session.submit({ text: "第一条" });
    const id = session.id;
    await s.runtime.archiveSession(id);
    // 用目录替换旁路，删除必然失败（不同平台分别报 EPERM/EISDIR）
    rmSync(archivePath(s.sessionsDir, id));
    mkdirSync(archivePath(s.sessionsDir, id));
    await session.submit({ text: "第二条" });
    expect(session.durableEvents().filter((event) => event.type === "message.user")).toHaveLength(
      2,
    );
    await waitForDiagnostic(s.diag, "session.unarchive_failed");
    await session.close();
  });

  it("所有开始新一轮的入口（enqueueInput 空闲/压缩后、继续发送、继续目标、批准计划）都自动恢复且接续轮不重复处理", async () => {
    const goalMet = (id: string): FakeScript => [
      {
        type: "tool_call",
        toolCallId: id,
        name: "update_goal",
        input: { status: "met", checklist: [{ item: "测试通过", evidence: "0 failed" }] },
      },
      { type: "finish", reason: "tool_calls" },
    ];
    let sessionId = "";
    let sessionsDir = "";
    let goalCalls = 0;
    const s = await setup({
      handler: (request) => {
        const serialized = JSON.stringify(request.messages);
        if (serialized.includes("阻塞轮") && !serialized.includes("继续一")) {
          return [{ type: "wait" }];
        }
        if (
          serialized.includes("继续一") &&
          !serialized.includes("继续发送第一条") &&
          sessionId &&
          sessionsDir
        ) {
          // 在「继续一」首轮模型请求期间重写归档旁路，验证接续的「继续二」不会再次自动恢复
          writeFileSync(
            archivePath(sessionsDir, sessionId),
            JSON.stringify({ archivedAt: new Date().toISOString() }),
          );
          return textScript("继续发送第一条");
        }
        if (serialized.includes("收敛目标")) {
          const last = request.messages.at(-1);
          if (last?.role === "tool") return textScript("目标轮完成");
          goalCalls += 1;
          return goalMet(`g-${goalCalls}`);
        }
        return [{ type: "wait", ms: 20 }, ...textScript("完成")];
      },
    });
    const session = await s.create();
    sessionId = session.id;
    sessionsDir = s.sessionsDir;
    const notifications: number[] = [];
    const off = s.runtime.onSessionsChanged(() => notifications.push(1));

    // 1. enqueueInput 空闲路径
    await s.runtime.archiveSession(session.id);
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(true);
    notifications.length = 0;
    expect(await session.enqueueInput("queue", { text: "空闲入列" })).toMatchObject({
      queued: false,
    });
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(false);
    expect(notifications.length).toBe(1);

    // 2. 压缩结束后发送路径
    await s.runtime.archiveSession(session.id);
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(true);
    notifications.length = 0;
    const compacting = session.compact();
    const afterCompact = session.enqueueInput("queue", { text: "压缩后入列" });
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(true);
    await Promise.all([compacting, afterCompact]);
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(false);
    expect(notifications.length).toBe(1);

    // 3. 继续发送（pumpQueue）及接续下一轮不重复处理
    const blockedTurn = session.submit({ text: "阻塞轮" });
    await vi.waitFor(() => {
      expect(s.provider.waitState.waiting).toBe(1);
    });
    await session.enqueueInput("queue", { text: "继续一" });
    await session.enqueueInput("queue", { text: "继续二" });
    session.interrupt();
    await blockedTurn;
    expect(session.pendingInputs().paused).toBe(true);
    writeFileSync(
      archivePath(s.sessionsDir, session.id),
      JSON.stringify({ archivedAt: new Date().toISOString() }),
    );
    notifications.length = 0;
    await session.resumeInputs();
    // 首轮开始前删除了旁路并通知 1 次；首轮中途重写旁路后，接续的第二轮不重复删除或通知
    expect(notifications.length).toBe(1);
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(true);
    rmSync(archivePath(s.sessionsDir, session.id));

    // 4. 继续目标（resumeGoal）
    await session.submit({ text: "收敛目标", workMode: "goal" });
    await s.runtime.archiveSession(session.id);
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(true);
    notifications.length = 0;
    await session.resumeGoal();
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(false);
    expect(notifications.length).toBe(1);

    // 5. 批准计划（approvePlan）
    await session.submit({ text: "拟定计划", workMode: "plan" });
    await s.runtime.archiveSession(session.id);
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(true);
    notifications.length = 0;
    await session.approvePlan();
    expect(existsSync(archivePath(s.sessionsDir, session.id))).toBe(false);
    expect(notifications.length).toBe(1);

    off();
    await session.close();
  });

  it("分叉不继承归档状态，回退保留归档状态", async () => {
    const s = await setup({ scripts: [textScript("a"), textScript("b")] });
    const session = await s.create();
    await session.submit({ text: "第一条" });
    await session.submit({ text: "第二条" });
    const id = session.id;
    await s.runtime.archiveSession(id);
    const forkId = await s.runtime.forkSession(id);
    expect(existsSync(archivePath(s.sessionsDir, forkId))).toBe(false);
    expect(
      (await s.runtime.listSessions({ includeArchived: true })).find((item) => item.id === forkId)
        ?.archivedAt,
    ).toBeUndefined();

    const target = session.state().history.find((entry) => entry.kind === "user")?.seq;
    if (target === undefined) throw new Error("缺少回退目标");
    await session.rewind(target, "conversation");
    expect(
      (await s.runtime.listSessions({ includeArchived: true })).find((item) => item.id === id)
        ?.archivedAt,
    ).toBeTruthy();

    const fork = await s.runtime.resumeSession(forkId);
    await fork.close();
    await session.close();
  });
});
