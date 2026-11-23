/**
 * 手机端顶层会话免唤醒只读观察与按需升级（ADR-0099）：
 * - openHere=false 走 session.observe，不调 resumeSession，可只读看附件，切走不发 session.close；
 * - openHere=true 直接走 resumeSession + 订阅；
 * - 旧后台无 session.observe（-32601 / method_not_found）自动降级并记忆；
 * - 交互操作（submit / respondPermission 等）触发按 afterSeq 无损升级，并发合并，不重复不丢事件；
 * - 列表刷新变为 openHere=true 时 track 自动按 afterSeq 升级；
 * - SessionScreen 在只读观察态挂载时不触发 listGrants / state / describeSkills 唤醒会话。
 */
import { act } from "react";
import { fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableEvent, RuntimeEvent } from "@nocturne/core/protocol";
import {
  createMemoryTransportPair,
  createRpcClient,
  RpcError,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import { createAttachmentImageSource } from "../src/attachment-images";
import { SessionScreen } from "../src/web/SessionScreen";
import { PhoneSessions } from "../src/web/sessions";

const iso = (seq: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, seq)).toISOString();

function makeDurableEvents(id: string): DurableEvent[] {
  return [
    {
      type: "session.created",
      sessionId: id,
      seq: 1,
      time: iso(1),
      payload: {
        formatVersion: 1,
        nocturneVersion: "0.0.0",
        cwd: "Z:/work",
        workspaceRoot: "Z:/work",
        model: { provider: "fake", model: "fake-1" },
        permissionPreset: "default",
      },
    } as DurableEvent,
    {
      type: "turn.started",
      sessionId: id,
      seq: 2,
      turnId: "t1",
      time: iso(2),
      payload: { turnIndex: 1 },
    } as DurableEvent,
    {
      type: "message.user",
      sessionId: id,
      seq: 3,
      turnId: "t1",
      time: iso(3),
      payload: { messageId: "m1", content: [{ type: "text", text: "历史提问" }] },
    } as DurableEvent,
    {
      type: "message.assistant",
      sessionId: id,
      seq: 4,
      turnId: "t1",
      time: iso(4),
      payload: {
        messageId: "a1",
        model: { provider: "fake", model: "fake-1" },
        content: [{ type: "text", text: "历史回答" }],
        toolCalls: [],
        finishReason: "stop",
      },
    } as DurableEvent,
    {
      type: "turn.completed",
      sessionId: id,
      seq: 5,
      turnId: "t1",
      time: iso(5),
      payload: { reason: "done", steps: 1, usage: { inputTokens: 10, outputTokens: 5 } },
    } as DurableEvent,
  ];
}

function makeHarness(options?: {
  list?: { id: string; openHere?: boolean; locked?: boolean }[];
  extraAfterUpgrade?: DurableEvent[];
  observeUnsupported?: boolean;
}) {
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "phone-observe-test" });
  const subscribedAfterSeqs: (number | undefined)[] = [];
  const liveListeners = new Map<string, (event: RuntimeEvent) => void>();
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  const submits = new Map<string, ReturnType<typeof vi.fn>>();
  const sessionCalls: string[] = [];

  let currentList = (options?.list ?? [{ id: "hist", openHere: false, locked: false }]).map(
    (item) => ({
      id: item.id,
      createdAt: iso(1),
      model: { provider: "fake", model: "fake-1" },
      cwd: "Z:/work",
      workspaceRoot: "Z:/work",
      mtimeMs: 1000,
      locked: item.locked ?? false,
      ...(item.openHere !== undefined ? { openHere: item.openHere } : {}),
      firstText: "历史提问",
    }),
  );

  vi.spyOn(client.runtime, "listSessions").mockImplementation(async () => currentList);
  vi.spyOn(client.runtime, "listModels").mockResolvedValue([]);
  vi.spyOn(client.runtime, "listRecentModels").mockResolvedValue([]);

  const observeSpy = vi
    .spyOn(client.runtime, "observeSession")
    .mockImplementation(async (input, observer) => {
      if (options?.observeUnsupported) {
        throw new RpcError("method_not_found", "Method not found", -32601);
      }
      const events = makeDurableEvents(input.sessionId);
      const after = input.afterSeq ?? 0;
      for (const e of events) {
        if (e.seq > after) observer.onEvent(e);
      }
      return {
        sessionId: input.sessionId,
        lastSeq: events.at(-1)?.seq ?? 0,
        cwd: "Z:/work",
        workspaceRoot: "Z:/work",
        openHere: false,
        tailIgnored: false,
      };
    });

  const readAttachmentSpy = vi.spyOn(client.runtime, "readSessionAttachment").mockResolvedValue({
    data: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    bytes: 3,
  });

  const resumeSpy = vi.spyOn(client.runtime, "resumeSession").mockImplementation(async (id) => {
    const close = vi.fn(async () => undefined);
    const submit = vi.fn(async () => "done" as const);
    closes.set(id, close);
    submits.set(id, submit);
    const real = {
      id,
      close,
      submit,
      turnChanges: async () => {
        sessionCalls.push("turnChanges");
        return [];
      },
      pendingInputs: async () => ({ items: [], paused: false }),
      shellInfo: async () => {
        sessionCalls.push("shellInfo");
        return { selected: "pwsh", effective: { kind: "pwsh", path: "pwsh" } };
      },
      state: async () => {
        sessionCalls.push("state");
        return { config: { model: { provider: "fake", model: "fake-1" } } };
      },
      reasoningEffortInfo: async () => {
        sessionCalls.push("reasoningEffortInfo");
        return { available: [] };
      },
      listGrants: async () => {
        sessionCalls.push("listGrants");
        return [];
      },
      describeSkills: async () => {
        sessionCalls.push("describeSkills");
        return { skills: [] };
      },
      describeExternalAgents: async () => {
        sessionCalls.push("describeExternalAgents");
        return { agents: [] };
      },
      setModel: async () => {
        sessionCalls.push("setModel");
      },
      respondPermission: async () => {
        sessionCalls.push("respondPermission");
      },
      subscribe: async (
        listener: (event: RuntimeEvent) => void,
        opts?: { afterSeq?: number | undefined },
      ) => {
        subscribedAfterSeqs.push(opts?.afterSeq);
        liveListeners.set(id, listener);
        const all = [...makeDurableEvents(id), ...(options?.extraAfterUpgrade ?? [])];
        const after = opts?.afterSeq ?? 0;
        for (const e of all) {
          if (e.seq > after) listener(e);
        }
        return { lastSeq: all.at(-1)?.seq ?? after, unsubscribe: vi.fn() };
      },
    } as unknown as RpcSession;
    return {
      session: real,
      opened: { sessionId: id, warnings: [], meta: { cwd: "Z:/work" } } as unknown as SessionOpened,
    };
  });

  const changed = vi.fn();
  const sessions = new PhoneSessions(changed);
  return {
    client,
    sessions,
    observeSpy,
    readAttachmentSpy,
    resumeSpy,
    subscribedAfterSeqs,
    liveListeners,
    closes,
    submits,
    sessionCalls,
    setList(next: typeof currentList) {
      currentList = next;
    },
  };
}

let root: Root | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PhoneSessions 顶层会话只读观察与按需升级（ADR-0099）", () => {
  it("openHere=false 走只读观察不调 resumeSession，支持读附件，切走不发 session.close", async () => {
    const h = makeHarness();
    await h.sessions.connected(h.client);
    const entry = await h.sessions.open("hist");

    expect(entry.observed).toBe(true);
    expect(entry.view.lastSeq).toBe(5);
    expect(entry.view.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(h.observeSpy).toHaveBeenCalledTimes(1);
    expect(h.resumeSpy).not.toHaveBeenCalled();

    // 读取附件经 runtime.readSessionAttachment，不触发 resumeSession
    const att = await entry.session.readAttachment("abc.png");
    expect(att.bytes).toBe(3);
    expect(h.readAttachmentSpy).toHaveBeenCalledWith({ sessionId: "hist", file: "abc.png" });
    expect(h.resumeSpy).not.toHaveBeenCalled();

    // 切走后直接本地清理，不调用 session.close
    h.sessions.setSelected(undefined);
    await vi.waitFor(() => expect(h.sessions.opened.has("hist")).toBe(false));
    expect(h.closes.size).toBe(0);
    expect(h.resumeSpy).not.toHaveBeenCalled();
  });

  it("openHere=true 的运行中会话直接走 resumeSession + 订阅", async () => {
    const h = makeHarness({ list: [{ id: "live", openHere: true, locked: true }] });
    await h.sessions.connected(h.client);
    // connected -> fetchList -> track 会自动打开 openHere=true 的会话
    await vi.waitFor(() => expect(h.resumeSpy).toHaveBeenCalledWith("live"));
    expect(h.observeSpy).not.toHaveBeenCalled();
  });

  it("旧后台不支持 session.observe（-32601）时自动退回 resumeSession 并记忆", async () => {
    const h = makeHarness({
      list: [
        { id: "old1", openHere: false },
        { id: "old2", openHere: false },
      ],
      observeUnsupported: true,
    });
    await h.sessions.connected(h.client);

    const e1 = await h.sessions.open("old1");
    expect(e1.observed).not.toBe(true);
    expect(h.observeSpy).toHaveBeenCalledTimes(1);
    expect(h.resumeSpy).toHaveBeenCalledTimes(1);

    // 第二个会话不再重复试探 session.observe
    const e2 = await h.sessions.open("old2");
    expect(e2.observed).not.toBe(true);
    expect(h.observeSpy).toHaveBeenCalledTimes(1);
    expect(h.resumeSpy).toHaveBeenCalledTimes(2);
  });

  it("交互触发升级：用 afterSeq 续接不重复不丢事件，并发操作合并为同一次 resumeSession", async () => {
    const extra: DurableEvent[] = [
      {
        type: "turn.started",
        sessionId: "hist",
        seq: 6,
        turnId: "t2",
        time: iso(6),
        payload: { turnIndex: 2 },
      } as DurableEvent,
      {
        type: "message.user",
        sessionId: "hist",
        seq: 7,
        turnId: "t2",
        time: iso(7),
        payload: { messageId: "m2", content: [{ type: "text", text: "电脑新增的消息" }] },
      } as DurableEvent,
    ];
    const h = makeHarness({ extraAfterUpgrade: extra });
    await h.sessions.connected(h.client);
    const entry = await h.sessions.open("hist");
    expect(entry.observed).toBe(true);
    expect(entry.view.lastSeq).toBe(5);

    // 并发调用 setModel 与 submit：应当只触发一次 resumeSession，并带 afterSeq=5 续接
    await Promise.all([
      entry.session.setModel("fake/fake-1"),
      entry.session.submit({ text: "手机新发" }),
    ]);

    expect(h.resumeSpy).toHaveBeenCalledTimes(1);
    expect(h.subscribedAfterSeqs).toEqual([5]);
    expect(entry.observed).toBe(false);
    // 电脑期间新增的 seq 6..7 完整接上，原有 1..5 不重复
    expect(entry.view.lastSeq).toBe(7);
    expect(entry.view.entries.filter((e) => e.kind === "user")).toHaveLength(2);
    expect(h.submits.get("hist")).toHaveBeenCalledWith({ text: "手机新发" });
  });

  it("列表刷新发现会话在后台变为 openHere=true 时自动按 afterSeq 升级", async () => {
    const h = makeHarness({ list: [{ id: "hist", openHere: false }] });
    await h.sessions.connected(h.client);
    const entry = await h.sessions.open("hist");
    expect(entry.observed).toBe(true);
    expect(h.resumeSpy).not.toHaveBeenCalled();

    // 模拟电脑端打开了同一会话
    h.setList([
      {
        id: "hist",
        createdAt: iso(1),
        model: { provider: "fake", model: "fake-1" },
        cwd: "Z:/work",
        workspaceRoot: "Z:/work",
        mtimeMs: 2000,
        locked: true,
        openHere: true,
        firstText: "历史提问",
      },
    ]);
    await h.sessions.refresh();
    await vi.waitFor(() => expect(entry.observed).toBe(false));
    expect(h.resumeSpy).toHaveBeenCalledTimes(1);
    expect(h.subscribedAfterSeqs).toEqual([5]);
  });

  it("SessionScreen 在只读观察态通过工作区查询技能并显示在斜杠菜单，不唤醒会话", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const h = makeHarness({ list: [{ id: "hist", openHere: false }] });
    const describeWorkspaceSkills = vi.spyOn(h.client.runtime, "describeSkills").mockResolvedValue({
      skills: [
        {
          name: "layout-check",
          description: "检查手机布局",
          enabled: true,
          invocation: "both",
          fields: {},
        },
      ],
    } as Awaited<ReturnType<typeof h.client.runtime.describeSkills>>);
    await h.sessions.connected(h.client);
    const entry = await h.sessions.open("hist");
    const images = createAttachmentImageSource();
    const container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;

    await act(async () => {
      mounted.render(
        <SessionScreen
          entry={entry}
          sessions={h.sessions}
          connected
          images={images}
          openUrl={vi.fn()}
          onError={vi.fn()}
          onChanged={vi.fn()}
          onForked={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("历史提问");
      expect(container.textContent).toContain("历史回答");
    });
    const field = container.querySelector("textarea");
    if (!field) throw new Error("缺少输入框");
    act(() => fireEvent.change(field, { target: { value: "/" } }));
    expect(container.querySelector(".phone-slash")?.textContent).toContain("/layout-check");
    expect(describeWorkspaceSkills).toHaveBeenCalledWith({ workspaceRoot: "Z:/work" });
    expect(entry.observed).toBe(true);
    expect(h.resumeSpy).not.toHaveBeenCalled();
    expect(h.sessionCalls).toEqual([]);
    images.dispose();
  });
});
