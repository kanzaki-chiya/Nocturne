/**
 * SessionStore.list() 只读日志开头（ADR-0051 第 4 节最后一条）：
 * 首行 + 第一条 message.user 在头部内即停；否则回退整份。截断可能切在
 * 多字节字符或一行的中间，不能把半行当坏记录。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform, type Platform } from "../src/platform/index.js";
import { createSessionStore } from "../src/session/index.js";

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
