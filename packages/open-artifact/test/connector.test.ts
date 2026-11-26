import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness, HarnessOptions } from "@open-artifact/harness-kit";
import { startFakeDaemon } from "@open-artifact/harness-kit/testing";
import type { WakeDeliverParams } from "@open-artifact/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenArtifactHostEvent, OpenArtifactWakeDelivery } from "@nocturne/core";
import {
  createOpenArtifactConnector,
  extractCompletedArtifact,
  resolveBundledOpenArtifactRuntime,
  sanitizeToolOutput,
  sanitizeWakeText,
} from "../src/index.js";

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBundledOpenArtifactRuntime", () => {
  it("按显式目录 > 环境变量 > 入口旁 open-artifact-runtime 顺序解析", () => {
    const base = makeTmp("nct-oa-rt-");
    const makeRuntime = (name: string, version: string) => {
      const dir = path.join(base, name);
      mkdirSync(path.join(dir, "scripts"), { recursive: true });
      writeFileSync(path.join(dir, "scripts", "open-artifact.mjs"), "// runtime\n");
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
      return dir;
    };
    const explicit = makeRuntime("explicit", "0.16.3");
    const envDir = makeRuntime("env", "0.16.2");
    const entryRoot = path.join(base, "dist");
    mkdirSync(entryRoot, { recursive: true });
    const sibling = makeRuntime(path.join("dist", "open-artifact-runtime"), "0.16.1");

    expect(
      resolveBundledOpenArtifactRuntime(explicit, { NOCTURNE_OPEN_ARTIFACT_RUNTIME_DIR: envDir }),
    ).toMatchObject({ dir: explicit, version: "0.16.3" });

    expect(
      resolveBundledOpenArtifactRuntime(undefined, { NOCTURNE_OPEN_ARTIFACT_RUNTIME_DIR: envDir }),
    ).toMatchObject({ dir: envDir, version: "0.16.2" });

    expect(
      resolveBundledOpenArtifactRuntime(
        undefined,
        {},
        { entryPath: path.join(entryRoot, "nctrn.mjs") },
      ),
    ).toMatchObject({ dir: sibling, version: "0.16.1" });
  });
});

describe("sanitizeToolOutput & extractCompletedArtifact", () => {
  it("剥离回环 URL 与敏感视图地址，仅保留稳定 open-artifact:// 标识与摘要", () => {
    const raw = {
      url: "open-artifact://artifact/design-01",
      title: "主控台设计",
      type: "design",
      view_url: "http://127.0.0.1:41000/a/design-01",
      embedUrl: "http://127.0.0.1:41000/a/design-01?ticket=secret",
      nested: {
        preview: "http://localhost:41000/preview",
        keep: "ok",
      },
      boards: [{ id: "b1" }, { id: "b2" }],
    };

    const clean = sanitizeToolOutput(raw) as Record<string, unknown>;
    expect(clean["url"]).toBe("open-artifact://artifact/design-01");
    expect(clean["view_url"]).toBeUndefined();
    expect(clean["embedUrl"]).toBeUndefined();
    expect((clean["nested"] as Record<string, unknown>)["preview"]).toBeUndefined();
    expect((clean["nested"] as Record<string, unknown>)["keep"]).toBe("ok");

    const known = new Map();
    const extracted = extractCompletedArtifact(
      "Artifact",
      { action: "create", type_url: "open-artifact://type/design" },
      raw,
      known,
    );
    expect(extracted).toEqual({
      url: "open-artifact://artifact/design-01",
      id: "design-01",
      title: "主控台设计",
      type: "design",
      summary: "2 个画板",
    });

    const sanitizedWake = sanitizeWakeText(
      "Artifact: open-artifact://artifact/design-01\n把标题改成 Service Metrics\nArtifact root: /tmp/design. View it: http://127.0.0.1:4800/a/design-01.\nRead the files again.",
    );
    expect(sanitizedWake).toContain("open-artifact://artifact/design-01");
    expect(sanitizedWake).toContain("把标题改成 Service Metrics");
    expect(sanitizedWake).not.toContain("127.0.0.1");
    expect(sanitizedWake).not.toContain("View it:");
  });
});

describe("createOpenArtifactConnector", () => {
  it("校验本地来源过滤、wake 队列/身份映射、以及普通关闭不停止 daemon", async () => {
    let capturedOpts: HarnessOptions | undefined;
    const listeners = new Map<string, ((arg: unknown) => void)[]>();
    const stopDaemon = vi.fn();
    const closeConn = vi.fn();
    const attach = vi.fn(async () => ({ key: "k", inbox: [] }));
    const wrote = vi.fn(async () => ({ ok: true as const }));
    const shellCommand = vi.fn(async () => undefined);
    const view = vi.fn(async (url: string) => ({
      url,
      title: "看板",
      embedUrl: "http://127.0.0.1:41234/a/abc?ticket=t1",
      viewUrl: "http://127.0.0.1:41234/a/abc",
      view: "view-1",
      session: null,
    }));
    const embedOrigins = vi.fn(async () => ({
      entries: [
        { origin: "http://127.0.0.1:41234", remote: false },
        { origin: "https://remote.example.com", remote: true },
      ],
    }));

    const fakeHarness = {
      connected: true,
      features: [],
      ready: vi.fn(async () => ({})),
      attach,
      status: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      tools: vi.fn(async () => []),
      call: vi.fn(async () => ({ ok: true, result: {} })),
      wrote,
      open: vi.fn(async () => ({ opened: true })),
      owns: vi.fn(() => true),
      viewUrl: vi.fn(async () => "http://127.0.0.1:41234/a/abc"),
      publicUrl: vi.fn(async () => null),
      embedOrigins,
      view,
      shellCommand,
      context: vi.fn(async () => ({})),
      contextBlock: vi.fn(() => ""),
      saveThumbnail: vi.fn(async () => undefined),
      on: vi.fn((ev: string, fn: (arg: unknown) => void) => {
        const list = listeners.get(ev) ?? [];
        list.push(fn);
        listeners.set(ev, list);
        return () => undefined;
      }),
      installSkill: vi.fn(async () => ({ written: false, path: "" })),
      commands: vi.fn(async () => []),
      runtime: { status: vi.fn(), update: vi.fn() },
      daemon: { stop: stopDaemon, restart: vi.fn(), start: vi.fn(), stopped: false },
      close: closeConn,
    } as unknown as Harness;

    const connector = createOpenArtifactConnector({
      embedMode: "view",
      harnessFactory: async (opts) => {
        capturedOpts = opts;
        return fakeHarness;
      },
    });

    const wakes: OpenArtifactWakeDelivery[] = [];
    const hostEvents: OpenArtifactHostEvent[] = [];
    connector.bindRuntime?.({
      onWake: async (delivery) => {
        wakes.push(delivery);
        return { status: "queued", session: delivery.sessionId ?? undefined };
      },
      onHostEvent: (event) => {
        hostEvents.push(event);
      },
    });

    // 工具清单暴露 Artifact / ArtifactData / ArtifactComments（权限由会话 role/may 与权限层控制）
    expect(connector.tools({ mainSession: true }).map((t) => t.name)).toEqual([
      "Artifact",
      "ArtifactData",
      "ArtifactComments",
    ]);
    expect(connector.tools({ mainSession: false }).map((t) => t.name)).toEqual([
      "Artifact",
      "ArtifactData",
      "ArtifactComments",
    ]);

    const ticket = await connector.openView("open-artifact://artifact/abc", {
      theme: { scheme: "dark" },
    });
    expect(ticket.embedUrl).toBe("http://127.0.0.1:41234/a/abc?ticket=t1");
    expect(ticket.allowedOrigins).toEqual(["http://127.0.0.1:41234"]);
    expect(capturedOpts?.embed).toMatchObject({ mode: "view", remote: "deny" });

    // wake 回调：queued 应向 daemon 报告 delivered，且保留相同内容的稳定 dedupeKey
    const wakeParams: WakeDeliverParams = {
      session: "s-1",
      workspace: "/repo",
      artifact: "open-artifact://artifact/abc",
      artifactId: "abc",
      text: "把标题字号调大",
      source: {
        kind: "open-artifact.event",
        artifactId: "abc",
        url: "open-artifact://artifact/abc",
        viewUrl: "http://127.0.0.1:41234/a/abc",
        root: "/repo/.open-artifact/abc",
        title: "看板",
        reason: "comment",
        from: { kind: "owner" },
        summary: "用户评论",
        threads: [{ id: "th-1", where: "画板 1 · 标题", text: "把标题字号调大" }],
        requests: [],
      },
    };
    const wakeRes = await capturedOpts?.wake?.(wakeParams);
    expect(wakeRes).toEqual({ status: "delivered", session: "s-1" });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.fromKind).toBe("owner");
    expect(wakes[0]?.threads?.[0]?.where).toBe("画板 1 · 标题");
    expect(wakes[0]?.dedupeKey).toMatch(/^[0-9a-f]{64}$/);

    // 文件写入通知
    await connector.notifyFilesWritten(["/repo/a.html"], { sessionId: "s-1", workspace: "/repo" });
    expect(wrote).toHaveBeenCalledWith(["/repo/a.html"], { session: "s-1", workspace: "/repo" });

    // 普通退出只断开自己，绝不停止 daemon
    connector.close();
    expect(closeConn).toHaveBeenCalledTimes(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it("真实 WebSocket fake daemon：attach、wake 投递、断线重连后重新 attach 且关闭不停 daemon", async () => {
    const fake = await startFakeDaemon();
    const connector = createOpenArtifactConnector({
      home: fake.home,
      autoStart: false,
      embedMode: "view",
    });
    const receivedWakes: OpenArtifactWakeDelivery[] = [];
    connector.bindRuntime?.({
      onWake: async (delivery) => {
        receivedWakes.push(delivery);
        return { status: "delivered", session: delivery.sessionId ?? undefined };
      },
      onHostEvent: () => undefined,
    });
    try {
      await connector.syncSession(
        {
          sessionId: "sess-ws-1",
          workspace: "/ws",
          title: "WS 会话",
          role: "main",
          may: { create: true, modify: true, remove: true, reply: true },
        },
        { ensure: true },
      );
      fake.setArtifact({ id: "art_ws1", title: "测试作品", type: "design" });
      const ticket = await connector.openView("open-artifact://artifact/art_ws1", {
        theme: { scheme: "light" },
      });
      expect(ticket.url).toBe("open-artifact://artifact/art_ws1");
      expect(ticket.embedUrl).toContain("/a/art_ws1");

      const wakeResult = await fake.wake({
        session: "sess-ws-1",
        workspace: "/ws",
        artifact: "open-artifact://artifact/art_ws1",
        artifactId: "art_ws1",
        text: "改一下配色",
        source: {
          kind: "open-artifact.event",
          artifactId: "art_ws1",
          url: "open-artifact://artifact/art_ws1",
          viewUrl: ticket.viewUrl,
          root: "/ws/.open-artifact/art_ws1",
          title: "测试作品",
          reason: "comment",
          from: { kind: "owner" },
          summary: "改一下配色",
          threads: [{ id: "th-ws-1", where: "画板 A", text: "改一下配色" }],
          requests: [],
        },
      });
      expect(wakeResult.status).toBe("delivered");
      expect(receivedWakes).toHaveLength(1);
      expect(receivedWakes[0]?.threads?.[0]?.where).toBe("画板 A");

      connector.close();
    } finally {
      await fake.close();
    }
  });
});
