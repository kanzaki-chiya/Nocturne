import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntime,
  FakeProvider,
  parseWorkModeSlash,
  type OpenArtifactConnector,
  type OpenArtifactHostEvent,
  type OpenArtifactSessionAccess,
  type OpenArtifactWakeDelivery,
  type OpenArtifactWakeResult,
  type ToolDefinition,
} from "../src/index.js";

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStubConnector() {
  const synced: OpenArtifactSessionAccess[] = [];
  const written: { paths: readonly string[]; sessionId: string; workspace: string }[] = [];
  const statuses: { sessionId: string; status: "running" | "idle" }[] = [];
  let onWake: ((wake: OpenArtifactWakeDelivery) => Promise<OpenArtifactWakeResult>) | undefined;
  let onHostEvent: ((event: OpenArtifactHostEvent) => void) | undefined;
  const closed = vi.fn();

  const artifactTool: ToolDefinition = {
    name: "Artifact",
    description: "Create or update Open Artifact",
    inputSchema: { type: "object", properties: { action: { type: "string" } } },
    traits: { mutates: true, concurrencySafe: false, suppressFilesWrittenNotify: true },
    permissionSubjects: () => [],
    execute: async () => ({
      status: "ok",
      modelContent: "created",
      output: { url: "open-artifact://artifact/design-1", title: "双方案设计", type: "design" },
      artifact: {
        url: "open-artifact://artifact/design-1",
        id: "design-1",
        title: "双方案设计",
        type: "design",
        summary: "2 个画板",
      },
    }),
  };

  const artifactDataTool: ToolDefinition = {
    name: "ArtifactData",
    description: "Update Open Artifact store",
    inputSchema: { type: "object", properties: { action: { type: "string" } } },
    traits: { mutates: true, concurrencySafe: false, suppressFilesWrittenNotify: true },
    permissionSubjects: (_input, scope) => [{ kind: "edit", target: scope.workspaceRoot }],
    execute: async () => ({
      status: "ok",
      modelContent: "updated",
    }),
  };

  const connector: OpenArtifactConnector = {
    tools: () => [artifactTool, artifactDataTool],
    bindRuntime: (handlers) => {
      onWake = handlers.onWake;
      onHostEvent = handlers.onHostEvent;
    },
    syncSession: async (access) => {
      synced.push(access);
    },
    setSessionStatus: async (sessionId, _ws, status) => {
      statuses.push({ sessionId, status });
    },
    renameSession: async () => undefined,
    detachSession: async () => undefined,
    notifyFilesWritten: async (paths, caller) => {
      written.push({ paths, ...caller });
    },
    readSelectionContext: async () => undefined,
    openView: async (url) => ({
      url,
      id: "design-1",
      title: "双方案设计",
      type: "design",
      embedUrl: "http://127.0.0.1:41234/a/design-1?ticket=t1",
      viewUrl: "http://127.0.0.1:41234/a/design-1",
      view: "v1",
      allowedOrigins: ["http://127.0.0.1:41234"],
    }),
    resolveLocalUrl: async (url) => ({
      url,
      viewUrl: "http://127.0.0.1:41234/a/design-1",
      title: "双方案设计",
      type: "design",
    }),
    getEmbedOrigins: async () => ["http://127.0.0.1:41234"],
    setTheme: async () => undefined,
    closeView: () => undefined,
    close: closed,
  };

  return {
    connector,
    synced,
    written,
    statuses,
    closed,
    triggerWake: (wake: OpenArtifactWakeDelivery) => {
      if (!onWake) throw new Error("onWake not bound");
      return onWake(wake);
    },
    emitHost: (ev: OpenArtifactHostEvent) => onHostEvent?.(ev),
  };
}

describe("Core Runtime Open Artifact integration (ADR-0125)", () => {
  it("支持 /artifact 斜杠命令解析、权限同步、作品持久化同库、文件写入通知与评论唤醒去重/隔离", async () => {
    expect(parseWorkModeSlash("/artifact 做一份双方案设计")).toEqual({
      kind: "submit",
      workMode: "artifact",
      text: "做一份双方案设计",
    });

    const cwd = makeTmp("nct-oa-core-ws-");
    const home = makeTmp("nct-oa-core-home-");
    const sessionsDir = path.join(home, "sessions");
    writeFileSync(path.join(cwd, "note.txt"), "hello\n");

    let step = 0;
    const provider = new FakeProvider({
      handler: () => {
        if (step === 0) {
          step++;
          return [
            { type: "tool_call", toolCallId: "c1", name: "Artifact", input: { action: "create" } },
            {
              type: "tool_call",
              toolCallId: "c1b",
              name: "ArtifactData",
              input: { action: "set" },
            },
            {
              type: "tool_call",
              toolCallId: "c2",
              name: "write",
              input: { path: path.join(cwd, "out.txt"), content: "v1" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 1) {
          step++;
          return [
            { type: "text_delta", text: "已创建双方案设计。" },
            { type: "finish", reason: "stop" },
          ];
        }
        step++;
        return [
          { type: "text_delta", text: "已按画板评论更新。" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const stub = makeStubConnector();
    const runtime = await createRuntime({
      cwd,
      workspaceRoot: cwd,
      sessionsDir,
      providers: [provider],
      openArtifact: stub.connector,
      interactive: false,
    });

    const hostEvents: OpenArtifactHostEvent[] = [];
    runtime.onOpenArtifactEvent((ev) => hostEvents.push(ev));

    try {
      const session = await runtime.createSession({
        model: "fake/fake-model",
        permissionPreset: "auto-edit",
      });

      // 切换权限预设应同步到 Open Artifact 会话权限
      await session.setPermissionPreset("read-only");
      expect(stub.synced.at(-1)?.may).toEqual({
        create: false,
        modify: false,
        remove: false,
        reply: false,
      });
      await session.setPermissionPreset("auto-edit");
      expect(stub.synced.at(-1)?.may.create).toBe(true);

      // 提交 /artifact 任务
      await session.submit({ text: "做一份双方案设计", workMode: "artifact" });

      // 验证 notifyFilesWritten 收到了 write 工具写入的真实路径，但未把 ArtifactData 的 workspaceRoot 误报为文件写入，
      // 且未对目录作用域 edit 权限主体写入 checkpoint 警告（如「不是普通文件」）
      expect(stub.written).toEqual([
        {
          sessionId: session.id,
          workspace: cwd,
          paths: [path.join(cwd, "out.txt")],
        },
      ]);
      const dirCheckpoints = session
        .durableEvents()
        .filter((ev) => ev.type === "checkpoint.file" && ev.payload.path === cwd);
      expect(dirCheckpoints).toEqual([]);

      // 页面库应列出新 Open Artifact 作品并携带稳定 open-artifact:// 标识
      const lib = await runtime.listPages({ workspaceRoot: cwd });
      const artifactItem = lib.items.find((item) => item.kind === "artifact");
      expect(artifactItem).toMatchObject({
        kind: "artifact",
        ref: "open-artifact://artifact/design-1",
        title: "双方案设计",
        sessionId: session.id,
        artifact: {
          id: "design-1",
          type: "design",
          url: "open-artifact://artifact/design-1",
        },
      });

      // 非所有者评论（collaborator）不唤醒模型，而是发 notice 宿主事件
      const collabResult = await stub.triggerWake({
        sessionId: session.id,
        workspace: cwd,
        artifactUrl: "open-artifact://artifact/design-1",
        artifactId: "design-1",
        title: "双方案设计",
        text: "外部审阅意见",
        reason: "comment",
        fromKind: "collaborator",
        fromName: "Alice",
        summary: "外部审阅意见",
        dedupeKey: "dedupe-collab-1",
      });
      expect(collabResult.status).toBe("delivered");
      expect(hostEvents.some((e) => e.kind === "notice" && e.fromKind === "collaborator")).toBe(
        true,
      );

      // 所有者评论唤醒归属会话；重复投递按 dedupeKey 去重
      const ownerWake: OpenArtifactWakeDelivery = {
        sessionId: session.id,
        workspace: cwd,
        artifactUrl: "open-artifact://artifact/design-1",
        artifactId: "design-1",
        title: "双方案设计",
        text: "把画板 1 按钮改主色",
        reason: "comment",
        fromKind: "owner",
        summary: "把画板 1 按钮改主色",
        threads: [{ id: "t-1", where: "画板 1", text: "把画板 1 按钮改主色" }],
        dedupeKey: "dedupe-owner-1",
      };
      const wake1 = await stub.triggerWake(ownerWake);
      expect(["resumed", "delivered", "queued"]).toContain(wake1.status);

      // 相同 dedupeKey 再次重连补投不会二次提交
      const wakeDup = await stub.triggerWake(ownerWake);
      expect(wakeDup.status).toBe("delivered");

      // 关闭会话后收到新评论：Core 自动从磁盘恢复并投递，且客户端随后 resumeSession 直接交接不报 session_locked
      const closedId = session.id;
      await session.close();
      const wakeAfterClose = await stub.triggerWake({
        ...ownerWake,
        text: "关闭后追加的评论",
        summary: "关闭后追加的评论",
        dedupeKey: "dedupe-owner-after-close",
      });
      expect(wakeAfterClose.status).toBe("resumed");
      const resumed = await runtime.resumeSession(closedId);
      expect(resumed.id).toBe(closedId);
      await resumed.close();
    } finally {
      await runtime.close();
      expect(stub.closed).toHaveBeenCalledTimes(1);
    }
  });
});
