import { execFileSync } from "node:child_process";
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
import { listPagesTool, renderHtmlTool } from "../src/tools/index.js";

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

  it("页面库查询、list_pages、render_html 跨会话接着改（含数据复制与错误 ref）、归档/回退/删除与旁路缓存", async () => {
    const root = makeTmp("nct-page-lib-");
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions");
    const defaultWs = path.join(home, "workspace");
    const otherRepo = path.join(root, "repo-beta");
    mkdirSync(defaultWs, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    const { repoDir, wtDir } = makeGitRepoWithWorktree(root);

    let mode:
      | "a_init"
      | "a_update"
      | "b_wt"
      | "other_proj"
      | "default_ws"
      | "c_list_and_edit"
      | "c_bad_ref"
      | "subagent" = "a_init";
    let refForC = "";
    let otherRef = "";
    let listPagesText = "";
    let badRefError = "";

    const provider = new FakeProvider({
      handler: (req) => {
        let lastUserIdx = -1;
        for (let i = req.messages.length - 1; i >= 0; i--) {
          if (req.messages[i]?.role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        const turnTools = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool");
        const lastTool = turnTools.at(-1);
        if (mode === "a_init") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "a1",
                name: "render_html",
                input: {
                  title: "订单看板",
                  display: "panel",
                  html: "<!doctype html><html><body><h1>订单看板 v1</h1><p>OLD_TEXT</p></body></html>",
                },
              },
              {
                type: "tool_call",
                toolCallId: "a2",
                name: "render_html",
                input: {
                  title: "随文小图",
                  display: "inline",
                  html: "<!doctype html><html><body><p>inline only</p></body></html>",
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "A done" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (mode === "a_update") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "a3",
                name: "render_html",
                input: {
                  page: "page-1",
                  edits: [{ old: "订单看板 v1", new: "订单看板 v2" }],
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "A v2 done" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (mode === "b_wt") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "b1",
                name: "render_html",
                input: {
                  title: "工作树性能图",
                  display: "panel",
                  html: "<!doctype html><html><body><h1>WT Chart</h1></body></html>",
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "B done" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (mode === "other_proj") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "o1",
                name: "render_html",
                input: {
                  title: "Beta 专属页",
                  display: "panel",
                  html: "<!doctype html><html><body><h1>Beta</h1></body></html>",
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "Other done" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (mode === "default_ws") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "d1",
                name: "render_html",
                input: {
                  title: "日常对话页",
                  display: "panel",
                  html: "<!doctype html><html><body><h1>Chat Page</h1></body></html>",
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "Default done" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (mode === "c_list_and_edit") {
          if (turnTools.length === 0) {
            expect(req.tools.some((t) => t.name === "list_pages")).toBe(true);
            return [
              { type: "tool_call", toolCallId: "c1", name: "list_pages", input: {} },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (turnTools.length === 1) {
            listPagesText = String(turnTools[0]?.content ?? "");
            return [
              {
                type: "tool_call",
                toolCallId: "c2",
                name: "render_html",
                input: {
                  page: refForC,
                  title: "订单看板（C 改版）",
                  edits: [{ old: "OLD_TEXT", new: "NEW_FROM_C" }],
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "C edited" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (mode === "c_bad_ref") {
          if (turnTools.length === 0) {
            return [
              {
                type: "tool_call",
                toolCallId: "c3",
                name: "render_html",
                input: {
                  page: otherRef,
                  html: "<p>should fail</p>",
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          badRefError = String(turnTools[0]?.content ?? "");
          return [
            { type: "text_delta", text: "handled bad ref" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          { type: "text_delta", text: "ok" },
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
      // 会话 A（主仓库）：创建面板页 page-1（v1 -> v2）+ 内嵌页 page-2，并写入页面数据
      const sessA = await runtime.createSession({
        model: "fake/fake-model",
        cwd: repoDir,
        workspaceRoot: repoDir,
        permissionPreset: "read-only",
      });
      await runtime.renameSession(sessA.id, "会话A-主仓");
      mode = "a_init";
      await sessA.submit({ text: "生成面板与内嵌页" });
      mode = "a_update";
      await sessA.submit({ text: "更新到 v2" });
      await sessA.setPageData("page-1", "filter", { region: "east" });
      await sessA.close();

      // 会话 B（工作树）：创建面板页，并归档它（页面库仍应包含已归档会话）
      const sessB = await runtime.createSession({
        model: "fake/fake-model",
        cwd: wtDir,
        workspaceRoot: wtDir,
        permissionPreset: "default",
      });
      await runtime.renameSession(sessB.id, "会话B-工作树");
      mode = "b_wt";
      await sessB.submit({ text: "工作树页面" });
      await sessB.close();
      await runtime.archiveSession(sessB.id);

      // 会话 Other（另一项目）
      const sessOther = await runtime.createSession({
        model: "fake/fake-model",
        cwd: otherRepo,
        workspaceRoot: otherRepo,
        permissionPreset: "default",
      });
      await runtime.renameSession(sessOther.id, "其他项目会话");
      mode = "other_proj";
      await sessOther.submit({ text: "Beta 页" });
      await sessOther.close();

      // 默认工作区会话（「对话」项目）
      const sessDef = await runtime.createSession({
        model: "fake/fake-model",
        cwd: defaultWs,
        workspaceRoot: defaultWs,
        permissionPreset: "default",
      });
      await runtime.renameSession(sessDef.id, "普通对话会话");
      mode = "default_ws";
      await sessDef.submit({ text: "对话页" });
      await sessDef.close();

      // 子会话（带 parent）：即使日志里含面板页，页面库也必须排除
      const childEvents: DurableEvent[] = [
        {
          type: "session.created",
          sessionId: "child-sub-1",
          seq: 1,
          time: "2026-11-24T01:10:00.000Z",
          payload: {
            formatVersion: 1,
            nocturneVersion: "0.0.0-test",
            cwd: repoDir,
            workspaceRoot: repoDir,
            model: { provider: "fake", model: "fake-model" },
            permissionPreset: "default",
            parent: { sessionId: sessA.id, callId: "sub-call-1" },
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

      // 查询项目列表与 alpha 项目页面库
      const projectsRes = await runtime.listPageProjects({ workspaceRoot: wtDir });
      expect(projectsRes.currentProjectName).toBe("repo-alpha");
      expect(projectsRes.projects.map((p) => p.name)).toContain("repo-alpha");
      expect(projectsRes.projects.map((p) => p.name)).toContain("repo-beta");
      expect(projectsRes.projects.map((p) => p.name)).toContain("对话");

      const alphaBeforeC = await runtime.listPages({ workspaceRoot: wtDir });
      // A 的内嵌页不进页面库；A 的面板页与已归档的 B 的面板页同在 repo-alpha 下
      expect(alphaBeforeC.items).toHaveLength(2);
      const aItem = alphaBeforeC.items.find((i) => i.sessionId === sessA.id);
      const bItem = alphaBeforeC.items.find((i) => i.sessionId === sessB.id);
      expect(aItem?.title).toBe("订单看板");
      expect(aItem?.version).toBe(2);
      expect(bItem?.title).toBe("工作树性能图");
      expect(bItem?.sessionArchived).toBe(true);

      // 验证旁路缓存生成且损坏时能自动重建
      const cacheFileA = path.join(sessionsDir, `${sessA.id}.pages.json`);
      expect(existsSync(cacheFileA)).toBe(true);
      writeFileSync(cacheFileA, "{not valid json");
      const alphaAfterCorrupt = await runtime.listPages({ workspaceRoot: repoDir });
      expect(alphaAfterCorrupt.items).toHaveLength(2);
      expect(() => JSON.parse(readFileSync(cacheFileA, "utf8"))).not.toThrow();

      // 会话 C（主仓库）：调用 list_pages（read-only 下免确认），再跨会话接着改 A 的页面
      refForC = `${sessA.id}/page-1`;
      otherRef = `${sessOther.id}/page-1`;
      const sessC = await runtime.createSession({
        model: "fake/fake-model",
        cwd: repoDir,
        workspaceRoot: repoDir,
        permissionPreset: "read-only",
      });
      await runtime.renameSession(sessC.id, "会话C-接着改");
      const cEvents: RuntimeEvent[] = [];
      sessC.subscribe((ev) => cEvents.push(ev));

      mode = "c_list_and_edit";
      await sessC.submit({ text: "列出页面并修改 A 的订单看板" });

      // list_pages 与 render_html 均未触发权限确认
      expect(cEvents.some((e) => e.type === "permission.requested")).toBe(false);
      expect(listPagesText).toContain(`${sessA.id}/page-1`);
      expect(listPagesText).toContain(`${sessB.id}/page-1`);
      expect(listPagesText).not.toContain(sessOther.id);

      // C 新建 page-1，版本号接续为 v3，display=panel，edits 以 A 的 v2 为底稿，且复制了 A 的页面数据
      const cPage = sessC.state().pages.find((p) => p.page === "page-1");
      expect(cPage?.display).toBe("panel");
      expect(cPage?.title).toBe("订单看板（C 改版）");
      expect(cPage?.versions[0]?.version).toBe(3);
      expect(cPage?.origin).toEqual({ sessionId: sessA.id, page: "page-1" });
      const cHtmlFile = cPage?.versions[0]?.file.file;
      expect(cHtmlFile).toBeTruthy();
      if (!cHtmlFile) throw new Error("missing cHtmlFile");
      const cHtmlBytes = (await sessC.readAttachment(cHtmlFile)).data;
      const cHtmlText = new TextDecoder().decode(cHtmlBytes);
      expect(cHtmlText).toContain("订单看板 v2");
      expect(cHtmlText).toContain("NEW_FROM_C");
      expect(cHtmlText).not.toContain("OLD_TEXT");

      // 页面数据文件已复制到 C，之后两边互不影响
      expect(await sessC.getPageData("page-1", "filter")).toEqual({ region: "east" });
      await sessC.setPageData("page-1", "filter", { region: "west" });
      const sessAReopened = await runtime.resumeSession(sessA.id);
      expect(await sessAReopened.getPageData("page-1", "filter")).toEqual({ region: "east" });
      await sessAReopened.close();

      // 页面库按来源合并：A 与 C 合并为 1 行，取最近更新的 C（v3）
      const alphaAfterC = await runtime.listPages({ workspaceRoot: repoDir });
      expect(alphaAfterC.items).toHaveLength(2);
      const merged = alphaAfterC.items.find((i) => i.originKey === `${sessA.id}/page-1`);
      expect(merged?.sessionId).toBe(sessC.id);
      expect(merged?.sessionTitle).toBe("会话C-接着改");
      expect(merged?.version).toBe(3);

      // 指向其他项目的 ref 返回 invalid_input 并列出可用 ref
      mode = "c_bad_ref";
      await sessC.submit({ text: "试着改其他项目的页面" });
      expect(badRefError).toContain("不存在或不属于当前项目");
      expect(badRefError).toContain(`${sessC.id}/page-1`);

      // 回退 C 撤掉该页面：页面库退回显示 A 的 v2
      const firstUserSeq = sessC.state().history.find((h) => h.kind === "user")?.seq;
      expect(firstUserSeq).toBeDefined();
      if (firstUserSeq === undefined) throw new Error("missing firstUserSeq");
      await sessC.rewind(firstUserSeq, "conversation");
      const alphaAfterRewind = await runtime.listPages({ workspaceRoot: repoDir });
      const reverted = alphaAfterRewind.items.find((i) => i.originKey === `${sessA.id}/page-1`);
      expect(reverted?.sessionId).toBe(sessA.id);
      expect(reverted?.version).toBe(2);
      await sessC.close();

      // 删除 B 的会话文件：页面库不再残留 B
      rmSync(path.join(sessionsDir, `${sessB.id}.jsonl`), { force: true });
      const alphaAfterDelete = await runtime.listPages({ workspaceRoot: repoDir });
      expect(alphaAfterDelete.items.map((i) => i.sessionId)).toEqual([sessA.id]);
    } finally {
      await runtime.close();
      if (prevHome === undefined) delete process.env.NOCTURNE_HOME;
      else process.env.NOCTURNE_HOME = prevHome;
    }
  });

  it("读取放行：同项目其他会话面板页面 HTML 在 default 预设下 read 免确认，其他项目与内嵌页仍需确认", async () => {
    const root = makeTmp("nct-page-perm-");
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions");
    const otherRepo = path.join(root, "repo-other");
    mkdirSync(otherRepo, { recursive: true });
    const { repoDir, wtDir } = makeGitRepoWithWorktree(root);

    let stepMode: "create_alpha" | "create_other" | "read_file" = "create_alpha";
    let pathToRead = "";
    let readCallSeq = 0;

    const provider = new FakeProvider({
      handler: (req) => {
        let lastUserIdx = -1;
        for (let i = req.messages.length - 1; i >= 0; i--) {
          if (req.messages[i]?.role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        const lastTool = req.messages
          .slice(lastUserIdx + 1)
          .reverse()
          .find((m) => m.role === "tool");
        if (stepMode === "create_alpha") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "p1",
                name: "render_html",
                input: { title: "面板页", display: "panel", html: "<p>PANEL_HTML</p>" },
              },
              {
                type: "tool_call",
                toolCallId: "p2",
                name: "render_html",
                input: { title: "内嵌页", display: "inline", html: "<p>INLINE_HTML</p>" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "ok" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (stepMode === "create_other") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: "p3",
                name: "render_html",
                input: { title: "别项目面板页", display: "panel", html: "<p>OTHER_PANEL</p>" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "ok" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (stepMode === "read_file") {
          if (!lastTool) {
            return [
              {
                type: "tool_call",
                toolCallId: `r${++readCallSeq}`,
                name: "read",
                input: { path: pathToRead },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: String(lastTool.content) },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          { type: "text_delta", text: "ok" },
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
      const sessAlpha = await runtime.createSession({
        model: "fake/fake-model",
        cwd: repoDir,
        workspaceRoot: repoDir,
        permissionPreset: "default",
      });
      stepMode = "create_alpha";
      await sessAlpha.submit({ text: "create" });
      const alphaPanelFile = sessAlpha.state().pages.find((p) => p.display === "panel")?.versions[0]
        ?.file.file;
      const alphaInlineFile = sessAlpha.state().pages.find((p) => p.display === "inline")
        ?.versions[0]?.file.file;
      if (!alphaPanelFile || !alphaInlineFile) throw new Error("missing alpha page files");
      const alphaPanelPath = path.join(sessionsDir, "attachments", sessAlpha.id, alphaPanelFile);
      const alphaInlinePath = path.join(sessionsDir, "attachments", sessAlpha.id, alphaInlineFile);
      await sessAlpha.close();

      const sessOther = await runtime.createSession({
        model: "fake/fake-model",
        cwd: otherRepo,
        workspaceRoot: otherRepo,
        permissionPreset: "default",
      });
      stepMode = "create_other";
      await sessOther.submit({ text: "create other" });
      const otherPanelFile = sessOther.state().pages.find((p) => p.display === "panel")?.versions[0]
        ?.file.file;
      if (!otherPanelFile) throw new Error("missing otherPanelFile");
      const otherPanelPath = path.join(sessionsDir, "attachments", sessOther.id, otherPanelFile);
      await sessOther.close();

      // 在工作树（同项目）开一个非交互 default 会话：若需要确认会直接拒绝；免确认才会成功读取
      const sessReader = await runtime.createSession({
        model: "fake/fake-model",
        cwd: wtDir,
        workspaceRoot: wtDir,
        permissionPreset: "default",
        interactive: false,
      });
      const events: RuntimeEvent[] = [];
      sessReader.subscribe((ev) => events.push(ev));

      stepMode = "read_file";
      // 1. 同项目面板页面 HTML -> 免确认直接 ok
      pathToRead = alphaPanelPath;
      await sessReader.submit({ text: "read alpha panel" });
      const panelCompleted = events
        .filter((e) => e.type === "tool.completed" && e.payload.name === "read")
        .at(-1);
      expect(panelCompleted?.type === "tool.completed" && panelCompleted.payload.status).toBe("ok");
      expect(
        panelCompleted?.type === "tool.completed" ? panelCompleted.payload.modelContent : "",
      ).toContain("PANEL_HTML");

      // 2. 同项目内嵌页面 HTML -> 不放行（default 非交互拒绝）
      pathToRead = alphaInlinePath;
      await sessReader.submit({ text: "read alpha inline" });
      const inlineCompleted = events
        .filter((e) => e.type === "tool.completed" && e.payload.name === "read")
        .at(-1);
      expect(inlineCompleted?.type === "tool.completed" && inlineCompleted.payload.status).toBe(
        "denied",
      );

      // 3. 其他项目面板页面 HTML -> 不放行（default 非交互拒绝）
      pathToRead = otherPanelPath;
      await sessReader.submit({ text: "read other panel" });
      const otherCompleted = events
        .filter((e) => e.type === "tool.completed" && e.payload.name === "read")
        .at(-1);
      expect(otherCompleted?.type === "tool.completed" && otherCompleted.payload.status).toBe(
        "denied",
      );

      await sessReader.close();
    } finally {
      await runtime.close();
      if (prevHome === undefined) delete process.env.NOCTURNE_HOME;
      else process.env.NOCTURNE_HOME = prevHome;
    }
  });

  it("list_pages 与 render_html 具有一致的仅主会话特性与工具说明", () => {
    expect(listPagesTool.traits).toEqual({
      mutates: false,
      concurrencySafe: true,
      mainSessionOnly: true,
    });
    expect(renderHtmlTool.traits.mainSessionOnly).toBe(true);
    expect(renderHtmlTool.description).toContain("list_pages");
  });
});
