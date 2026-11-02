import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatform } from "../src/platform/index.js";
import {
  createSessionStore,
  searchSessions,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "../src/session/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  dir: string;
  search: (query: string, options?: SessionSearchOptions) => Promise<SessionSearchResult[]>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-session-search-"));
  roots.push(dir);
  const platform = createPlatform();
  const store = createSessionStore({ platform, sessionsDir: dir });
  return {
    dir,
    search: (query, options) => searchSessions(platform, store, dir, query, options),
  };
}

function event(id: string, seq: number, type: string, payload: object): string {
  return JSON.stringify({
    type,
    sessionId: id,
    seq,
    time: "2026-10-01T00:00:00.000Z",
    ...(type.startsWith("message.") || type.startsWith("tool.") || type === "session.rewound"
      ? { turnId: "turn-1" }
      : {}),
    payload,
  });
}

function created(id: string, parent?: object): string {
  return event(id, 1, "session.created", {
    formatVersion: 1,
    nocturneVersion: "0.0.0-test",
    cwd: "Z:/workspace",
    workspaceRoot: "Z:/workspace",
    model: { provider: "fake", model: "fake-model" },
    permissionPreset: "guarded",
    ...(parent ?? {}),
  });
}

function user(id: string, seq: number, text: string): string {
  return event(id, seq, "message.user", {
    messageId: `user-${seq}`,
    content: [{ type: "text", text }],
  });
}

function assistant(id: string, seq: number, blocks: object[]): string {
  return event(id, seq, "message.assistant", {
    messageId: `assistant-${seq}`,
    model: { provider: "fake", model: "fake-model" },
    content: blocks,
    toolCalls: [],
    finishReason: "stop",
  });
}

function tool(id: string, seq: number, modelContent: string, output?: unknown): string {
  return event(id, seq, "tool.completed", {
    callId: `call-${seq}`,
    name: "read",
    status: "ok",
    modelContent,
    ...(output === undefined ? {} : { output }),
  });
}

function writeLog(dir: string, id: string, lines: string[], mtimeMs = 1000): void {
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("跨会话全文搜索", () => {
  it("前排文件未完成时，缓冲中的命中达到上限也停止打开更旧日志", async () => {
    const platform = createPlatform();
    const gate = Promise.withResolvers<undefined>();
    const summaries = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      mtimeMs: 500 - i,
      createdAt: "",
      cwd: "",
      workspaceRoot: "",
      model: { provider: "fake", model: "fake" },
    }));
    const opened: string[] = [];
    platform.fs.readLines = async function* (file) {
      const id = path.basename(file, ".jsonl");
      opened.push(id);
      if (id === "s0") await gate.promise;
      yield user(id, 2, "目标");
    };
    const batches: SessionSearchResult[][] = [];
    const pending = searchSessions(platform, { list: async () => summaries }, "unused", "目标", {
      onProgress: (batch) => batches.push(batch),
    });
    await vi.waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(200));
    expect(opened.length).toBeLessThanOrEqual(203);
    expect(batches).toEqual([]);
    gate.resolve(undefined);
    const results = await pending;
    expect(results.map((item) => item.sessionId)).toEqual(
      Array.from({ length: 200 }, (_, i) => `s${i}`),
    );
    expect(batches.flat()).toEqual(results);
    expect(opened.length).toBeLessThanOrEqual(203);
  });
  it("乱序完成只交出已确定的前缀，同轮合批，拼接等于最终结果", async () => {
    const platform = createPlatform();
    const summaries = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      mtimeMs: 5 - i,
      createdAt: "",
      cwd: "",
      workspaceRoot: "",
      model: { provider: "fake", model: "fake" },
    }));
    const gates = summaries.map(() => Promise.withResolvers<undefined>());
    const started: string[] = [];
    platform.fs.readLines = async function* (file) {
      const id = path.basename(file, ".jsonl");
      started.push(id);
      await gates[Number(id.slice(1))]?.promise;
      yield user(id, 2, "目标");
    };
    const batches: SessionSearchResult[][] = [];
    const pending = searchSessions(platform, { list: async () => summaries }, "unused", "目标", {
      onProgress: (batch) => batches.push(batch),
    });
    await vi.waitFor(() => expect(started).toHaveLength(4));
    gates[1]?.resolve(undefined);
    gates[2]?.resolve(undefined);
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(batches).toEqual([]);
    gates[0]?.resolve(undefined);
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]?.map((item) => item.sessionId)).toEqual(["s0", "s1", "s2"]);
    gates[4]?.resolve(undefined);
    await Promise.resolve(undefined);
    gates[3]?.resolve(undefined);
    const results = await pending;
    expect(batches.flat()).toEqual(results);
    expect(results.map((item) => item.sessionId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("取消后已排队或迟到的完成不再回调", async () => {
    const platform = createPlatform();
    const gate = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    platform.fs.readLines = async function* () {
      started.resolve(undefined);
      await gate.promise;
      yield user("s", 2, "目标");
    };
    const controller = new AbortController();
    const onProgress = vi.fn();
    const pending = searchSessions(
      platform,
      {
        list: async () => [
          {
            id: "s",
            mtimeMs: 1,
            createdAt: "",
            cwd: "",
            workspaceRoot: "",
            model: { provider: "fake", model: "fake" },
          },
        ],
      },
      "unused",
      "目标",
      { signal: controller.signal, onProgress },
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    controller.abort();
    gate.resolve(undefined);
    await rejected;
    expect(onProgress).not.toHaveBeenCalled();
  });
  it("搜索当前标题、用户消息、助手正文和工具展示文本；每会话至多一条并按更新时间排序", async () => {
    const { dir, search } = fixture();
    writeLog(
      dir,
      "title",
      [
        created("title"),
        user("title", 2, "原始标题"),
        event("title", 3, "session.titled", { title: "发布检查", source: "user" }),
      ],
      1000,
    );
    writeFileSync(
      path.join(dir, "title.title.json"),
      JSON.stringify({ title: "发布检查", seq: 3 }),
    );
    writeLog(dir, "user", [created("user"), user("user", 2, "请检查发布检查脚本")], 3000);
    writeLog(
      dir,
      "assistant",
      [
        created("assistant"),
        user("assistant", 2, "普通问题"),
        assistant("assistant", 3, [{ type: "text", text: "发布检查已经通过" }]),
      ],
      2000,
    );
    writeLog(
      dir,
      "tool",
      [
        created("tool"),
        user("tool", 2, "普通问题"),
        tool("tool", 3, "读取到 发布检查 配置", { modelContent: "不应搜这个键" }),
      ],
      4000,
    );

    const results = await search("发布检查");
    expect(results.map((result) => result.sessionId)).toEqual([
      "tool",
      "user",
      "assistant",
      "title",
    ]);
    expect(results.find((result) => result.sessionId === "title")).toEqual({
      sessionId: "title",
      mtimeMs: 1000,
    });
    expect(results.find((result) => result.sessionId === "tool")?.snippet).toContain(
      "读取到 发布检查 配置",
    );
    expect(results.find((result) => result.sessionId === "tool")?.snippet).not.toContain(
      "不应搜这个键",
    );
    expect(await search("不应搜这个键")).toEqual([]);
  });

  it("不区分大小写，支持中文、引号与换行，并返回片段范围和事件 seq", async () => {
    const { dir, search } = fixture();
    writeLog(dir, "quoted", [
      created("quoted"),
      user("quoted", 2, '前面内容\n他说："Neo 需要检查"，后面还有内容'),
    ]);
    const [result] = await search("neo 需要");
    expect(result?.seq).toBe(2);
    expect(result?.snippet).toBe('前面内容 他说："Neo 需要检查"，后面还有内容');
    expect(result?.ranges).toEqual([{ start: 9, end: 15 }]);
    expect(result?.snippet?.slice(9, 15)).toBe("Neo 需要");
    expect(await search("发布检查".toLowerCase())).toEqual([]);
  });

  it("片段在命中词前最多保留 14 个字，并标出片段内全部命中", async () => {
    const { dir, search } = fixture();
    writeLog(dir, "long", [
      created("long"),
      user("long", 2, `${"前".repeat(30)}命中 中间 命中${"后".repeat(200)}`),
    ]);
    const [result] = await search("命中");
    expect(result?.snippet?.startsWith(`…${"前".repeat(14)}命中`)).toBe(true);
    expect(result?.ranges).toHaveLength(2);
    for (const range of result?.ranges ?? []) {
      expect(result?.snippet?.slice(range.start, range.end)).toBe("命中");
    }
  });

  it("不搜思考内容，排除子会话和回退丢弃的事件，损坏行不拖垮搜索", async () => {
    const { dir, search } = fixture();
    writeLog(dir, "reasoning", [
      created("reasoning"),
      user("reasoning", 2, "普通问题"),
      assistant("reasoning", 3, [{ type: "reasoning", text: "秘密目标词" }]),
    ]);
    writeLog(dir, "child", [
      created("child", { parent: { sessionId: "parent", callId: "call-1" } }),
      user("child", 2, "秘密目标词"),
    ]);
    writeLog(dir, "rewound", [
      created("rewound"),
      user("rewound", 2, "原始消息"),
      assistant("rewound", 3, [{ type: "text", text: "秘密目标词" }]),
      event("rewound", 4, "session.rewound", {
        targetSeq: 3,
        mode: "conversation",
        files: [],
      }),
      user("rewound", 5, "回退后的消息"),
    ]);
    writeLog(dir, "damaged", [created("damaged"), "{broken", user("damaged", 3, "秘密目标词")]);

    const results = await search("秘密目标词");
    expect(results.map((result) => result.sessionId)).toEqual(["damaged"]);
    expect(results[0]?.seq).toBe(3);
  });

  it("最早的命中被回退后取回退之后的命中，未被裁掉的最早命中不受后续回退影响", async () => {
    const { dir, search } = fixture();
    const rewound = (id: string, seq: number, targetSeq: number) =>
      event(id, seq, "session.rewound", { targetSeq, mode: "both", files: [] });
    writeLog(dir, "redo", [
      created("redo"),
      user("redo", 2, "目标词 第一次"),
      user("redo", 3, "目标词 第二次"),
      rewound("redo", 4, 2),
      user("redo", 5, "目标词 重新问"),
    ]);
    writeLog(dir, "keep", [
      created("keep"),
      user("keep", 2, "目标词 保留"),
      user("keep", 3, "其它"),
      user("keep", 4, "目标词 被裁掉"),
      rewound("keep", 5, 3),
    ]);
    const results = await search("目标词");
    expect(results.find((item) => item.sessionId === "redo")?.seq).toBe(5);
    expect(results.find((item) => item.sessionId === "keep")?.seq).toBe(2);
  });

  it("读取完整日志，能命中 64 KiB 头部之外的尾部", async () => {
    const { dir, search } = fixture();
    writeLog(dir, "deep", [
      created("deep"),
      user("deep", 2, "标题"),
      ...Array.from({ length: 100 }, (_, index) =>
        event("deep", index + 3, "session.titled", { title: `填充 ${index}` }),
      ),
      tool("deep", 103, `${"x".repeat(70 * 1024)}尾部目标`),
    ]);
    const [result] = await search("尾部目标");
    expect(result?.sessionId).toBe("deep");
    expect(result?.seq).toBe(103);
  });

  it("最多返回 200 条，空查询不扫描", async () => {
    const { dir, search } = fixture();
    for (let index = 0; index < 205; index += 1) {
      const id = `session-${index}`;
      writeLog(dir, id, [created(id), user(id, 2, "共同命中")], index + 1);
    }
    const batches: SessionSearchResult[][] = [];
    const results = await search("共同命中", { onProgress: (batch) => batches.push(batch) });
    expect(batches.flat()).toEqual(results);
    expect(results).toHaveLength(200);
    expect(results[0]?.sessionId).toBe("session-204");
    expect(results.at(-1)?.sessionId).toBe("session-5");
    expect(await search("")).toEqual([]);
  });
});
