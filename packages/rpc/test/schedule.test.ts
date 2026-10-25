/**
 * ADR-0064：schedule.* 方法与 schedule.changed 通知，以及远程白名单的范围
 * （list / history / runNow 放开，save / delete 只在本机）。
 * 任务与历史写在 connectManyWithConfig 的临时 NOCTURNE_HOME 下，不碰真实目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";
import { REMOTE_METHODS } from "@nocturne/rpc/server";

import { cleanupTmp, connectManyWithConfig, MODEL, textScript, until } from "./harness.js";

afterEach(cleanupTmp);

const writeScript = [
  {
    type: "tool_call" as const,
    toolCallId: "w",
    name: "write",
    input: { path: "out.txt", content: "ok" },
  },
  { type: "finish" as const, reason: "tool_calls" as const },
];

const task = (ws: string, patch: Record<string, unknown> = {}) => ({
  name: "每日提交汇总",
  prompt: "汇总提交",
  workspace: ws,
  model: MODEL,
  schedule: { type: "daily" as const, time: "09:00" },
  ...patch,
});

/** 记录某条连接收到的 schedule.changed */
function changes(client: RpcClient): { taskIds: () => (string | undefined)[] } {
  const seen: (string | undefined)[] = [];
  client.onNotification("schedule.changed", (params) => {
    seen.push(params.taskId);
  });
  return { taskIds: () => seen };
}

describe("schedule.* 方法（本机）", () => {
  it("save / list / history / delete：往返、概览字段与调度器状态", async () => {
    const h = await connectManyWithConfig();
    const saved = await h.client.runtime.saveSchedule(task(h.ws));
    expect(saved).toMatchObject({
      name: "每日提交汇总",
      enabled: true,
      maxDurationMinutes: 60,
      running: false,
      stats: { last7Days: { runs: 0, skipped: 0 } },
    });
    expect(saved.nextRunAt).toBeDefined();
    expect(saved).not.toHaveProperty("anchorAt");

    const listed = await h.client.runtime.listSchedules();
    expect(listed.tasks.map((t) => t.id)).toEqual([saved.id]);
    // 本进程没启用调度器：列表里标明原因，客户端据此在页头提示
    expect(listed.scheduler).toEqual({ running: false, reason: "disabled" });
    expect(listed.warnings).toEqual([]);
    expect(await h.client.runtime.scheduleHistory({ id: saved.id })).toEqual([]);

    // 带 id 为整体替换；暂停后没有下次运行时间
    const paused = await h.client.runtime.saveSchedule(
      task(h.ws, { id: saved.id, enabled: false }),
    );
    expect(paused.id).toBe(saved.id);
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeUndefined();

    await h.client.runtime.deleteSchedule({ id: saved.id });
    expect((await h.client.runtime.listSchedules()).tasks).toEqual([]);
    await h.client.shutdown();
    await h.served;
  });

  it("字段非法：以带 field 的错误拒绝，客户端据此标到输入框；不写入", async () => {
    const h = await connectManyWithConfig();
    const bad = (patch: Record<string, unknown>) =>
      h.client.runtime.saveSchedule(task(h.ws, patch)).catch((e: unknown) => e);
    for (const [patch, field] of [
      [{ name: "" }, "name"],
      [{ prompt: "  " }, "prompt"],
      [{ schedule: { type: "interval", minutes: 29 } }, "schedule"],
      [{ schedule: { type: "cron", expr: "*/10 * * * *" } }, "schedule"],
      [{ model: "nope/none" }, "model"],
      [{ permissionPreset: "yolo" }, "permissionPreset"],
      [{ workspace: "relative" }, "workspace"],
    ] as const) {
      expect(await bad(patch), JSON.stringify(patch)).toMatchObject({
        code: "invalid_field",
        field,
      });
    }
    expect((await h.client.runtime.listSchedules()).tasks).toEqual([]);
    await h.client.shutdown();
    await h.served;
  });

  it("不是调度器进程时立即运行被拒：提示只在桌面端打开时运行", async () => {
    const h = await connectManyWithConfig();
    const saved = await h.client.runtime.saveSchedule(task(h.ws));
    await expect(h.client.runtime.runSchedule({ id: saved.id })).rejects.toMatchObject({
      field: "scheduler",
      message: expect.stringContaining("只在桌面端打开时运行"),
    });
    await expect(h.client.runtime.runSchedule({ id: "nope" })).rejects.toMatchObject({
      field: "id",
    });
    await h.client.shutdown();
    await h.served;
  });

  it("runtime.createSession 不接收 schedule / interactive：客户端不能伪造定时来源", async () => {
    const h = await connectManyWithConfig();
    const { session } = await h.client.runtime.createSession({
      model: MODEL,
      cwd: h.ws,
      // 类型上已去掉这两个字段；这里强行带上，服务端必须忽略
      ...({
        schedule: { taskId: "x", scheduledAt: new Date().toISOString(), trigger: "schedule" },
        interactive: false,
      } as object),
    });
    const listed = await h.client.runtime.listSessions();
    expect(listed.find((s) => s.id === session.id)?.schedule).toBeUndefined();
    expect(h.coreSession(session.id)?.state().meta.schedule).toBeUndefined();
    await h.client.shutdown();
    await h.served;
  });
});

describe("调度器进程里的立即运行", () => {
  it("手机（远程）立即运行：开出带来源的会话，历史记 manual，列表带概览", async () => {
    const h = await connectManyWithConfig({
      scheduler: true,
      scripts: [writeScript, textScript("没能写入，已列出")],
    });
    const phone = await h.add();
    const saved = await h.client.runtime.saveSchedule(task(h.ws, { schedule: { type: "manual" } }));
    expect((await phone.client.runtime.listSchedules()).scheduler).toEqual({ running: true });

    const started = await phone.client.runtime.runSchedule({ id: saved.id });
    expect(started).toMatchObject({ started: true });
    let history = await phone.client.runtime.scheduleHistory({ id: saved.id });
    const deadline = Date.now() + 8000;
    while (history[0]?.result !== "done" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      history = await phone.client.runtime.scheduleHistory({ id: saved.id });
    }
    expect(history[0]).toMatchObject({ trigger: "manual", result: "done", denied: 1 });

    const sessions = await h.client.runtime.listSessions();
    const run = sessions.find((s) => s.id === history[0]?.sessionId);
    expect(run?.schedule).toMatchObject({ taskId: saved.id, trigger: "manual" });
    const overview = (await phone.client.runtime.listSchedules()).tasks[0];
    expect(overview).toMatchObject({ running: false, lastRun: { result: "done" } });
    expect(overview?.stats.last7Days.runs).toBe(1);

    await h.client.shutdown();
    await Promise.all([h.served, phone.served]);
    expect(h.disposed()).toBe(true);
  });

  it("上一次未结束再运行：返回 started:false 与原因，不抛错", async () => {
    const h = await connectManyWithConfig({
      scheduler: true,
      // 第一次运行卡在模型调用上
      scripts: [[{ type: "wait", ms: 3000 }, ...textScript("慢")]],
    });
    const saved = await h.client.runtime.saveSchedule(task(h.ws, { schedule: { type: "manual" } }));
    expect(await h.client.runtime.runSchedule({ id: saved.id })).toMatchObject({ started: true });
    expect(await h.client.runtime.runSchedule({ id: saved.id })).toEqual({
      started: false,
      reason: "previous_running",
    });
    const overview = (await h.client.runtime.listSchedules()).tasks[0];
    expect(overview?.running).toBe(true);
    await h.client.shutdown();
    await h.served;
  });
});

describe("schedule.changed 通知", () => {
  it("保存与删除后本机与远程连接都收到，带 taskId，不带任务内容", async () => {
    const h = await connectManyWithConfig();
    const phone = await h.add();
    const local = changes(h.client);
    const remote = changes(phone.client);
    const saved = await h.client.runtime.saveSchedule(task(h.ws));
    await until(() => local.taskIds().length > 0 && remote.taskIds().length > 0, "保存的通知");
    expect(local.taskIds()).toContain(saved.id);
    expect(remote.taskIds()).toContain(saved.id);
    await h.client.runtime.deleteSchedule({ id: saved.id });
    await until(() => remote.taskIds().length >= 2, "删除的通知");
    await h.client.shutdown();
    await Promise.all([h.served, phone.served]);
  });

  it("运行开始与结束都通知，并带动会话列表刷新", async () => {
    const h = await connectManyWithConfig({
      scheduler: true,
      scripts: [writeScript, textScript("好")],
    });
    const saved = await h.client.runtime.saveSchedule(task(h.ws, { schedule: { type: "manual" } }));
    const seen = changes(h.client);
    let sessionsChanged = 0;
    h.client.onNotification("runtime.sessionsChanged", () => {
      sessionsChanged += 1;
    });
    await h.client.runtime.runSchedule({ id: saved.id });
    await until(() => seen.taskIds().length >= 3 && sessionsChanged > 0, "运行状态变化的通知");
    expect(new Set(seen.taskIds())).toEqual(new Set([saved.id]));
    await h.client.shutdown();
    await h.served;
  });
});

describe("远程白名单（ADR-0064：list / history / runNow 放开，save / delete 只在本机）", () => {
  it("白名单只含三个只读或不改配置的方法", () => {
    const scheduleMethods = (REMOTE_METHODS as readonly string[]).filter((m) =>
      m.startsWith("schedule."),
    );
    expect(scheduleMethods.sort()).toEqual([
      "schedule.history",
      "schedule.list",
      "schedule.runNow",
    ]);
  });

  it("手机能 list / history，save / delete 在 Core 之前被拒，什么都没写", async () => {
    const h = await connectManyWithConfig();
    const phone = await h.add();
    const saved = await h.client.runtime.saveSchedule(task(h.ws));

    expect((await phone.client.runtime.listSchedules()).tasks).toHaveLength(1);
    expect(await phone.client.runtime.scheduleHistory({ id: saved.id })).toEqual([]);

    await expect(phone.client.runtime.saveSchedule(task(h.ws))).rejects.toMatchObject({
      code: "remote_not_allowed",
      rpcCode: -32004,
    });
    await expect(
      phone.client.runtime.saveSchedule(task(h.ws, { id: saved.id, enabled: false })),
    ).rejects.toMatchObject({ code: "remote_not_allowed" });
    await expect(phone.client.runtime.deleteSchedule({ id: saved.id })).rejects.toMatchObject({
      code: "remote_not_allowed",
    });

    const after = await h.client.runtime.listSchedules();
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0]).toMatchObject({ id: saved.id, enabled: true });
    await h.client.shutdown();
    await Promise.all([h.served, phone.served]);
  });
});
