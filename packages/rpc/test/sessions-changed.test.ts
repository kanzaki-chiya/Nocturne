import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@nocturne/core";
import type { RpcClient } from "@nocturne/rpc/client";
import { cleanupTmp, connectMany, MODEL, textScript, until, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);

const WINDOW_MS = 300;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 统计某条连接收到的 runtime.sessionsChanged，并核对通知不带任何内容 */
function countSessionsChanged(client: RpcClient): { count: () => number } {
  let count = 0;
  client.onNotification("runtime.sessionsChanged", (params) => {
    expect(params).toEqual({});
    count += 1;
  });
  return { count: () => count };
}

describe("runtime.sessionsChanged", () => {
  it("创建会话成功后本机与远程连接各收到一条，不带内容", async () => {
    const h = await connectMany();
    const remote = await h.add();
    const local = countSessionsChanged(h.client);
    const phone = countSessionsChanged(remote.client);
    await remote.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    await until(() => local.count() > 0 && phone.count() > 0, "创建会话的通知");
    await sleep(WINDOW_MS + 100);
    expect([local.count(), phone.count()]).toEqual([1, 1]);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("分叉会话成功后推送一次", async () => {
    const h = await connectMany({ scripts: [textScript("好")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "你好" });
    await sleep(WINDOW_MS + 100);
    const remote = await h.add();
    const phone = countSessionsChanged(remote.client);
    await remote.client.runtime.forkSession(session.id);
    await until(() => phone.count() > 0, "分叉的通知");
    await sleep(WINDOW_MS + 100);
    expect(phone.count()).toBe(1);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("首条用户消息落盘后推送，后续消息不再推送", async () => {
    const h = await connectMany({ scripts: [textScript("一"), textScript("二")] });
    const remote = await h.add();
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await sleep(WINDOW_MS + 100);
    const phone = countSessionsChanged(remote.client);
    await session.submit({ text: "第一句" });
    await until(() => phone.count() > 0, "首条消息的通知");
    // 通知到达时列表里已经能读到标题
    const listed = await remote.client.runtime.listSessions();
    expect(listed.find((item) => item.id === session.id)?.firstText).toBeTruthy();
    await sleep(WINDOW_MS + 100);
    const afterFirst = phone.count();
    await session.submit({ text: "第二句" });
    await sleep(WINDOW_MS + 100);
    expect(phone.count()).toBe(afterFirst);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("生成的标题落盘后再推送一次，通知到达时列表已是标题", async () => {
    // 标题比首条消息的合并窗口晚到，两次变化落在不同窗口
    const provider = new FakeProvider({
      scripts: [textScript("好")],
      models: VISION_MODELS,
      roleHandler: () => [
        { type: "wait", ms: WINDOW_MS * 2 },
        { type: "text_delta", text: "生成的标题" },
        { type: "finish", reason: "stop" },
      ],
    });
    const h = await connectMany({ provider });
    const remote = await h.add();
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await sleep(WINDOW_MS + 100);
    const phone = countSessionsChanged(remote.client);
    await session.submit({ text: "第一句话" });
    await until(() => phone.count() === 1, "首条消息的通知");
    const beforeTitle = await remote.client.runtime.listSessions();
    expect(beforeTitle.find((item) => item.id === session.id)?.firstText).toBe("第一句话");
    await until(
      () => h.durable(session.id).some((event) => event.type === "session.titled"),
      "标题事件落盘",
    );
    await until(() => phone.count() === 2, "标题的通知");
    const listed = await remote.client.runtime.listSessions();
    expect(listed.find((item) => item.id === session.id)?.firstText).toBe("生成的标题");
    await sleep(WINDOW_MS + 100);
    expect(phone.count()).toBe(2);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("恢复已有首条消息的会话不会推送", async () => {
    const h = await connectMany({ scripts: [textScript("好")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "你好" });
    await session.close();
    await sleep(WINDOW_MS + 200);
    const remote = await h.add();
    const phone = countSessionsChanged(remote.client);
    await remote.client.runtime.resumeSession(session.id);
    await sleep(WINDOW_MS + 100);
    expect(phone.count()).toBe(0);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("窗口内的多次变化合并成一条", async () => {
    const h = await connectMany();
    const remote = await h.add();
    const phone = countSessionsChanged(remote.client);
    await Promise.all([
      remote.client.runtime.createSession({ model: MODEL, cwd: h.ws }),
      remote.client.runtime.createSession({ model: MODEL, cwd: h.ws }),
      h.client.runtime.createSession({ model: MODEL, cwd: h.ws }),
    ]);
    await sleep(WINDOW_MS + 150);
    expect(phone.count()).toBe(1);
    // 窗口过后的新变化再推一条
    await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    await until(() => phone.count() === 2, "第二个窗口的通知");
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("未握手的连接不会收到", async () => {
    const h = await connectMany();
    const idle = await h.add("remote", false);
    const phone = countSessionsChanged(idle.client);
    await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    await sleep(WINDOW_MS + 100);
    expect(phone.count()).toBe(0);
    idle.client.close();
    await h.client.shutdown();
    await Promise.all([h.served, idle.served]);
  });

  it("没有监听器的客户端收到它也不出错、不断线", async () => {
    const h = await connectMany();
    const remote = await h.add();
    await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    await sleep(WINDOW_MS + 100);
    expect(await remote.client.runtime.listSessions()).toHaveLength(1);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });
});
