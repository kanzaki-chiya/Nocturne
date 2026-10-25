/**
 * 任务存储（ADR-0064 第 2、3 节）：逐条校验、原子写、同进程写入串行、损坏条目忽略并警告、
 * 历史保留最近 200 条。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform } from "../platform/index.js";
import { ScheduleError } from "./plan.js";
import { createScheduleStore } from "./store.js";
import { createZone } from "./zone.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
};

function setup(now = Date.parse("2026-10-25T00:00:00Z")) {
  const home = tmp("nct-sched-home-");
  const workspace = tmp("nct-sched-ws-");
  let clock = now;
  const store = createScheduleStore({
    platform: createPlatform(),
    home,
    zone: createZone("Asia/Shanghai"),
    now: () => clock,
  });
  return {
    home,
    workspace,
    store,
    setNow: (t: number) => {
      clock = t;
    },
  };
}

const base = (workspace: string) => ({
  name: "每日提交汇总",
  prompt: "汇总过去 24 小时的提交",
  workspace,
  schedule: { type: "daily" as const, time: "09:00" },
});

describe("保存与读取", () => {
  it("新建：补齐缺省值，写入 schedules.json，内部记账字段不出现在返回值之外的地方", async () => {
    const { home, workspace, store } = setup();
    const task = await store.save(base(workspace));
    expect(task).toMatchObject({
      name: "每日提交汇总",
      workspace,
      enabled: true,
      maxDurationMinutes: 60,
      schedule: { type: "daily", time: "09:00" },
      createdAt: "2026-10-25T00:00:00.000Z",
      anchorAt: "2026-10-25T00:00:00.000Z",
    });
    expect(task.id).toMatch(/^t[0-9a-f]{10}$/);
    const file = JSON.parse(readFileSync(path.join(home, "schedules.json"), "utf8"));
    expect(file.version).toBe(1);
    expect(file.tasks).toHaveLength(1);
    expect(file.tasks[0].id).toBe(task.id);
  });

  it("工作区留空是普通对话（null）", async () => {
    const { store } = setup();
    const task = await store.save({
      name: "n",
      prompt: "p",
      schedule: { type: "manual" },
    });
    expect(task.workspace).toBeNull();
  });

  it("带 id 为整体替换；不存在的 id 拒绝", async () => {
    const { workspace, store } = setup();
    const task = await store.save(base(workspace));
    const edited = await store.save({
      ...base(workspace),
      id: task.id,
      name: "改名",
      permissionPreset: "smart",
      reasoningEffort: "high",
      model: "p/m",
      maxDurationMinutes: 5,
    });
    expect(edited).toMatchObject({
      id: task.id,
      name: "改名",
      permissionPreset: "smart",
      reasoningEffort: "high",
      model: "p/m",
      maxDurationMinutes: 5,
      createdAt: task.createdAt,
    });
    expect(await store.list()).toHaveLength(1);
    await expect(store.save({ ...base(workspace), id: "nope" })).rejects.toThrow("任务不存在");
  });

  it("起算时刻：改计划和从暂停恢复时重置，改名等不重置", async () => {
    const { workspace, store, setNow } = setup();
    const task = await store.save(base(workspace));
    setNow(Date.parse("2026-10-26T00:00:00Z"));
    const renamed = await store.save({ ...base(workspace), id: task.id, name: "改名" });
    expect(renamed.anchorAt).toBe(task.anchorAt);
    const moved = await store.save({
      ...base(workspace),
      id: task.id,
      schedule: { type: "daily", time: "10:00" },
    });
    expect(moved.anchorAt).toBe("2026-10-26T00:00:00.000Z");
    setNow(Date.parse("2026-10-27T00:00:00Z"));
    const later = { ...base(workspace), schedule: { type: "daily" as const, time: "10:00" } };
    const paused = await store.save({ ...later, id: task.id, enabled: false });
    expect(paused.anchorAt).toBe(moved.anchorAt);
    setNow(Date.parse("2026-10-28T00:00:00Z"));
    const resumed = await store.save({ ...later, id: task.id, enabled: true });
    expect(resumed.anchorAt).toBe("2026-10-28T00:00:00.000Z");
  });

  it("重新读取得到同样的任务", async () => {
    const { home, workspace, store } = setup();
    const task = await store.save(base(workspace));
    const again = createScheduleStore({ platform: createPlatform(), home });
    expect(await again.list()).toEqual([task]);
  });

  it("删除：任务和历史一起删除，返回是否删除了", async () => {
    const { home, workspace, store } = setup();
    const task = await store.save(base(workspace));
    await store.appendHistory(task.id, {
      id: "a",
      scheduledAt: "2026-10-25T01:00:00.000Z",
      trigger: "schedule",
      result: "done",
    });
    expect(await store.remove(task.id)).toBe(true);
    expect(await store.remove(task.id)).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(readdirSync(path.join(home, "schedules", "history"))).toEqual([]);
  });
});

describe("字段校验", () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ["名称为空", { name: "  " }, "name"],
    ["名称带换行", { name: "a\nb" }, "name"],
    ["名称太长", { name: "长".repeat(81) }, "name"],
    ["指令为空", { prompt: "" }, "prompt"],
    ["指令太长", { prompt: "长".repeat(20_001) }, "prompt"],
    ["工作区是相对路径", { workspace: "relative/dir" }, "workspace"],
    ["工作区不存在", { workspace: path.join(tmpdir(), "nct-no-such-dir-xyz") }, "workspace"],
    ["模型格式不对", { model: "no-slash" }, "model"],
    ["思考档位未知", { reasoningEffort: "ultra" }, "reasoningEffort"],
    ["权限预设未知", { permissionPreset: "yolo" }, "permissionPreset"],
    ["enabled 不是布尔", { enabled: "yes" }, "enabled"],
    ["时长上限为 0", { maxDurationMinutes: 0 }, "maxDurationMinutes"],
    ["时长上限超过一天", { maxDurationMinutes: 1441 }, "maxDurationMinutes"],
    ["间隔小于 30 分钟", { schedule: { type: "interval", minutes: 10 } }, "schedule"],
  ];
  it.each(bad)("%s → ScheduleError(%s)", async (_label, patch, field) => {
    const { workspace, store } = setup();
    const error = await store.save({ ...base(workspace), ...patch } as never).catch((e) => e);
    expect(error).toBeInstanceOf(ScheduleError);
    expect((error as ScheduleError).field).toBe(field);
    expect(await store.list()).toEqual([]);
  });

  it("权限预设接受旧别名（normalizePermissionPreset）", async () => {
    const { workspace, store } = setup();
    const task = await store.save({ ...base(workspace), permissionPreset: "auto-edit" });
    expect(task.permissionPreset).toBe("auto-edit");
  });

  it("最多 100 个任务", async () => {
    const { store } = setup();
    for (let i = 0; i < 100; i++)
      await store.save({ name: `t${i}`, prompt: "p", schedule: { type: "manual" } });
    await expect(
      store.save({ name: "多了", prompt: "p", schedule: { type: "manual" } }),
    ).rejects.toThrow("最多 100");
  });
});

describe("文件损坏与写入", () => {
  it("单条无效只忽略该条并警告，其余保留", async () => {
    const { home, workspace } = setup();
    const good = {
      id: "good",
      name: "好",
      prompt: "p",
      workspace,
      schedule: { type: "manual" },
      enabled: true,
      maxDurationMinutes: 60,
      createdAt: "2026-10-25T00:00:00.000Z",
      anchorAt: "2026-10-25T00:00:00.000Z",
    };
    writeFileSync(
      path.join(home, "schedules.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          good,
          { ...good, id: "bad-plan", schedule: { type: "interval", minutes: 5 } },
          { ...good, id: "bad id!" },
          { ...good, id: "no-time", createdAt: undefined },
          { ...good, id: "good" },
          "garbage",
        ],
      }),
    );
    const store = createScheduleStore({ platform: createPlatform(), home });
    expect((await store.list()).map((t) => t.id)).toEqual(["good"]);
    expect(store.warnings).toHaveLength(5);
    expect(store.warnings.every((w) => w.startsWith("schedules_task_invalid"))).toBe(true);
  });

  it("读文件不要求工作区还在", async () => {
    const { home } = setup();
    writeFileSync(
      path.join(home, "schedules.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "gone",
            name: "n",
            prompt: "p",
            workspace: path.join(tmpdir(), "nct-gone-dir"),
            schedule: { type: "manual" },
            enabled: true,
            maxDurationMinutes: 60,
            createdAt: "2026-10-25T00:00:00.000Z",
            anchorAt: "2026-10-25T00:00:00.000Z",
          },
        ],
      }),
    );
    const store = createScheduleStore({ platform: createPlatform(), home });
    expect(await store.list()).toHaveLength(1);
  });

  it.each([
    ["不是 JSON", "{nope"],
    ["版本不符", JSON.stringify({ version: 2, tasks: [] })],
    ["tasks 不是数组", JSON.stringify({ version: 1, tasks: {} })],
  ])("文件损坏（%s）：整体忽略并警告；下一次写入先留一份副本", async (_label, content) => {
    const { home, workspace } = setup();
    writeFileSync(path.join(home, "schedules.json"), content);
    const store = createScheduleStore({ platform: createPlatform(), home });
    expect(await store.list()).toEqual([]);
    expect(store.warnings[0]).toContain("schedules_config_invalid");
    await store.save(base(workspace));
    const names = readdirSync(home);
    const backup = names.find((n) => n.startsWith("schedules.json.corrupt-"));
    expect(backup).toBeDefined();
    expect(readFileSync(path.join(home, backup as string), "utf8")).toBe(content);
    expect(JSON.parse(readFileSync(path.join(home, "schedules.json"), "utf8")).tasks).toHaveLength(
      1,
    );
  });

  it("同进程并发写入串行：10 次并发保存都在，文件始终是合法 JSON，没有残留临时文件", async () => {
    const { home, store } = setup();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.save({ name: `并发 ${i}`, prompt: "p", schedule: { type: "manual" } }),
      ),
    );
    expect(await store.list()).toHaveLength(10);
    const file = JSON.parse(readFileSync(path.join(home, "schedules.json"), "utf8"));
    expect(file.tasks).toHaveLength(10);
    expect(readdirSync(home).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("写失败时不改内存里的任务", async () => {
    const { home } = setup();
    // home 是个普通文件：建目录必然失败
    writeFileSync(path.join(home, "x"), "");
    const broken = createScheduleStore({ platform: createPlatform(), home: path.join(home, "x") });
    await expect(
      broken.save({ name: "n", prompt: "p", schedule: { type: "manual" } }),
    ).rejects.toBeTruthy();
    expect(await broken.list()).toEqual([]);
  });
});

describe("历史", () => {
  const row = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
    id,
    scheduledAt: at,
    trigger: "schedule" as const,
    result: "done" as const,
    ...extra,
  });

  it("同一次触发的多行按 id 合并，后写的覆盖先写的；最新的在前", async () => {
    const { store } = setup();
    await store.appendHistory("t1", row("a", "2026-10-24T01:00:00.000Z", { result: "running" }));
    await store.appendHistory("t1", row("b", "2026-10-25T01:00:00.000Z", { result: "running" }));
    await store.appendHistory("t1", {
      id: "a",
      scheduledAt: "2026-10-24T01:00:00.000Z",
      result: "done",
      durationMs: 1500,
    });
    const history = await store.history("t1");
    expect(history.map((h) => [h.id, h.result])).toEqual([
      ["b", "running"],
      ["a", "done"],
    ]);
    expect(history[1]).toMatchObject({ durationMs: 1500, trigger: "schedule", taskId: "t1" });
  });

  it("坏行和半行被丢弃", async () => {
    const { home, store } = setup();
    await store.appendHistory("t1", row("a", "2026-10-24T01:00:00.000Z"));
    const file = path.join(home, "schedules", "history", "t1.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"id":"half"\n[]\n{"id":1}\n`);
    expect((await store.history("t1")).map((h) => h.id)).toEqual(["a"]);
  });

  it("保留最近 200 条：写满后压实，不丢最新的", async () => {
    const { home, store } = setup();
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 450; i++)
      await store.appendHistory("t1", row(`r${i}`, new Date(start + i * 3_600_000).toISOString()));
    const history = await store.history("t1");
    expect(history).toHaveLength(200);
    expect(history[0]?.id).toBe("r449");
    expect(history.at(-1)?.id).toBe("r250");
    const lines = readFileSync(path.join(home, "schedules", "history", "t1.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(400);
  });

  it("非法任务 id 拒绝（防路径穿越）", async () => {
    const { store } = setup();
    await expect(
      store.appendHistory("../evil", row("a", "2026-10-24T01:00:00.000Z")),
    ).rejects.toThrow(ScheduleError);
  });
});
