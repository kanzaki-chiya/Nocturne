import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime } from "../src/index.js";
import { projectMemoryKey } from "../src/memory/index.js";
import {
  computeProjectKey,
  DEFAULT_WORKSPACE_PROJECT_KEY,
  DEFAULT_WORKSPACE_PROJECT_NAME,
  resolveWorkspaceProject,
} from "../src/platform/index.js";
import { FakeProvider } from "../src/provider/index.js";
import {
  decodeDurableEvent,
  deriveSessionPages,
  encodeDurableEvent,
  replaySessionView,
  type DurableEvent,
  type RuntimeEvent,
} from "../src/protocol/index.js";
import { renderHtmlTool } from "../src/tools/index.js";

const dirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeGitRepoWithWorktree(root: string): { repoDir: string; wtDir: string } {
  const repoDir = path.join(root, "repo-alpha");
  const wtDir = path.join(root, "repo-alpha-wt");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repoDir, "README.md"), "# alpha\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "init"]);
  git(repoDir, ["worktree", "add", "-q", "-b", "feat", wtDir]);
  return { repoDir, wtDir };
}

describe("项目页面库（ADR-0114）", () => {
  it("共用项目键：主仓库与工作树同键并与记忆模块一致，默认工作区归入「对话」", async () => {
    const platform = createPlatform();
    const root = makeTmp("nct-page-key-");
    const home = path.join(root, "home");
    const defaultWs = path.join(home, "workspace");
    mkdirSync(defaultWs, { recursive: true });
    const { repoDir, wtDir } = makeGitRepoWithWorktree(root);

    const repoKey = await computeProjectKey(platform, repoDir);
    const wtKey = await computeProjectKey(platform, wtDir);
    const memKey = await projectMemoryKey(platform, wtDir);

    expect(repoKey.key).toBe(wtKey.key);
    expect(repoKey.repoRoot).toBe(wtKey.repoRoot);
    expect(memKey.key).toBe(repoKey.key);
    expect(memKey.repoRoot).toBe(repoKey.repoRoot);

    const repoProj = await resolveWorkspaceProject(platform, home, wtDir);
    expect(repoProj.key).toBe(repoKey.key);
    expect(repoProj.name).toBe("repo-alpha");
    expect(repoProj.isDefault).toBe(false);

    const defProj = await resolveWorkspaceProject(platform, home, defaultWs);
    expect(defProj.key).toBe(DEFAULT_WORKSPACE_PROJECT_KEY);
    expect(defProj.name).toBe(DEFAULT_WORKSPACE_PROJECT_NAME);
    expect(defProj.isDefault).toBe(true);
  });

  it("来源派生：新建、分叉与跨会话接着改三种情况及 inline.from 编解码兼容", () => {
    const baseCreated = (
      sessionId: string,
      forkedFrom?: { sessionId: string; seq: number },
    ): DurableEvent => ({
      type: "session.created",
      sessionId,
      seq: 1,
      time: "2026-11-24T01:00:00.000Z",
      payload: {
        formatVersion: 1,
        nocturneVersion: "0.0.0-test",
        cwd: "/repo",
        workspaceRoot: "/repo",
        model: { provider: "fake", model: "m" },
        permissionPreset: "default",
        ...(forkedFrom ? { forkedFrom } : {}),
      },
    });
    const toolOk = (
      sessionId: string,
      seq: number,
      file: string,
      inline: {
        title: string;
        page: string;
        version: number;
        display: "panel";
        from?: { session: string; page: string };
      },
    ): DurableEvent => ({
      type: "tool.completed",
      sessionId,
      seq,
      turnId: `t-${seq}`,
      time: `2026-11-24T01:0${seq}:00.000Z`,
      payload: {
        callId: `c-${seq}`,
        name: "render_html",
        status: "ok",
        modelContent: "ok",
        files: [
          {
            type: "file",
            file,
            sha256: "a".repeat(64),
            bytes: 12,
            mimeType: "text/html",
            label: `${inline.title}.html`,
            source: "upload",
            inline,
          },
        ],
      },
    });

    // 1. 新建页面：来源为自己
    const ownEvents: DurableEvent[] = [
      baseCreated("sess-a"),
      toolOk("sess-a", 2, "file-1.html", {
        title: "架构图",
        page: "page-1",
        version: 1,
        display: "panel",
      }),
    ];
    const ownPages = deriveSessionPages(ownEvents);
    expect(ownPages[0]?.origin).toEqual({ sessionId: "sess-a", page: "page-1" });
    expect(replaySessionView(ownEvents).pages[0]?.origin).toEqual({
      sessionId: "sess-a",
      page: "page-1",
    });

    // 2. 分叉继承：分叉点之前的页面来源沿用源会话，分叉后新建的页面来源为新会话
    const forkedEvents: DurableEvent[] = [
      baseCreated("sess-fork", { sessionId: "sess-a", seq: 2 }),
      toolOk("sess-a", 2, "file-1.html", {
        title: "架构图",
        page: "page-1",
        version: 1,
        display: "panel",
      }),
      toolOk("sess-fork", 3, "file-2.html", {
        title: "架构图 v2",
        page: "page-1",
        version: 2,
        display: "panel",
      }),
      toolOk("sess-fork", 4, "file-3.html", {
        title: "分叉后新图",
        page: "page-2",
        version: 1,
        display: "panel",
      }),
    ];
    const forkedPages = deriveSessionPages(forkedEvents);
    expect(forkedPages.find((p) => p.page === "page-1")?.origin).toEqual({
      sessionId: "sess-a",
      page: "page-1",
    });
    expect(forkedPages.find((p) => p.page === "page-2")?.origin).toEqual({
      sessionId: "sess-fork",
      page: "page-2",
    });

    // 3. 跨会话接着改：inline.from 决定 origin，且经 JSONL 编解码保真不升级 formatVersion
    const crossEv = toolOk("sess-c", 2, "file-1.html", {
      title: "架构图改版",
      page: "page-1",
      version: 3,
      display: "panel",
      from: { session: "sess-a", page: "page-1" },
    });
    const decoded = decodeDurableEvent(encodeDurableEvent(crossEv));
    const crossPages = deriveSessionPages([baseCreated("sess-c"), decoded]);
    expect(crossPages[0]?.origin).toEqual({ sessionId: "sess-a", page: "page-1" });
    expect(crossPages[0]?.versions[0]?.version).toBe(3);
    expect(crossPages[0]?.versions[0]?.file.inline?.from).toEqual({
      session: "sess-a",
      page: "page-1",
    });
  });

  it("页面库按项目聚合升级前历史面板页面（含工作树、归档、来源合并、删除与旁路缓存），且不再向模型暴露 list_pages 或跨会话面板编辑", async () => {
    const root = makeTmp("nct-page-lib-");
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions");
    const defaultWs = path.join(home, "workspace");
    const otherRepo = path.join(root, "repo-beta");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(defaultWs, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    const { repoDir, wtDir } = makeGitRepoWithWorktree(root);

    const writeLegacySession = (opts: {
      id: string;
      title: string;
      cwd: string;
      time: string;
      pages: {
        file: string;
        html: string;
        title: string;
        page: string;
        version: number;
        display: "panel" | "inline";
        from?: { session: string; page: string };
      }[];
      pageData?: { page: string; entries: Record<string, unknown> };
    }): void => {
      const attachDir = path.join(sessionsDir, "attachments", opts.id);
      mkdirSync(attachDir, { recursive: true });
      const events: DurableEvent[] = [
        {
          type: "session.created",
          sessionId: opts.id,
          seq: 1,
          time: opts.time,
          payload: {
            formatVersion: 1,
            nocturneVersion: "0.68.0",
            cwd: opts.cwd,
            workspaceRoot: opts.cwd,
            model: { provider: "fake", model: "fake-model" },
            permissionPreset: "default",
          },
        },
        {
          type: "session.titled",
          sessionId: opts.id,
          seq: 2,
          time: opts.time,
          payload: { title: opts.title, source: "user" },
        },
      ];
      let seq = 3;
      for (const item of opts.pages) {
        writeFileSync(path.join(attachDir, item.file), item.html, "utf8");
        events.push({
          type: "tool.completed",
          sessionId: opts.id,
          seq: seq++,
          turnId: `t-${seq}`,
          time: opts.time,
          payload: {
            callId: `c-${seq}`,
            name: "render_html",
            status: "ok",
            modelContent: "ok",
            durationMs: 5,
            files: [
              {
                type: "file",
                file: item.file,
                sha256: createHash("sha256").update(item.html, "utf8").digest("hex"),
                bytes: Buffer.byteLength(item.html),
                mimeType: "text/html",
                label: `${item.title}.html`,
                source: "upload",
                inline: {
                  title: item.title,
                  page: item.page,
                  version: item.version,
                  display: item.display,
                  ...(item.from ? { from: item.from } : {}),
                },
              },
            ],
          },
        });
      }
      if (opts.pageData) {
        const dataDir = path.join(attachDir, "page-data");
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(
          path.join(dataDir, `${opts.pageData.page}.json`),
          JSON.stringify({ version: 1, entries: opts.pageData.entries }),
          "utf8",
        );
      }
      writeFileSync(
        path.join(sessionsDir, `${opts.id}.jsonl`),
        `${events.map((e) => encodeDurableEvent(e)).join("\n")}\n`,
        "utf8",
      );
    };

    // 合成升级前的历史面板会话（主仓库、工作树、跨会话副本、其他项目、默认对话）
    writeLegacySession({
      id: "legacy-sess-a",
      title: "会话A-主仓",
      cwd: repoDir,
      time: "2026-11-23T10:00:00.000Z",
      pages: [
        {
          file: "file-1.html",
          html: "<!doctype html><html><body><h1>订单看板 v1</h1></body></html>",
          title: "订单看板",
          page: "page-1",
          version: 1,
          display: "panel",
        },
        {
          file: "file-2.html",
          html: "<!doctype html><html><body><h1>订单看板 v2</h1></body></html>",
          title: "订单看板",
          page: "page-1",
          version: 2,
          display: "panel",
        },
        {
          file: "file-3.html",
          html: "<!doctype html><html><body><p>inline only</p></body></html>",
          title: "随文小图",
          page: "page-2",
          version: 1,
          display: "inline",
        },
      ],
      pageData: { page: "page-1", entries: { filter: { region: "east" } } },
    });
    writeLegacySession({
      id: "legacy-sess-b",
      title: "会话B-工作树",
      cwd: wtDir,
      time: "2026-11-23T11:00:00.000Z",
      pages: [
        {
          file: "file-1.html",
          html: "<!doctype html><html><body><h1>WT Chart</h1></body></html>",
          title: "工作树性能图",
          page: "page-1",
          version: 1,
          display: "panel",
        },
      ],
    });
    writeLegacySession({
      id: "legacy-sess-c",
      title: "会话C-改版",
      cwd: repoDir,
      time: "2026-11-23T12:00:00.000Z",
      pages: [
        {
          file: "file-1.html",
          html: "<!doctype html><html><body><h1>订单看板 v3</h1></body></html>",
          title: "订单看板（C 改版）",
          page: "page-1",
          version: 3,
          display: "panel",
          from: { session: "legacy-sess-a", page: "page-1" },
        },
      ],
    });
    writeLegacySession({
      id: "legacy-sess-other",
      title: "其他项目会话",
      cwd: otherRepo,
      time: "2026-11-23T10:30:00.000Z",
      pages: [
        {
          file: "file-1.html",
          html: "<!doctype html><html><body><h1>Beta</h1></body></html>",
          title: "Beta 专属页",
          page: "page-1",
          version: 1,
          display: "panel",
        },
      ],
    });
    writeLegacySession({
      id: "legacy-sess-default",
      title: "普通对话会话",
      cwd: defaultWs,
      time: "2026-11-23T10:40:00.000Z",
      pages: [
        {
          file: "file-1.html",
          html: "<!doctype html><html><body><h1>Chat Page</h1></body></html>",
          title: "日常对话页",
          page: "page-1",
          version: 1,
          display: "panel",
        },
      ],
    });

    // 子会话（带 parent）：即使日志里含面板页，页面库也必须排除
    const childEvents: DurableEvent[] = [
      {
        type: "session.created",
        sessionId: "child-sub-1",
        seq: 1,
        time: "2026-11-24T01:10:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.68.0",
          cwd: repoDir,
          workspaceRoot: repoDir,
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
          parent: { sessionId: "legacy-sess-a", callId: "sub-call-1" },
        },
      },
      {
        type: "tool.completed",
        sessionId: "child-sub-1",
        seq: 2,
        turnId: "t-sub",
        time: "2026-11-24T01:11:00.000Z",
        payload: {
          callId: "c-sub",
          name: "render_html",
          status: "ok",
          modelContent: "ok",
          durationMs: 5,
          files: [
            {
              type: "file",
              file: "file-1.html",
              sha256: "b".repeat(64),
              bytes: 20,
              mimeType: "text/html",
              label: "子会话页.html",
              source: "upload",
              inline: { title: "子会话页", page: "page-1", version: 1, display: "panel" },
            },
          ],
        },
      },
    ];
    writeFileSync(
      path.join(sessionsDir, "child-sub-1.jsonl"),
      `${childEvents.map((e) => encodeDurableEvent(e)).join("\n")}\n`,
    );

    const seenToolNames: string[][] = [];
    let crossEditError = "";
    let step = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        seenToolNames.push(req.tools.map((t) => t.name));
        if (step === 0) {
          step++;
          return [
            {
              type: "tool_call",
              toolCallId: "cross-1",
              name: "render_html",
              input: { page: "legacy-sess-a/page-1", html: "<h1>试图跨会话改旧页</h1>" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const toolMsg = req.messages.findLast((m) => m.role === "tool");
        crossEditError = String(toolMsg?.content ?? "");
        return [
          { type: "text_delta", text: "已收到拒绝。" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const prevHome = process.env.NOCTURNE_HOME;
    process.env.NOCTURNE_HOME = home;
    const runtime = await createRuntime({
      cwd: repoDir,
      workspaceRoot: repoDir,
      sessionsDir,
      providers: [provider],
    });

    try {
      await runtime.archiveSession("legacy-sess-b");

      // 查询项目列表与 alpha 项目页面库
      const projectsRes = await runtime.listPageProjects({ workspaceRoot: wtDir });
      expect(projectsRes.currentProjectName).toBe("repo-alpha");
      expect(projectsRes.projects.map((p) => p.name)).toContain("repo-alpha");
      expect(projectsRes.projects.map((p) => p.name)).toContain("repo-beta");
      expect(projectsRes.projects.map((p) => p.name)).toContain("对话");

      // A 与 C 按来源合并为 1 条（取较新的 C v3），B（已归档）单独 1 条，内嵌页与子会话排除
      const alphaList = await runtime.listPages({ workspaceRoot: wtDir });
      expect(alphaList.items).toHaveLength(2);
      const merged = alphaList.items.find((i) => i.originKey === "legacy-sess-a/page-1");
      const bItem = alphaList.items.find((i) => i.sessionId === "legacy-sess-b");
      expect(merged?.sessionId).toBe("legacy-sess-c");
      expect(merged?.title).toBe("订单看板（C 改版）");
      expect(merged?.version).toBe(3);
      expect(bItem?.title).toBe("工作树性能图");
      expect(bItem?.sessionArchived).toBe(true);

      // 旁路缓存损坏时能自动重建
      const cacheFileA = path.join(sessionsDir, "legacy-sess-a.pages.json");
      expect(existsSync(cacheFileA)).toBe(true);
      writeFileSync(cacheFileA, "{not valid json");
      const alphaAfterCorrupt = await runtime.listPages({ workspaceRoot: repoDir });
      expect(alphaAfterCorrupt.items).toHaveLength(2);
      expect(() => JSON.parse(readFileSync(cacheFileA, "utf8"))).not.toThrow();

      // 恢复旧会话 A：旧面板版本与旧数据仍可按原格式读取
      const sessA = await runtime.resumeSession("legacy-sess-a");
      try {
        expect(await sessA.getPageData("page-1", "filter")).toEqual({ region: "east" });
        const v2 = await sessA.readAttachment("file-2.html");
        expect(new TextDecoder().decode(v2.data)).toContain("订单看板 v2");
      } finally {
        await sessA.close();
      }

      // 新会话：模型工具清单不含 list_pages，且跨会话 render_html ref 被拒绝
      const sessNew = await runtime.createSession({
        model: "fake/fake-model",
        cwd: repoDir,
        workspaceRoot: repoDir,
        permissionPreset: "read-only",
      });
      try {
        await sessNew.submit({ text: "尝试跨会话改旧页面" });
        expect(seenToolNames[0]).not.toContain("list_pages");
        expect(crossEditError).toContain("跨会话");
      } finally {
        await sessNew.close();
      }

      // 删除 C 与 B 的会话文件：页面库退回显示 A 的 v2，并不再残留 B
      rmSync(path.join(sessionsDir, "legacy-sess-c.jsonl"), { force: true });
      rmSync(path.join(sessionsDir, "legacy-sess-b.jsonl"), { force: true });
      const alphaAfterDelete = await runtime.listPages({ workspaceRoot: repoDir });
      expect(alphaAfterDelete.items).toHaveLength(1);
      expect(alphaAfterDelete.items[0]?.sessionId).toBe("legacy-sess-a");
      expect(alphaAfterDelete.items[0]?.version).toBe(2);
    } finally {
      await runtime.close();
      if (prevHome === undefined) delete process.env.NOCTURNE_HOME;
      else process.env.NOCTURNE_HOME = prevHome;
    }
  });

  it("跨会话历史面板页面附件不再对模型的 read 工具自动免确认放行", async () => {
    const root = makeTmp("nct-page-perm-");
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const { repoDir, wtDir } = makeGitRepoWithWorktree(root);

    const attachDir = path.join(sessionsDir, "attachments", "legacy-alpha");
    mkdirSync(attachDir, { recursive: true });
    const alphaPanelPath = path.join(attachDir, "file-1.html");
    writeFileSync(alphaPanelPath, "<p>PANEL_HTML</p>", "utf8");
    const legacyEvents: DurableEvent[] = [
      {
        type: "session.created",
        sessionId: "legacy-alpha",
        seq: 1,
        time: "2026-11-23T10:00:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.68.0",
          cwd: repoDir,
          workspaceRoot: repoDir,
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
        },
      },
      {
        type: "tool.completed",
        sessionId: "legacy-alpha",
        seq: 2,
        turnId: "t1",
        time: "2026-11-23T10:00:01.000Z",
        payload: {
          callId: "p1",
          name: "render_html",
          status: "ok",
          modelContent: "ok",
          durationMs: 5,
          files: [
            {
              type: "file",
              file: "file-1.html",
              sha256: "a".repeat(64),
              bytes: 17,
              mimeType: "text/html",
              label: "面板页.html",
              source: "upload",
              inline: { title: "面板页", page: "page-1", version: 1, display: "panel" },
            },
          ],
        },
      },
    ];
    writeFileSync(
      path.join(sessionsDir, "legacy-alpha.jsonl"),
      `${legacyEvents.map((e) => encodeDurableEvent(e)).join("\n")}\n`,
      "utf8",
    );

    let called = false;
    const provider = new FakeProvider({
      handler: () => {
        if (!called) {
          called = true;
          return [
            {
              type: "tool_call",
              toolCallId: "r1",
              name: "read",
              input: { path: alphaPanelPath },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const prevHome = process.env.NOCTURNE_HOME;
    process.env.NOCTURNE_HOME = home;
    const runtime = await createRuntime({
      cwd: repoDir,
      workspaceRoot: repoDir,
      sessionsDir,
      providers: [provider],
    });

    try {
      const sessReader = await runtime.createSession({
        model: "fake/fake-model",
        cwd: wtDir,
        workspaceRoot: wtDir,
        permissionPreset: "default",
        interactive: false,
      });
      const events: RuntimeEvent[] = [];
      sessReader.subscribe((ev) => events.push(ev));
      await sessReader.submit({ text: "read alpha panel" });
      const completed = events
        .filter((e) => e.type === "tool.completed" && e.payload.name === "read")
        .at(-1);
      expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
      await sessReader.close();
    } finally {
      await runtime.close();
      if (prevHome === undefined) delete process.env.NOCTURNE_HOME;
      else process.env.NOCTURNE_HOME = prevHome;
    }
  });

  it("render_html 仅保留主会话内嵌图表说明，不再指引 list_pages 或面板", () => {
    expect(renderHtmlTool.traits.mainSessionOnly).toBe(true);
    expect(renderHtmlTool.description).not.toContain("list_pages");
    expect(renderHtmlTool.description).not.toContain("/cadenza");
  });
});
