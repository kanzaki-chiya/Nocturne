/**
 * SessionStore.list() 只读日志开头（ADR-0051 第 4 节最后一条）：
 * 首行 + 第一条 message.user 在头部内即停；否则回退整份。截断可能切在
 * 多字节字符或一行的中间，不能把半行当坏记录。
 * 文件级并发（最多 8 个）不改变这些语义，也不改变排序与同时间的先后。
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform, type Platform } from "../src/platform/index.js";
import { createSessionStore, type SessionSummary } from "../src/session/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "nct-list-"));
  roots.push(d);
  return d;
}

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

function createdLine(id: string, cwd: string): string {
  return JSON.stringify({
    type: "session.created",
    sessionId: id,
    seq: 1,
    time: "2026-10-01T00:00:00.000Z",
    payload: {
      formatVersion: 1,
      nocturneVersion: "0.0.0-test",
      cwd,
      workspaceRoot: cwd,
      model: { provider: "fake", model: "fake-model" },
      permissionPreset: "guarded",
    },
  });
}

function userLine(id: string, seq: number, text: string): string {
  return JSON.stringify({
    type: "message.user",
    sessionId: id,
    seq,
    time: "2026-10-01T00:00:01.000Z",
    turnId: `turn-1-x`,
    payload: { messageId: `m-${seq}`, content: [{ type: "text", text }] },
  });
}

function titledLine(id: string, seq: number, title: string): string {
  return JSON.stringify({
    type: "session.titled",
    sessionId: id,
    seq,
    time: "2026-10-01T00:00:02.000Z",
    payload: { title, model: "fake/fake-model" },
  });
}

/** 填充行：解码会失败被扫描跳过；不能包含 message.user / session.titled 子串 */
const fillerLine = (size: number) => `"${"x".repeat(Math.max(0, size - 2))}"`;

const HEAD = 64 * 1024;

interface CountedFs {
  platform: Platform;
  sliceCalls(): number;
  fullReads(): number;
}

function counting(): CountedFs {
  const base = createPlatform();
  let slices = 0;
  let fulls = 0;
  const platform: Platform = {
    ...base,
    fs: {
      ...base.fs,
      readFileSlice: async (p, n) => {
        slices += 1;
        return base.fs.readFileSlice(p, n);
      },
      readFile: async (p) => {
        fulls += 1;
        return base.fs.readFile(p);
      },
      readTextFile: async (p) => {
        fulls += 1;
        return base.fs.readTextFile(p);
      },
    },
  };
  return { platform, sliceCalls: () => slices, fullReads: () => fulls };
}

function writeLog(dir: string, id: string, lines: string[]): void {
  writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("SessionStore.list 只读日志开头", () => {
  it("首条用户消息在开头之内：只读头部，不回退整份", async () => {
    const dir = tmpDir();
    const cwd = tmpDir();
    writeLog(dir, "s-small", [
      createdLine("s-small", cwd),
      fillerLine(1024),
      userLine("s-small", 2, "第一行用户消息\n第二行"),
      fillerLine(1024),
    ]);
    const c = counting();
    const list = await createSessionStore({ platform: c.platform, sessionsDir: dir }).list();
    expect(list).toHaveLength(1);
    // firstText 取首条用户消息的首行
    expect(list[0]?.firstText).toBe("第一行用户消息");
    expect(list[0]?.cwd).toBe(cwd);
    expect(c.sliceCalls()).toBe(1);
    expect(c.fullReads()).toBe(0);
  });

  it("首条用户消息在开头之外：回退读整份", async () => {
    const dir = tmpDir();
    writeLog(dir, "s-deep", [
      createdLine("s-deep", "/ws"),
      fillerLine(HEAD), // 把用户消息推到头部窗口之外
      fillerLine(HEAD),
      userLine("s-deep", 9, "深处的用户消息"),
    ]);
    const c = counting();
    const list = await createSessionStore({ platform: c.platform, sessionsDir: dir }).list();
    expect(list[0]?.firstText).toBe("深处的用户消息");
    expect(c.fullReads()).toBe(1);
  });

  it("截断落在多字节字符中间：不完整行丢弃不算坏记录", async () => {
    const dir = tmpDir();
    const first = createdLine("s-mb", "/ws");
    // 第二行全是三字节字符，把字节 64K 的边界逼进某个「中」字内部：
    // N 个字节在窗口内，N % 3 === 0 时加一个 ASCII 前缀打破对齐
    const n = HEAD - (bytes(first) + 1); // 首行 + '\n' 后落在第二行上的字节数
    const mbLine = `${"#".repeat(n % 3 === 0 ? 1 : 0)}${"中".repeat(Math.ceil(n / 3) + 8)}`;
    writeLog(dir, "s-mb", [first, mbLine, userLine("s-mb", 3, "多字节之后的消息")]);
    const c = counting();
    const list = await createSessionStore({ platform: c.platform, sessionsDir: dir }).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.firstText).toBe("多字节之后的消息");
    expect(c.fullReads()).toBe(1);
  });

  it("首行超长（超过头部窗口）：回退整份后正常摘要", async () => {
    const dir = tmpDir();
    const longCwd = `C:/${"d".repeat(HEAD)}`;
    writeLog(dir, "s-long", [
      createdLine("s-long", longCwd),
      userLine("s-long", 2, "首行之后的消息"),
    ]);
    const c = counting();
    const list = await createSessionStore({ platform: c.platform, sessionsDir: dir }).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.cwd).toBe(longCwd);
    expect(list[0]?.firstText).toBe("首行之后的消息");
    expect(c.fullReads()).toBe(1);
  });

  it("标题事件在头部内：firstText 取标题而非用户消息", async () => {
    const dir = tmpDir();
    writeLog(dir, "s-titled", [
      createdLine("s-titled", "/ws"),
      userLine("s-titled", 2, "原始用户消息"),
      titledLine("s-titled", 3, "生成的标题"),
    ]);
    const c = counting();
    const list = await createSessionStore({ platform: c.platform, sessionsDir: dir }).list();
    expect(list[0]?.firstText).toBe("生成的标题");
    expect(c.fullReads()).toBe(0);
  });

  it("无用户消息且文件小于窗口：不回退，firstText 缺省", async () => {
    const dir = tmpDir();
    writeLog(dir, "s-empty", [createdLine("s-empty", "/ws"), fillerLine(256)]);
    const c = counting();
    const list = await createSessionStore({ platform: c.platform, sessionsDir: dir }).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.firstText).toBeUndefined();
    expect(c.fullReads()).toBe(0);
  });

  it("cwd 过滤与 includeSubagents 语义不变", async () => {
    const dir = tmpDir();
    writeLog(dir, "s-a", [createdLine("s-a", "/ws-a"), userLine("s-a", 2, "a")]);
    writeLog(dir, "s-b", [createdLine("s-b", "/ws-b"), userLine("s-b", 2, "b")]);
    const child = JSON.parse(createdLine("s-child", "/ws-a")) as {
      payload: Record<string, unknown>;
    };
    child.payload.parent = { sessionId: "s-a", callId: "call-1" };
    writeLog(dir, "s-child", [JSON.stringify(child), userLine("s-child", 2, "child")]);

    const c = counting();
    const store = createSessionStore({ platform: c.platform, sessionsDir: dir });
    expect((await store.list({ cwd: "/ws-a" })).map((s) => s.id)).toEqual(["s-a"]);
    expect((await store.list()).map((s) => s.id).sort()).toEqual(["s-a", "s-b"]);
    expect((await store.list({ includeSubagents: true })).map((s) => s.id).sort()).toEqual([
      "s-a",
      "s-b",
      "s-child",
    ]);
  });
});

/** 指定创建时间与额外 payload 字段的 session.created 行 */
function createdLineAt(
  id: string,
  cwd: string,
  time: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "session.created",
    sessionId: id,
    seq: 1,
    time,
    payload: {
      formatVersion: 1,
      nocturneVersion: "0.0.0-test",
      cwd,
      workspaceRoot: cwd,
      model: { provider: "fake", model: "fake-model" },
      permissionPreset: "guarded",
      ...extra,
    },
  });
}

interface ListFilter {
  cwd?: string;
  includeSubagents?: boolean;
  includeArchived?: boolean;
}

/** oracle 只关心标题事件与用户消息正文这两类字段 */
interface OracleEventLine {
  type?: string;
  payload?: {
    source?: string;
    title?: string;
    content?: { type?: string; text?: string }[];
  };
}

/**
 * 独立的串行 oracle：按 readdir 顺序逐个文件整份读取，照 sessions.md 第 8 节
 * 拼装摘要。fixture 不写标题旁路与锁文件，所以 firstText 只来自标题事件与
 * 第一条用户消息，locked 恒为 false。
 */
function serialList(dir: string, filter: ListFilter = {}): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) continue;
    try {
      const file = path.join(dir, dirent.name);
      const stat = statSync(file);
      const text = readFileSync(file, "utf8");
      const created = JSON.parse(text.split("\n")[0] ?? "") as {
        type: string;
        sessionId: string;
        time: string;
        payload: {
          cwd: string;
          workspaceRoot: string;
          model: SessionSummary["model"];
          parent?: SessionSummary["parent"];
          forkedFrom?: SessionSummary["forkedFrom"];
          schedule?: SessionSummary["schedule"];
          client?: SessionSummary["client"];
        };
      };
      if (created.type !== "session.created") continue;
      const payload = created.payload;
      if (payload.parent !== undefined && filter.includeSubagents !== true) continue;
      if (filter.cwd !== undefined && payload.cwd !== filter.cwd) continue;
      const id = dirent.name.slice(0, -".jsonl".length);
      const archiveFile = path.join(dir, `${id}.archive.json`);
      const archivedAt = statSync(archiveFile, { throwIfNoEntry: false })
        ? (JSON.parse(readFileSync(archiveFile, "utf8")) as { archivedAt: string }).archivedAt
        : undefined;
      if (filter.includeArchived !== true && archivedAt !== undefined) continue;
      let sawUser = false;
      let firstText: string | undefined;
      let title: string | undefined;
      for (const line of text.split("\n")) {
        if (!line.includes("message.user") && !line.includes("session.titled")) continue;
        let event: OracleEventLine;
        try {
          event = JSON.parse(line) as OracleEventLine;
        } catch {
          continue;
        }
        if (event.type === "session.titled" && event.payload?.source !== "user") {
          if (typeof event.payload?.title === "string") title = event.payload.title;
        }
        if (event.type === "message.user" && !sawUser) {
          sawUser = true;
          const block = event.payload?.content?.find((b) => b.type === "text");
          if (typeof block?.text === "string")
            firstText = block.text
              .split("\n")
              .map((line) => line.trim())
              .find((line) => line !== "");
        }
      }
      const first = title ?? firstText;
      out.push({
        id: created.sessionId,
        createdAt: created.time,
        cwd: payload.cwd,
        workspaceRoot: payload.workspaceRoot,
        model: payload.model,
        mtimeMs: stat.mtimeMs,
        ...(archivedAt !== undefined ? { archivedAt } : {}),
        locked: false,
        ...(payload.parent !== undefined ? { parent: payload.parent } : {}),
        ...(payload.forkedFrom !== undefined ? { forkedFrom: payload.forkedFrom } : {}),
        ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
        ...(payload.client !== undefined ? { client: payload.client } : {}),
        ...(first !== undefined ? { firstText: first } : {}),
      });
    } catch {
      // 单个坏文件跳过：与 store 一致
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/** 覆盖普通、深头部回退、同时间、子会话、归档、分叉/定时/外部来源与坏日志的混合目录 */
function seedMixedSessions(): { dir: string; cwdA: string; cwdB: string } {
  const dir = tmpDir();
  const cwdA = tmpDir();
  const cwdB = tmpDir();
  writeLog(dir, "s-title", [
    createdLineAt("s-title", cwdA, "2026-10-01T00:00:01.000Z"),
    userLine("s-title", 2, "原始用户消息"),
    titledLine("s-title", 3, "生成的标题"),
  ]);
  writeLog(dir, "s-nouser", [
    createdLineAt("s-nouser", cwdA, "2026-10-01T00:00:02.000Z"),
    fillerLine(256),
  ]);
  writeLog(dir, "s-deep", [
    createdLineAt("s-deep", cwdB, "2026-10-01T00:00:03.000Z"),
    fillerLine(HEAD),
    fillerLine(HEAD),
    userLine("s-deep", 9, "深处的用户消息"),
  ]);
  writeLog(dir, "s-tie-a", [
    createdLineAt("s-tie-a", cwdB, "2026-10-01T00:00:04.000Z"),
    userLine("s-tie-a", 2, "tie a"),
  ]);
  writeLog(dir, "s-tie-b", [
    createdLineAt("s-tie-b", cwdB, "2026-10-01T00:00:04.000Z"),
    userLine("s-tie-b", 2, "tie b"),
  ]);
  writeLog(dir, "s-child", [
    createdLineAt("s-child", cwdA, "2026-10-01T00:00:05.000Z", {
      parent: { sessionId: "s-title", callId: "call-1" },
    }),
    userLine("s-child", 2, "子会话"),
  ]);
  writeLog(dir, "s-arch", [
    createdLineAt("s-arch", cwdA, "2026-10-01T00:00:06.000Z"),
    userLine("s-arch", 2, "归档会话"),
  ]);
  writeFileSync(
    path.join(dir, "s-arch.archive.json"),
    JSON.stringify({ archivedAt: "2026-10-02T00:00:00.000Z" }),
  );
  writeLog(dir, "s-fork", [
    createdLineAt("s-fork", cwdB, "2026-10-01T00:00:07.000Z", {
      forkedFrom: { sessionId: "s-title", seq: 3 },
      schedule: {
        taskId: "task-1",
        scheduledAt: "2026-10-01T00:00:00.000Z",
        trigger: "schedule",
      },
      client: { kind: "agent", name: "claude", deviceId: "device-1" },
    }),
    userLine("s-fork", 2, "来自外部 agent"),
  ]);
  writeLog(dir, "s-user-title", [
    createdLineAt("s-user-title", cwdA, "2026-10-01T00:00:08.000Z"),
    JSON.stringify({
      type: "session.titled",
      sessionId: "s-user-title",
      seq: 2,
      time: "2026-10-01T00:00:02.000Z",
      payload: { title: "用户标题", source: "user" },
    }),
    userLine("s-user-title", 3, "真正的首条消息"),
  ]);
  // 非会话文件、目录与坏日志都不进列表
  writeFileSync(path.join(dir, "notes.txt"), "忽略");
  mkdirSync(path.join(dir, "s-dir.jsonl"));
  writeFileSync(path.join(dir, "s-corrupt.jsonl"), "not a durable event\n");
  return { dir, cwdA, cwdB };
}

describe("SessionStore.list 文件级并发", () => {
  it("与串行 oracle 的所有字段、过滤结果和次序相同", async () => {
    const { dir, cwdA } = seedMixedSessions();
    const store = createSessionStore({ platform: createPlatform(), sessionsDir: dir });
    const filters: ListFilter[] = [
      {},
      { includeSubagents: true },
      { cwd: cwdA },
      { includeArchived: true },
      { cwd: cwdA, includeSubagents: true, includeArchived: true },
    ];
    for (const filter of filters) {
      const expected = serialList(dir, filter);
      // fixture 自检：默认过滤掉子会话与归档会话
      if (filter.cwd === undefined && filter.includeSubagents !== true) {
        expect(expected.map((s) => s.id)).not.toContain("s-child");
      }
      expect(await store.list(filter)).toEqual(expected);
    }
    // 默认列表按 createdAt 倒序，且不因并发而丢条目
    const listed = (await store.list()).map((s) => s.id);
    expect(listed).toContain("s-title");
    expect(listed).toContain("s-deep");
    expect(listed).toContain("s-fork");
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("createdAt 相同时保留目录枚举顺序：与完成先后无关", async () => {
    const dir = tmpDir();
    const ids = ["t-0", "t-1", "t-2", "t-3", "t-4", "t-5"];
    for (const id of ids) {
      writeLog(dir, id, [
        createdLineAt(id, "/ws", "2026-10-01T00:00:00.000Z"),
        userLine(id, 2, id),
      ]);
    }
    const expected = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
    // 越靠前的文件越晚读完：如果实现按完成顺序入列，次序就会反过来
    const base = createPlatform();
    const rank = new Map(
      expected.map((id, index) => [path.join(dir, `${id}.jsonl`), index] as const),
    );
    const platform: Platform = {
      ...base,
      fs: {
        ...base.fs,
        stat: async (p) => {
          const index = rank.get(p);
          if (index !== undefined)
            await new Promise((resolve) => setTimeout(resolve, (expected.length - index) * 10));
          return base.fs.stat(p);
        },
      },
    };
    const list = await createSessionStore({ platform, sessionsDir: dir }).list();
    expect(list.map((s) => s.id)).toEqual(expected);
  });

  it("文件级并发有界：同时在读的文件数大于 1 且不超过 8", async () => {
    const dir = tmpDir();
    const ids = Array.from({ length: 16 }, (_, i) => `s-${String(i).padStart(2, "0")}`);
    for (const [i, id] of ids.entries()) {
      writeLog(dir, id, [
        createdLineAt(id, "/ws", `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`),
        userLine(id, 2, id),
      ]);
    }
    const base = createPlatform();
    let inFlight = 0;
    let peak = 0;
    const platform: Platform = {
      ...base,
      fs: {
        ...base.fs,
        // 每个文件恰好一次 stat：同时进行的 stat 数就是在读的文件数
        stat: async (p) => {
          if (!p.endsWith(".jsonl")) return base.fs.stat(p);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          try {
            return await base.fs.stat(p);
          } finally {
            inFlight -= 1;
          }
        },
      },
    };
    const list = await createSessionStore({ platform, sessionsDir: dir }).list();
    expect(list).toHaveLength(ids.length);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    // 16 个文件足以占满全部通道
    expect(peak).toBe(8);
  });

  it("单个文件的 stat / 头部读取失败不影响其余会话", async () => {
    const dir = tmpDir();
    const ids = Array.from({ length: 12 }, (_, i) => `f-${String(i).padStart(2, "0")}`);
    ids.push("f-deep"); // 用户消息在 64 KiB 之外，走回退整份读取
    for (const [i, id] of ids.entries()) {
      const time = `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`;
      const lines =
        id === "f-deep"
          ? [
              createdLineAt(id, "/ws", time),
              fillerLine(HEAD),
              fillerLine(HEAD),
              userLine(id, 9, "深处"),
            ]
          : [createdLineAt(id, "/ws", time), userLine(id, 2, id)];
      writeLog(dir, id, lines);
    }
    const statBroken = path.join(dir, "f-00.jsonl");
    const headBroken = path.join(dir, "f-01.jsonl");
    const fullBroken = path.join(dir, "f-deep.jsonl");
    const boom = (code: string) => Object.assign(new Error(code), { code });
    const base = createPlatform();
    const platform: Platform = {
      ...base,
      fs: {
        ...base.fs,
        stat: async (p) => {
          if (p === statBroken) throw boom("EACCES");
          return base.fs.stat(p);
        },
        readFileSlice: async (p, n) => {
          if (p === headBroken) throw boom("EIO");
          return base.fs.readFileSlice(p, n);
        },
        readTextFile: async (p) => {
          if (p === fullBroken) throw boom("EIO");
          return base.fs.readTextFile(p);
        },
      },
    };
    const list = await createSessionStore({ platform, sessionsDir: dir }).list();
    const broken = new Set(["f-00", "f-01", "f-deep"]);
    expect(list.map((s) => s.id)).toEqual([...ids].reverse().filter((id) => !broken.has(id)));
  });
});
