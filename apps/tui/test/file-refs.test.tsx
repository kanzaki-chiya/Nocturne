import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type FileIndexEntry } from "@nocturne/core";
import type { PendingPermission, ToolEntry, UserEntry } from "@nocturne/core/protocol";
import { App } from "../src/app.js";
import { EntryRow } from "../src/components/transcript.js";
import { PermissionDialog } from "../src/components/permission-dialog.js";
import { splitInputTokens } from "../src/file-refs.js";
import { layoutEntry } from "../src/lines.js";
import { truncateMiddle } from "../src/format.js";
import { webFetchSummary } from "../src/web-fetch.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nct-refs-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const env = { ascii: false, animated: false };
const saveFrame = (name: string, frame: string | undefined) => {
  const dir = process.env.NOCTURNE_TEST_FRAME_DIR;
  if (dir !== undefined && frame !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.txt`), frame);
  }
};
const user: UserEntry = {
  kind: "user",
  key: "u:1",
  seq: 1,
  turnId: "t",
  content: [
    { type: "text", text: "检查 @a.ts" },
    { type: "text", text: " ；保留第二块原文" },
    { type: "text", text: "SNAPSHOT_MUST_BE_HIDDEN" },
  ],
  fileRefs: [{ path: "a.ts", kind: "file", lines: 2, totalLines: 4, chars: 90, truncated: true }],
};

describe("TUI 文件引用", () => {
  it("普通屏幕与全屏只显示原文和引用摘要", async () => {
    const { lastFrame, unmount } = render(<EntryRow entry={user} width={80} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("附带 @a.ts（2/4 行）"), {
      timeout: 5000,
    });
    expect(lastFrame()).toContain("检查 @a.ts");
    expect(lastFrame()).toContain("保留第二块原文");
    expect(lastFrame()).not.toContain("SNAPSHOT_MUST_BE_HIDDEN");
    saveFrame("file-reference", lastFrame());
    unmount();
    const lines = layoutEntry(user, 80, false);
    expect(lines.map((l) => l.text).join("\n")).toContain("附带 @a.ts（2/4 行）");
    expect(lines.map((l) => l.text).join("\n")).not.toContain("SNAPSHOT_MUST_BE_HIDDEN");
    expect(lines.map((l) => l.text).join("\n")).toContain("保留第二块原文");
    expect(
      lines[0]?.segments?.some((part) => part.text === "@a.ts" && part.color !== undefined),
    ).toBe(true);
  });
  it("旧消息多个文本块仍全部展示", () => {
    const legacy = { ...user, fileRefs: undefined };
    expect(
      layoutEntry(legacy, 80, false)
        .map((l) => l.text)
        .join("\n"),
    ).toContain("SNAPSHOT_MUST_BE_HIDDEN");
  });
  it("引用与图片用同一种强调分段，邮箱不是引用，窗口切片保留高亮", () => {
    const text = 'a@b.com @"my notes.md" [Image #1]';
    expect(
      splitInputTokens(text)
        .filter((p) => p.image)
        .map((p) => p.text),
    ).toEqual(['@"my notes.md"', "[Image #1]"]);
    expect(splitInputTokens("notes.md", text, 13)).toEqual([{ text: "notes.md", image: true }]);
  });
  it("仅图片引用没有文本快照，所有原始文本块仍显示", async () => {
    const entry: UserEntry = {
      ...user,
      content: [
        { type: "text", text: "检查 @photo.png" },
        { type: "text", text: "；第二块说明" },
      ],
      fileRefs: [{ path: "photo.png", kind: "image", chars: 0, truncated: false }],
    };
    const { lastFrame, unmount } = render(<EntryRow entry={entry} width={80} />);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain("第二块说明"), { timeout: 5000 });
      expect(lastFrame()).toContain("附带 @photo.png（图片）");
      expect(
        layoutEntry(entry, 80, false)
          .map((line) => line.text)
          .join("\n"),
      ).toContain("第二块说明");
    } finally {
      unmount();
    }
  });
  it("长引用折行后的路径续行仍保持强调色", () => {
    const entry = {
      ...user,
      content: [
        { type: "text" as const, text: '@"long folder/long file name.ts"' },
        { type: "text" as const, text: "snapshot" },
      ],
    };
    const lines = layoutEntry(entry, 20, false);
    expect(lines[1]?.segments?.some((part) => part.color !== undefined)).toBe(true);
  });
  it("索引异步完成后，Enter 逐级补全且不提交，文件补全后下次 Enter 提交", async () => {
    vi.stubEnv("NOCTURNE_HOME", temp());
    const cwd = temp();
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(path.join(cwd, "src", "main.ts"), "hello");
    const runtime = await createRuntime({
      cwd,
      sessionsDir: temp(),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const submit = vi.spyOn(session, "submit").mockResolvedValue("aborted");
    const readIndex = session.fileIndex.bind(session);
    let release!: (entries: FileIndexEntry[]) => void;
    const ready = new Promise<FileIndexEntry[]>((resolve) => {
      release = resolve;
    });
    const index = vi.spyOn(session, "fileIndex").mockReturnValue(ready);
    const { stdin, lastFrame, unmount } = render(
      <App session={session} runtime={runtime} env={env} />,
    );
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain("fake-model"), { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write("@sr");
      await vi.waitFor(() => expect(lastFrame()).toContain("正在索引"), { timeout: 5000 });
      stdin.write("\r");
      await vi.waitFor(() => expect(lastFrame()).toContain("正在索引"), { timeout: 5000 });
      expect(submit).not.toHaveBeenCalled();
      release(await readIndex());
      await vi.waitFor(() => expect(lastFrame()).toContain("src/"), { timeout: 5000 });
      stdin.write("\r");
      await vi.waitFor(() => expect(lastFrame()).toContain("src/main.ts"), { timeout: 5000 });
      saveFrame("file-completion", lastFrame());
      expect(submit).not.toHaveBeenCalled();
      stdin.write("\r");
      await vi.waitFor(() => expect(lastFrame()).toContain("@src/main.ts"), { timeout: 5000 });
      expect(submit).not.toHaveBeenCalled();
      expect(index).toHaveBeenCalledTimes(1);
      stdin.write("\r");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(submit.mock.calls[0]?.[0]).toEqual({ text: "@src/main.ts" });
    } finally {
      unmount();
      await session.close();
    }
  });
  it("Turn 完成后重新读取索引，使新增文件出现在下一次补全", async () => {
    vi.stubEnv("NOCTURNE_HOME", temp());
    const cwd = temp();
    writeFileSync(path.join(cwd, "old.ts"), "old");
    const runtime = await createRuntime({
      cwd,
      sessionsDir: temp(),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const index = vi.spyOn(session, "fileIndex");
    const { stdin, lastFrame, unmount } = render(
      <App session={session} runtime={runtime} env={env} />,
    );
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain("fake-1"), { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write("@old");
      await vi.waitFor(() => expect(lastFrame()).toContain("old.ts"), { timeout: 5000 });
      stdin.write("\u007f");
      stdin.write("\u007f");
      stdin.write("\u007f");
      stdin.write("\u007f");
      await vi.waitFor(() => expect(lastFrame()).not.toContain("@old"), { timeout: 5000 });
      writeFileSync(path.join(cwd, "new.ts"), "new");
      await session.submit({ text: "hello" });
      await vi.waitFor(() => expect(lastFrame()).toContain("hello"), { timeout: 5000 });
      stdin.write("@new");
      await vi.waitFor(() => expect(lastFrame()).toContain("new.ts"), { timeout: 5000 });
      expect(index.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      unmount();
      await session.close();
    }
  });
});

describe("网页权限与结果", () => {
  it("确认框显示中间截断的 URL 与主机会话授权", async () => {
    const pending: PendingPermission = {
      requestId: "r",
      callId: "c",
      toolName: "web_fetch",
      subjects: [
        {
          kind: "network",
          target: "docs.test",
          detail: `https://docs.test/${"x".repeat(100)}/end.html`,
        },
      ],
      reason: "请求访问",
      options: ["allow_once", "allow_session", "deny"],
    };
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <PermissionDialog pending={pending} active onReply={reply} width={80} />,
    );
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain("/end.html"), { timeout: 5000 });
      expect(lastFrame()).toContain("https://docs.test/");
      expect(lastFrame()).toContain("…");
      expect(lastFrame()).toContain("本会话允许访问 docs.test");
      saveFrame("web-permission", lastFrame());
      stdin.write("s");
      await vi.waitFor(
        () => expect(reply).toHaveBeenCalledWith({ decision: "allow", remember: "session" }),
        { timeout: 5000 },
      );
    } finally {
      unmount();
    }
    expect(truncateMiddle("中文".repeat(30) + "end", 20)).toMatch(/^中文.*….*end$/);
    expect(truncateMiddle("https://docs.test/\n\u001b[31mred\u001b[0m\tend", 80)).toBe(
      "https://docs.test/ red end",
    );
  });
  it("工具行显示 URL 与输出摘要，不铺开网页正文", async () => {
    const tool: ToolEntry = {
      kind: "tool",
      key: "t:c",
      turnId: "t",
      callId: "c",
      seq: 2,
      name: "web_fetch",
      status: "ok",
      input: { url: "https://docs.test/" },
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: {
        status: "ok",
        modelContent: "BODY_MUST_BE_HIDDEN",
        output: {
          url: "https://docs.test/",
          finalUrl: "https://docs.test/page",
          status: 200,
          contentType: "text/html",
          title: "文档页",
          chars: 1234,
          truncatedBytes: true,
        },
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: 5,
      },
    };
    const lines = layoutEntry(tool, 100, false)
      .map((l) => l.text)
      .join("\n");
    expect(lines).toContain("https://docs.test/");
    expect(lines).toContain("文档页");
    expect(lines).toContain("1234 字符");
    expect(lines).not.toContain("BODY_MUST_BE_HIDDEN");
    expect(webFetchSummary(tool)).toContain("页面过大，只处理了前 5 MB");
    const { lastFrame, unmount } = render(<EntryRow entry={tool} width={100} />);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain("文档页"), { timeout: 5000 });
      expect(lastFrame()).not.toContain("BODY_MUST_BE_HIDDEN");
      saveFrame("web-fetch-result", lastFrame());
    } finally {
      unmount();
    }
  });
});
