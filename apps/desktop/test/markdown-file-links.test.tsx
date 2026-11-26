/**
 * 会话 Markdown 本地文件链接专项测试（ADR-0129）：
 * - 带标题的本地文件链接解析、标题格式保留、避免嵌套交互
 * - Windows 盘符、空格与中文、尖括号与 %20 单次解码、相对路径、POSIX 绝对路径、:行号范围
 * - 复用 session.resolveFiles 去重批查（短标题与行内代码同目标只查一次）
 * - 左键、Enter、右键（含 Windows 五项菜单、复制绝对/相对路径、工作区外、目录、受保护类型）
 * - 外链白名单与危险/非本地目标拦截（UNC、编码 UNC、协议相对、设备路径、file:、未放行协议、纯锚点）
 * - 列表、表格表头与单元格、后置引用定义、历史重开、正式消息解析一次、流式半截链接不触发查询
 */
import { createSessionView, type AssistantEntry } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation, type FileLinkHooks } from "../src/Conversation";
import type { FileAppList } from "../src/host";
import { parseMarkdownFileLinkTarget } from "../src/markdown-file-links";
import { setPlatformForTest } from "../src/platform";

interface ResolveEntry {
  input: string;
  absolutePath: string;
  relativePath?: string | undefined;
  withinWorkspace: boolean;
  exists: boolean;
  isDirectory: boolean;
}

function assistant(text: string, seq = 1, key = "assistant-1"): AssistantEntry {
  return {
    kind: "assistant",
    key,
    seq,
    turnId: `turn-${seq}`,
    messageId: `msg-${seq}`,
    time: "2026-11-27T04:00:00.000Z",
    text,
    reasoning: "",
    toolCalls: [],
    model: { provider: "test", model: "model" },
    usage: undefined,
    finishReason: "stop",
  };
}

function makeAppList(overrides: Partial<FileAppList> = {}): FileAppList {
  return { apps: [], launchesCode: false, failed: false, editorIcons: {}, ...overrides };
}

function makeHooks(overrides: Partial<FileLinkHooks> = {}) {
  return {
    open: vi.fn(async () => undefined),
    outsideOpenable: vi.fn(() => true),
    editors: vi.fn(() => ({ vscode: true, cursor: false })),
    openInEditor: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    previewsHtml: vi.fn(() => false),
    viewSource: vi.fn(async () => undefined),
    listFileApps: vi.fn(async () =>
      makeAppList({ apps: [{ id: "app-notepad", name: "记事本", isDefault: true }] }),
    ),
    openFileWithApp: vi.fn(async () => undefined),
    openFileWithDialog: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mountConversation(options: {
  text?: string;
  liveText?: string;
  fileLinks?: FileLinkHooks | undefined;
  resolveFiles?: (paths: string[]) => Promise<ResolveEntry[]>;
  openUrl?: (url: string) => void;
}) {
  const view = createSessionView();
  if (options.text !== undefined) {
    view.entries = [assistant(options.text)];
  }
  if (options.liveText !== undefined) {
    view.live.assistants = [
      {
        kind: "assistant",
        messageId: "live-1",
        turnId: "turn-live",
        text: options.liveText,
        reasoning: "",
      },
    ];
  }
  const resolveFiles = vi.fn(options.resolveFiles ?? (async () => []));
  const openUrl = vi.fn(options.openUrl ?? (() => undefined));
  const session = {
    id: "s-md-file-links",
    readAttachment: vi.fn(),
    respondPermission: vi.fn(),
    respondSubagentPermission: vi.fn(),
    respondQuestion: vi.fn(),
    resolveFiles,
  } as unknown as RpcSession;

  const rendered = render(
    <Conversation
      view={view}
      session={session}
      cwd="Z:\\project"
      busy={options.liveText !== undefined}
      images={createAttachmentImageSource()}
      subscribeEvents={() => () => undefined}
      openUrl={openUrl}
      fileLinks={options.fileLinks}
    />,
  );
  return { ...rendered, resolveFiles, openUrl, session, view };
}

function directItemLabels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .filter((item) => item.closest('[role="menu"]') === menu)
    .map((item) => item.textContent ?? "");
}

beforeEach(() => {
  setPlatformForTest("windows");
});

afterEach(() => {
  cleanup();
  setPlatformForTest(null);
  vi.restoreAllMocks();
});

describe("会话 Markdown 本地文件链接（ADR-0129）", () => {
  it("报告标题可点击与回车激活，悬停显示实际路径，打开钩子收到实际路径与行号，右键复制实际绝对路径", async () => {
    const fileLinks = makeHooks({ outsideOpenable: vi.fn(() => true) });
    const target = "Z:/nocturne-mockups/impl/r1126i/report.md";
    const resolvedAbs = "Z:\\nocturne-mockups\\impl\\r1126i\\report.md";
    const { resolveFiles, openUrl } = mountConversation({
      text: `请查阅 [验收报告](<${target}:12-20>)。`,
      fileLinks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: resolvedAbs,
          withinWorkspace: false,
          exists: input === target,
          isDirectory: false,
        })),
    });

    const link = await screen.findByRole("button", { name: "验收报告" });
    expect(link.tagName).toBe("SPAN");
    expect(link.tabIndex).toBe(0);
    expect(link.getAttribute("title")).toBe(resolvedAbs);
    expect(resolveFiles).toHaveBeenCalledTimes(1);
    expect(resolveFiles).toHaveBeenCalledWith([target]);

    // 左键打开：收到实际绝对路径与行号范围
    fireEvent.click(link);
    await waitFor(() => {
      expect(fileLinks.open).toHaveBeenCalledWith(resolvedAbs, 12, { endLine: 20 });
    });

    // Enter 键盘激活：同样打开
    fireEvent.keyDown(link, { key: "Enter" });
    await waitFor(() => {
      expect(fileLinks.open).toHaveBeenCalledTimes(2);
    });
    expect(fileLinks.open).toHaveBeenLastCalledWith(resolvedAbs, 12, { endLine: 20 });

    // 右键菜单：工作区外 + 面板/编辑器模式保留「打开」「在资源管理器中显示」「复制绝对路径」，复制值为实际绝对路径而非标题
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole("menu");
    expect(directItemLabels(menu)).toEqual(["打开", "在资源管理器中显示", "复制绝对路径"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "复制绝对路径" }));
    expect(fileLinks.copy).toHaveBeenCalledWith(resolvedAbs);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("保留粗体等标题格式，且标题中的行内代码不生成嵌套交互项也不触发额外解析", async () => {
    const fileLinks = makeHooks();
    const { resolveFiles } = mountConversation({
      text: "查看 [**验收报告** 与 `src/nested.ts`](<Z:/project/docs/report.md>)",
      fileLinks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "Z:\\project\\docs\\report.md",
          relativePath: "docs\\report.md",
          withinWorkspace: true,
          exists: true,
          isDirectory: false,
        })),
    });

    const button = await screen.findByRole("button", { name: "验收报告 与 src/nested.ts" });
    expect(button.querySelector("strong")?.textContent).toBe("验收报告");
    expect(button.querySelector("code")?.textContent).toBe("src/nested.ts");
    // 标题内部不存在嵌套的可交互按钮
    expect(button.querySelectorAll('[role="button"]')).toHaveLength(0);
    // 仅查询外层链接目标，不把标题内的行内代码送进 resolveFiles
    expect(resolveFiles).toHaveBeenCalledTimes(1);
    expect(resolveFiles).toHaveBeenCalledWith(["Z:/project/docs/report.md"]);
  });

  it("相同目标在短标题和行内代码间去重，只调用一次 resolveFiles", async () => {
    const fileLinks = makeHooks();
    const { resolveFiles } = mountConversation({
      text: "见 [源码说明](src/my%20file.ts:10) 以及 `src/my file.ts:25` 和 [再次查看](<src/my file.ts:30-35>)",
      fileLinks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "Z:\\project\\src\\my file.ts",
          relativePath: "src\\my file.ts",
          withinWorkspace: true,
          exists: true,
          isDirectory: false,
        })),
    });

    const link1 = await screen.findByRole("button", { name: "源码说明" });
    const codeRef = await screen.findByRole("button", { name: "src/my file.ts:25" });
    const link2 = await screen.findByRole("button", { name: "再次查看" });
    expect(resolveFiles).toHaveBeenCalledTimes(1);
    expect(resolveFiles).toHaveBeenCalledWith(["src/my file.ts"]);

    fireEvent.click(link1);
    fireEvent.click(codeRef);
    fireEvent.click(link2);
    await waitFor(() => {
      expect(fileLinks.open).toHaveBeenCalledTimes(3);
    });
    expect(fileLinks.open).toHaveBeenNthCalledWith(1, "Z:\\project\\src\\my file.ts", 10, {
      endLine: undefined,
    });
    expect(fileLinks.open).toHaveBeenNthCalledWith(2, "Z:\\project\\src\\my file.ts", 25, {
      endLine: undefined,
    });
    expect(fileLinks.open).toHaveBeenNthCalledWith(3, "Z:\\project\\src\\my file.ts", 30, {
      endLine: 35,
    });
  });

  it("覆盖空格与中文、%20 单次解码（不重复解码）、字面百分号、相对路径与 POSIX 绝对路径", async () => {
    const fileLinks = makeHooks();
    const { resolveFiles } = mountConversation({
      text: [
        "- [尖括号空格中文](<Z:/my dir/中文 报告.md>)",
        "- [编码空格中文](Z:/my%20dir/%E4%B8%AD%E6%96%87%20%E6%8A%A5%E5%91%8A.md:4)",
        "- [双重编码](Z:/my%2520dir/keep.md)",
        "- [字面百分号](<Z:/dir/100% real.md>)",
        "- [相对路径](./docs/apps/desktop.md:8)",
        "- [POSIX路径](/Users/dev/notes/readme.md:3-6)",
      ].join("\n"),
      fileLinks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: input.startsWith("./") ? `Z:/project/${input.slice(2)}` : input,
          relativePath: input.startsWith("./") ? input.slice(2) : undefined,
          withinWorkspace: input.startsWith("./"),
          exists: true,
          isDirectory: false,
        })),
    });

    await screen.findByRole("button", { name: "尖括号空格中文" });
    await screen.findByRole("button", { name: "编码空格中文" });
    await screen.findByRole("button", { name: "双重编码" });
    await screen.findByRole("button", { name: "字面百分号" });
    await screen.findByRole("button", { name: "相对路径" });
    const posixBtn = await screen.findByRole("button", { name: "POSIX路径" });

    expect(resolveFiles).toHaveBeenCalledTimes(1);
    expect(resolveFiles).toHaveBeenCalledWith([
      "Z:/my dir/中文 报告.md",
      // 双重编码 %2520 只解一次为 %20，不会变成空格
      "Z:/my%20dir/keep.md",
      "Z:/dir/100% real.md",
      "./docs/apps/desktop.md",
      "/Users/dev/notes/readme.md",
    ]);

    fireEvent.click(posixBtn);
    await waitFor(() => {
      expect(fileLinks.open).toHaveBeenCalledWith("/Users/dev/notes/readme.md", 3, { endLine: 6 });
    });
  });

  it("工作区文件右键复用 Windows 五项菜单与相对/绝对路径复制；目录、区外系统默认与受保护类型沿用原边界", async () => {
    // 1. 普通工作区文件
    const wsHooks = makeHooks();
    mountConversation({
      text: "打开 [设计稿](docs/spec.md)",
      fileLinks: wsHooks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "Z:\\project\\docs\\spec.md",
          relativePath: "docs\\spec.md",
          withinWorkspace: true,
          exists: true,
          isDirectory: false,
        })),
    });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "设计稿" }));
    const wsMenu = await screen.findByRole("menu");
    expect(directItemLabels(wsMenu)).toEqual([
      "打开",
      "打开方式",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
    fireEvent.click(within(wsMenu).getByRole("menuitem", { name: "复制相对路径" }));
    expect(wsHooks.copy).toHaveBeenCalledWith("docs\\spec.md");

    cleanup();

    // 2. 工作区目录：左键走 openFolder，右键省略「打开方式」
    const dirHooks = makeHooks();
    mountConversation({
      text: "查看 [核心目录](packages/core)",
      fileLinks: dirHooks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "Z:\\project\\packages\\core",
          relativePath: "packages\\core",
          withinWorkspace: true,
          exists: true,
          isDirectory: true,
        })),
    });
    const dirBtn = await screen.findByRole("button", { name: "核心目录" });
    fireEvent.click(dirBtn);
    await waitFor(() => {
      expect(dirHooks.openFolder).toHaveBeenCalledWith("Z:\\project\\packages\\core");
    });
    fireEvent.contextMenu(dirBtn);
    const dirMenu = await screen.findByRole("menu");
    expect(directItemLabels(dirMenu)).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
    expect(dirHooks.listFileApps).not.toHaveBeenCalled();

    cleanup();

    // 3. 工作区外 + 系统默认（outsideOpenable = false）：左键只开菜单，无「打开」
    const outsideLockedHooks = makeHooks({ outsideOpenable: vi.fn(() => false) });
    mountConversation({
      text: "检查 [系统文件](<C:/Windows/tool.exe>)",
      fileLinks: outsideLockedHooks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "C:\\Windows\\tool.exe",
          withinWorkspace: false,
          exists: true,
          isDirectory: false,
        })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "系统文件" }));
    const lockedMenu = await screen.findByRole("menu");
    expect(directItemLabels(lockedMenu)).toEqual(["在资源管理器中显示", "复制绝对路径"]);
    expect(outsideLockedHooks.open).not.toHaveBeenCalled();

    cleanup();

    // 4. 受保护脚本类型：二级菜单仅安全编辑器，不含「更多打开方式…」
    const scriptHooks = makeHooks({
      listFileApps: vi.fn(async () => makeAppList({ apps: [], launchesCode: true })),
    });
    mountConversation({
      text: "运行前先看 [发布脚本](scripts/deploy.ps1:9)",
      fileLinks: scriptHooks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "Z:\\project\\scripts\\deploy.ps1",
          relativePath: "scripts\\deploy.ps1",
          withinWorkspace: true,
          exists: true,
          isDirectory: false,
        })),
    });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "发布脚本" }));
    const scriptMenu = await screen.findByRole("menu");
    fireEvent.keyDown(within(scriptMenu).getByRole("menuitem", { name: "打开方式" }), {
      key: "ArrowRight",
    });
    const sub = await screen.findByRole("menu", { name: "打开方式" });
    expect(directItemLabels(sub)).toEqual(["VS Code"]);
    expect(within(sub).queryByRole("menuitem", { name: "更多打开方式…" })).toBeNull();
  });

  it("外链白名单照常走 openUrl；UNC、编码网络路径、协议相对、设备路径、file:、未放行协议与纯锚点均不进 resolveFiles 且不误打开", async () => {
    const fileLinks = makeHooks();
    const { resolveFiles, openUrl } = mountConversation({
      text: [
        "- [安全网页](https://example.com/docs)",
        "- [本机服务](http://localhost:3000/callback)",
        "- [明文外网](http://example.com/nope)",
        "- [协议相对](//example.com/file.md)",
        "- [UNC斜杠](//server/share/secret.txt)",
        "- [UNC反斜杠](<\\\\server\\share\\secret.txt>)",
        "- [UNC双反斜杠](<\\\\\\\\server\\share\\secret.txt>)",
        "- [编码斜杠网络](%2F%2Fserver/share/secret.txt)",
        "- [编码反斜杠网络](%5C%5Cserver%5Cshare%5Csecret.txt)",
        "- [设备点](<\\\\.\\C:\\boot.ini>)",
        "- [设备问号](<\\\\?\\C:\\boot.ini>)",
        "- [设备双问号](<\\??\\C:\\boot.ini>)",
        "- [编码设备](%5C%5C.%5CC%3A%5Cboot.ini)",
        "- [编码UNC扩展](%5C%5C%3F%5CUNC%5Chost%5Cshare)",
        "- [file协议](file:///Z:/project/a.md)",
        "- [编码file协议](file%3A///Z:/project/a.md)",
        "- [脚本协议](javascript:alert(1))",
        "- [编辑器协议](vscode://file/Z:/project/a.md)",
        "- [邮件协议](mailto:test@example.com)",
        "- [纯锚点](#section-1)",
        "- [有效本地文件](src/ok.ts)",
        "- [缺失本地文件](src/missing.ts)",
      ].join("\n"),
      fileLinks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: `Z:\\project\\${input}`,
          relativePath: input,
          withinWorkspace: true,
          exists: input === "src/ok.ts",
          isDirectory: false,
        })),
    });

    // 只有合法本地候选进入 resolveFiles
    await screen.findByRole("button", { name: "有效本地文件" });
    expect(resolveFiles).toHaveBeenCalledTimes(1);
    expect(resolveFiles).toHaveBeenCalledWith(["src/ok.ts", "src/missing.ts"]);

    // 放行外链仍渲染为 <a> 并调 openUrl
    const httpsLink = screen.getByRole("link", { name: "安全网页" });
    fireEvent.click(httpsLink);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    const localHttp = screen.getByRole("link", { name: "本机服务" });
    fireEvent.click(localHttp);
    expect(openUrl).toHaveBeenCalledWith("http://localhost:3000/callback");
    expect(openUrl).toHaveBeenCalledTimes(2);

    // 所有被拦截目标和失效目标均保留可读标题，非按钮非链接，点击不触发 open 或 openUrl
    const inertTitles = [
      "明文外网",
      "协议相对",
      "UNC斜杠",
      "UNC反斜杠",
      "UNC双反斜杠",
      "编码斜杠网络",
      "编码反斜杠网络",
      "设备点",
      "设备问号",
      "设备双问号",
      "编码设备",
      "编码UNC扩展",
      "file协议",
      "编码file协议",
      "脚本协议",
      "编辑器协议",
      "邮件协议",
      "纯锚点",
      "缺失本地文件",
    ];
    for (const label of inertTitles) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
      expect(screen.queryByRole("link", { name: label })).toBeNull();
      const el = screen.getByText(label);
      fireEvent.click(el);
    }
    expect(fileLinks.open).not.toHaveBeenCalled();
    expect(fileLinks.openFolder).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("支持列表、表格表头与单元格、后置引用定义与历史重开；流式半截链接和无 fileLinks 客户端不查文件", async () => {
    const fileLinks = makeHooks();
    const markdown = [
      "- 列表项：[列表报告](docs/list.md)",
      "",
      "| [表头报告](docs/head.md) | 说明 |",
      "| --- | --- |",
      "| [单元格报告](docs/cell.md:2) | [后置引用][ref-report] |",
      "",
      "[ref-report]: <Z:/outside/ref report.md>",
    ].join("\n");

    const resolver = async (paths: string[]): Promise<ResolveEntry[]> =>
      paths.map((input) => ({
        input,
        absolutePath: input.startsWith("Z:/") ? input : `Z:\\project\\${input}`,
        relativePath: input.startsWith("Z:/") ? undefined : input,
        withinWorkspace: !input.startsWith("Z:/"),
        exists: true,
        isDirectory: false,
      }));

    // 1. 首次渲染正式消息：仅查询一次，覆盖列表、表头、单元格、后置定义
    const first = mountConversation({ text: markdown, fileLinks, resolveFiles: resolver });
    await screen.findByRole("button", { name: "列表报告" });
    await screen.findByRole("button", { name: "表头报告" });
    await screen.findByRole("button", { name: "单元格报告" });
    await screen.findByRole("button", { name: "后置引用" });
    expect(first.resolveFiles).toHaveBeenCalledTimes(1);
    expect(first.resolveFiles).toHaveBeenCalledWith([
      "docs/list.md",
      "docs/head.md",
      "docs/cell.md",
      "Z:/outside/ref report.md",
    ]);

    // 2. 模拟历史重开（卸载后重新挂载）：同样可激活
    first.unmount();
    const reopened = mountConversation({ text: markdown, fileLinks, resolveFiles: resolver });
    const reopenedRef = await screen.findByRole("button", { name: "后置引用" });
    expect(reopened.resolveFiles).toHaveBeenCalledTimes(1);
    fireEvent.click(reopenedRef);
    await waitFor(() => {
      expect(fileLinks.open).toHaveBeenCalledWith("Z:/outside/ref report.md", undefined, {
        endLine: undefined,
      });
    });

    // 3. 流式输出中的完整或半截链接均不触发 resolveFiles
    reopened.unmount();
    const streaming = mountConversation({
      liveText: "正在生成 [验收报告](<Z:/outside/report.md>) 与 [半截](<Z:/outside/part",
      fileLinks,
      resolveFiles: resolver,
    });
    expect(screen.getByText("验收报告")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "验收报告" })).toBeNull();
    expect(streaming.resolveFiles).not.toHaveBeenCalled();

    // 4. 不支持本地打开的客户端（未传 fileLinks）保留可读标题，不查文件
    streaming.unmount();
    const noLocal = mountConversation({
      text: "请看 [**验收报告**](<Z:/outside/report.md>)",
      fileLinks: undefined,
      resolveFiles: resolver,
    });
    expect(screen.getByText("验收报告").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "验收报告" })).toBeNull();
    expect(noLocal.resolveFiles).not.toHaveBeenCalled();
  });

  it("纯函数边界：单次解码、NTFS 备用数据流、控制字符、无扩展名行号与非 Windows 菜单回退", async () => {
    expect(parseMarkdownFileLinkTarget("Z:/dir/report.md:10-20")).toEqual({
      path: "Z:/dir/report.md",
      line: 10,
      endLine: 20,
    });
    expect(parseMarkdownFileLinkTarget("Z:\\dir\\report.md")).toEqual({
      path: "Z:\\dir\\report.md",
    });
    expect(parseMarkdownFileLinkTarget("Makefile:10")).toEqual({
      path: "Makefile",
      line: 10,
    });
    expect(parseMarkdownFileLinkTarget("Z:/my%20dir/a%20b.md")).toEqual({
      path: "Z:/my dir/a b.md",
    });
    expect(parseMarkdownFileLinkTarget("Z:/my%2520dir/a.md")).toEqual({
      path: "Z:/my%20dir/a.md",
    });
    expect(parseMarkdownFileLinkTarget("Z:/dir/100% real.md")).toEqual({
      path: "Z:/dir/100% real.md",
    });

    // 危险或非本地目标一律返回 undefined
    for (const bad of [
      "",
      "   ",
      "#top",
      "%23top",
      "//example.com/a",
      "//server/share/a",
      "\\\\server\\share\\a",
      "\\server\\share\\a",
      "/\\server\\share",
      "%2F%2Fserver/share/a",
      "%5C%5Cserver%5Cshare%5Ca",
      "%20//server/share/a",
      "\\\\.\\C:\\a.txt",
      "\\\\?\\C:\\a.txt",
      "\\??\\C:\\a.txt",
      "??\\C:\\a.txt",
      "%5C%5C.%5CC%3A%5Ca.txt",
      "file:///Z:/a.md",
      "file:Z:/a.md",
      "file%3A///Z:/a.md",
      "https://example.com",
      "http://localhost:3000",
      "http://example.com",
      "javascript:alert(1)",
      "mailto:a@b.com",
      "tel:12345",
      "data:text/plain,hi",
      "vscode://file/Z:/a.md",
      "C:/a.txt:stream",
      "C:relative.txt",
      "Z:/dir/a%0Ab.md",
      "Z:/dir/a%00b.md",
    ]) {
      expect(parseMarkdownFileLinkTarget(bad), `should reject ${bad}`).toBeUndefined();
    }

    // 外链标题中的行内代码同样不生成嵌套交互按钮
    const hooks = makeHooks({ previewsHtml: vi.fn(() => true) });
    setPlatformForTest("macos");
    const { resolveFiles } = mountConversation({
      text: "参考 [查看 `src/ignored.ts`](https://example.com/doc) 与 [预览页面](web/index.html)",
      fileLinks: hooks,
      resolveFiles: async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: "/Users/me/proj/web/index.html",
          relativePath: "web/index.html",
          withinWorkspace: true,
          exists: true,
          isDirectory: false,
        })),
    });

    const ext = screen.getByRole("link", { name: "查看 src/ignored.ts" });
    expect(ext.querySelector("code")?.textContent).toBe("src/ignored.ts");
    expect(ext.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect(resolveFiles).toHaveBeenCalledWith(["web/index.html"]);

    // macOS 平台右键带标题本地链接沿用原有菜单（访达 / 查看源码）
    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览页面" }));
    const macMenu = await screen.findByRole("menu");
    expect(directItemLabels(macMenu)).toEqual([
      "打开",
      "查看源码",
      "访达",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
  });
});
