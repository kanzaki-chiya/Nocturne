import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntime,
  parseFileRefs,
  replaySessionView,
  type RuntimeEvent,
} from "../src/index.js";
import { createDefaultPolicy } from "../src/permission/index.js";
import { createPlatform } from "../src/platform/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { createAttachmentStore, createReadStateStore } from "../src/tools/index.js";
import { resolveFileRefs } from "../src/tools/file-refs.js";

const platform = createPlatform();
const roots: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-refs-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resolve(ws: string, text: string, imageInput = false) {
  const readState = createReadStateStore(platform.paths);
  return {
    readState,
    result: resolveFileRefs([{ type: "text", text }], {
      fs: platform.fs,
      paths: platform.paths,
      cwd: ws,
      workspaceRoot: ws,
      readState,
      attachments: createAttachmentStore({
        fs: platform.fs,
        paths: platform.paths,
        attachmentsDir: path.join(ws, ".attachments"),
        sessionId: "s1",
      }),
      imageInput,
      signal: new AbortController().signal,
    }),
  };
}
const texts = (result: Awaited<ReturnType<typeof resolveFileRefs>>): string[] =>
  result.content.filter((b) => b.type === "text").map((b) => b.text);

describe("@ 引用语法与快照", () => {
  it("开头、空白与引号路径保留准确范围，邮箱和词内 @ 不识别", () => {
    const text = '@a.ts  看 @"docs/my notes.md"\n@b.ts， a@b.com hello@c @"未结束';
    const refs = parseFileRefs(text);
    expect(refs.map((r) => r.path)).toEqual(["a.ts", "docs/my notes.md", "b.ts，"]);
    expect(refs.map((r) => text.slice(r.start, r.end))).toEqual([
      "@a.ts",
      '@"docs/my notes.md"',
      "@b.ts，",
    ]);
    expect(parseFileRefs("plain email@example.org")).toEqual([]);
  });

  it("仅不存在时回退末尾标点，真实路径去重，不存在保持原文", async () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "a.ts"), "first\r\nsecond");
    writeFileSync(path.join(ws, "punct!"), "exact");
    const { result, readState } = resolve(ws, "@a.ts， @./a.ts @punct! @missing");
    const value = await result;
    expect(value.fileRefs.map((r) => r.path)).toEqual(["a.ts", "punct!"]);
    expect(texts(value)[1]).toContain("1|first\n2|second");
    expect(texts(value)[0]).toBe("@a.ts， @./a.ts @punct! @missing");
    expect(readState.get(await platform.resolveReal(path.join(ws, "a.ts")))).toMatchObject({
      size: 13,
    });
    expect(value.warnings).toEqual([]);
  });

  it.each([
    ["单行长文本", "x".repeat(60_000), 1, false],
    ["多行短文本", Array(3000).fill("a").join("\n"), 3000, false],
    ["2000 行内容更多", Array(3000).fill("x".repeat(30)).join("\n"), 2000, true],
    ["50000 字符整行内容更多", Array(8000).fill("123456").join("\n"), 7143, true],
  ])("%s：2000 行和 50000 字符取较宽上限", async (_label, raw, lines, truncated) => {
    const ws = tmp();
    writeFileSync(path.join(ws, "text"), raw);
    const value = await resolve(ws, "@text").result;
    expect(value.fileRefs[0]).toMatchObject({ lines, truncated });
    if (truncated) expect(texts(value)[1]).toContain(`第 1–${lines} 行，其余用 read 查看`);
  });

  it("合计硬上限包含行号与标签，当前文件截断后不再附加后续内容", async () => {
    const ws = tmp();
    for (const name of ["one", "two", "three"])
      writeFileSync(path.join(ws, name), Array(1000).fill("x".repeat(99)).join("\n"));
    const value = await resolve(ws, "@one @two @three").result;
    expect(texts(value).slice(1).join("").length).toBeLessThanOrEqual(150_000);
    expect(value.fileRefs.map((r) => r.path)).toEqual(["one", "two"]);
    expect(value.fileRefs[1]?.truncated).toBe(true);
    expect(value.warnings.join("\n")).toContain("150,000");
  });

  it("巨大的单行不能突破消息硬上限", async () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "giant"), "x".repeat(150_001));
    const value = await resolve(ws, "@giant").result;
    expect(value.fileRefs).toEqual([]);
    expect(texts(value)).toEqual(["@giant"]);
    expect(value.warnings).toHaveLength(1);
  });

  it("目录因总预算截断时，后续小文件也仅保留路径", async () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "large"), "x".repeat(149_000));
    writeFileSync(path.join(ws, "later"), "small");
    mkdirSync(path.join(ws, "dir"));
    for (let i = 0; i < 20; i++) writeFileSync(path.join(ws, "dir", `${i}-${"x".repeat(100)}`), "");
    const value = await resolve(ws, "@large @dir @later").result;
    expect(texts(value).slice(1).join("").length).toBeLessThanOrEqual(150_000);
    expect(value.fileRefs.map((r) => r.path)).toEqual(["large", "dir"]);
    expect(value.fileRefs[1]?.truncated).toBe(true);
    expect(value.warnings.join("\n")).toContain("后续引用仅保留路径");
  });

  it("目录只附带一层，继承上级忽略规则，最多 200 项", async () => {
    const ws = tmp();
    mkdirSync(path.join(ws, "dir", "child"), { recursive: true });
    writeFileSync(path.join(ws, ".gitignore"), "*.log\n");
    writeFileSync(path.join(ws, "dir", ".gitignore"), "local.txt\n");
    for (const name of ["local.txt", "hidden.log", ".dot", "visible.txt"])
      writeFileSync(path.join(ws, "dir", name), "");
    const value = await resolve(ws, "@dir").result;
    expect(texts(value)[1]).toBe(
      '<directory path="dir" entries="2">\nchild/\nvisible.txt\n</directory>',
    );
    for (let i = 0; i < 205; i++) writeFileSync(path.join(ws, "dir", `file${i}`), "");
    const many = await resolve(ws, "@dir").result;
    expect(texts(many)[1]).toContain('entries="200"');
    expect(many.fileRefs[0]?.truncated).toBe(true);
  });

  it("二进制提示用户，不进入 readState，损坏图片不附带", async () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "binary"), new Uint8Array([1, 0, 2]));
    writeFileSync(
      path.join(ws, "bad.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const { result, readState } = resolve(ws, "@binary @bad.png", true);
    const value = await result;
    expect(value.fileRefs).toEqual([]);
    expect(value.warnings).toHaveLength(2);
    expect(readState.get(path.join(ws, "binary"))).toBeUndefined();
  });

  it("图片按模型能力走 paste 附件通道，不写 readState", async () => {
    const ws = tmp();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      2, 0, 0, 0, 3, 8, 6, 0, 0, 0,
    ]);
    writeFileSync(path.join(ws, "pic.png"), png);
    const supported = resolve(ws, "@pic.png", true);
    const value = await supported.result;
    expect(value.attachments[0]).toMatchObject({ source: "paste", width: 2, height: 3 });
    expect(value.fileRefs).toEqual([
      { path: "pic.png", kind: "image", chars: 0, truncated: false },
    ]);
    expect(supported.readState.get(path.join(ws, "pic.png"))).toBeUndefined();
    const unsupported = await resolve(ws, "@pic.png").result;
    expect(unsupported.attachments).toEqual([]);
    expect(unsupported.fileRefs).toEqual([]);
    expect(unsupported.warnings[0]).toContain("不支持看图");
  });

  it("submit 不经过权限与工具 Hook，日志恢复保留旧快照和派生视图", async () => {
    const ws = tmp();
    const outside = tmp();
    writeFileSync(path.join(outside, "outside.txt"), "old snapshot");
    const marker = path.join(ws, "hook-ran");
    const policy = createDefaultPolicy({ workspaceRoot: ws, caseSensitive: false });
    const evaluate = vi.spyOn(policy, "evaluate");
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "ok" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
      policy,
      hooks: {
        PreToolUse: [
          {
            command: "node",
            args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
          },
        ],
      },
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.submit({ text: `@"${path.join(outside, "outside.txt")}"` });
      const original = session.state().history;
      const view = replaySessionView(session.durableEvents());
      expect(original.find((entry) => entry.kind === "user")?.fileRefs?.[0]?.kind).toBe("file");
      expect(evaluate).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      expect(
        events.some(
          (event) => event.type === "permission.requested" || event.type === "tool.started",
        ),
      ).toBe(false);
      writeFileSync(path.join(outside, "outside.txt"), "changed later");
      const id = session.id;
      await session.close();
      const resumed = await runtime.resumeSession(id);
      try {
        expect(resumed.state().history).toEqual(original);
        expect(replaySessionView(resumed.durableEvents()).entries).toEqual(view.entries);
      } finally {
        await resumed.close();
      }
    } finally {
      await session.close();
    }
  });

  it("引用的完整和部分文本均可直接 edit，不必调用 read", async () => {
    for (const partial of [false, true]) {
      const ws = tmp();
      writeFileSync(
        path.join(ws, "edit.txt"),
        "replace me\n" + (partial ? Array(3000).fill("x".repeat(30)).join("\n") : "rest"),
      );
      const provider = new FakeProvider({
        scripts: [
          [
            {
              type: "tool_call",
              toolCallId: "c1",
              name: "edit",
              input: { path: "edit.txt", old: "replace me", new: "replaced" },
            },
            { type: "finish", reason: "tool_calls" },
          ],
          [
            { type: "text_delta", text: "ok" },
            { type: "finish", reason: "stop" },
          ],
        ],
      });
      const runtime = await createRuntime({
        cwd: ws,
        sessionsDir: path.join(ws, ".sessions"),
        providers: [provider],
      });
      const session = await runtime.createSession({
        model: "fake/fake-1",
        permissionPreset: "guarded",
      });
      try {
        await session.submit({ text: "@edit.txt 修改第一行" });
        expect(readFileSync(path.join(ws, "edit.txt"), "utf8").startsWith("replaced\n")).toBe(true);
        const user = session.state().history.find((entry) => entry.kind === "user");
        expect(user?.fileRefs?.[0]?.truncated).toBe(partial);
        expect(
          session
            .durableEvents()
            .filter((event) => event.type === "tool.completed")
            .map((event) => event.payload.name),
        ).toEqual(["edit"]);
      } finally {
        await session.close();
      }
    }
  });

  it("索引缓存按 Turn 失效，下一次请求可见新文件", async () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "first"), "");
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "ok" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    try {
      const first = await session.fileIndex();
      writeFileSync(path.join(ws, "new"), "");
      expect(await session.fileIndex()).toBe(first);
      await session.submit({ text: "hello" });
      expect((await session.fileIndex()).map((entry) => entry.path)).toContain("new");
    } finally {
      await session.close();
    }
  });
});
