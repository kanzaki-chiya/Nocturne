import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@nocturne/core";

import {
  cleanupTmp,
  connectManyWithConfig,
  connectWithConfig,
  MODEL,
  textScript,
  tmpDir,
} from "./harness.js";

afterEach(cleanupTmp);

describe("memory.* RPC 往返、权限边界与 settings 开关", () => {
  it("本机连接：describeMemory / readMemory / deleteMemory / clearMemory 往返、写删推 providersChanged、updateSettings 读写开关", async () => {
    let phase = 0;
    const provider = new FakeProvider({
      roleHandler: () => textScript("标题"),
      handler: () => {
        phase += 1;
        if (phase === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "mw-g",
              name: "memory_write",
              input: {
                scope: "global",
                name: "tone",
                description: "Prefer direct tone",
                type: "user",
                content: "Be concise.",
              },
            },
            {
              type: "tool_call",
              toolCallId: "mw-p",
              name: "memory_write",
              input: {
                scope: "project",
                name: "test-cmd",
                description: "Run vitest",
                type: "project",
                content: "Use pnpm test.",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return textScript("done");
      },
    });

    const h = await connectWithConfig({ provider });
    let providersChangedCount = 0;
    const offProviders = h.client.onProvidersChanged(() => {
      providersChangedCount += 1;
    });

    // 通过会话工具写入两条记忆，触发 providersChanged
    const { opened } = await h.client.runtime.createSession({ model: MODEL });
    const session = h.client.session(opened.sessionId);
    await session.submit({ text: "记住两条偏好" });
    expect(providersChangedCount).toBeGreaterThanOrEqual(2);

    const desc = await h.client.runtime.describeMemory({ workspaceRoot: h.ws });
    expect(desc.global.enabled).toBe(true);
    expect(desc.global.entries.map((e) => e.name)).toEqual(["tone"]);
    expect(desc.project?.enabled).toBe(true);
    expect(desc.project?.entries.map((e) => e.name)).toEqual(["test-cmd"]);

    const entry = await h.client.runtime.readMemory({
      scope: "project",
      workspaceRoot: h.ws,
      name: "test-cmd",
    });
    expect(entry.content).toBe("Use pnpm test.");

    // deleteMemory 推送 runtime.providersChanged
    const beforeDel = providersChangedCount;
    await h.client.runtime.deleteMemory({
      scope: "project",
      workspaceRoot: h.ws,
      name: "test-cmd",
    });
    expect(providersChangedCount).toBe(beforeDel + 1);
    const afterDel = await h.client.runtime.describeMemory({ workspaceRoot: h.ws });
    expect(afterDel.project?.entries).toEqual([]);

    // clearMemory 推送 runtime.providersChanged
    const beforeClear = providersChangedCount;
    await h.client.runtime.clearMemory({ scope: "global" });
    expect(providersChangedCount).toBe(beforeClear + 1);
    const afterClear = await h.client.runtime.describeMemory({ workspaceRoot: h.ws });
    expect(afterClear.global.entries).toEqual([]);

    // updateSettings 读写 memory.global / memory.project
    const updated = await h.client.runtime.updateSettings({
      "memory.global": false,
      "memory.project": false,
    });
    expect(updated.find((s) => s.key === "memory.global")).toMatchObject({
      effective: "false",
      saved: "false",
      source: "settings",
    });
    expect(updated.find((s) => s.key === "memory.project")).toMatchObject({
      effective: "false",
      saved: "false",
      source: "settings",
    });
    const descOff = await h.client.runtime.describeMemory({ workspaceRoot: h.ws });
    expect(descOff.global.enabled).toBe(false);
    expect(descOff.project?.enabled).toBe(false);

    // 恢复默认
    await h.client.runtime.updateSettings({ "memory.global": null });
    const settings = await h.client.runtime.describeSettings({ workspaceRoot: h.ws });
    const globalItem = settings.find((s) => s.key === "memory.global");
    expect(globalItem).toMatchObject({
      effective: "true",
      source: "default",
    });
    expect(globalItem?.saved).toBeUndefined();

    // 非法 scope 参数返回 -32602
    await expect(
      h.client.call("memory.readMemory", { scope: "invalid", name: "x" } as never),
    ).rejects.toMatchObject({ rpcCode: -32602 });

    offProviders();
    await session.close();
    h.client.close();
    await h.served;
  });

  it("其他项目条目以摘要返回；按 key 定位读与删，同名条目不串读（ADR-0122 §2）", async () => {
    let wrote = false;
    const provider = new FakeProvider({
      roleHandler: () => textScript("标题"),
      handler: () => {
        if (!wrote) {
          wrote = true;
          return [
            {
              type: "tool_call",
              toolCallId: "mw-o",
              name: "memory_write",
              input: {
                scope: "project",
                name: "shared-name",
                description: "Other project rule",
                type: "project",
                content: "Content of the other project.",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return textScript("done");
      },
    });
    const h = await connectWithConfig({ provider });

    // 在其他工作区写一条记忆，再从无关联的视角工作区浏览
    const otherWs = tmpDir("nct-rpc-mem-other-");
    mkdirSync(otherWs, { recursive: true });
    const { opened } = await h.client.runtime.createSession({
      model: MODEL,
      workspaceRoot: otherWs,
    });
    const writeSession = h.client.session(opened.sessionId);
    await writeSession.submit({ text: "记住这条偏好" });
    await writeSession.close();

    const desc = await h.client.runtime.describeMemory({ workspaceRoot: h.ws });
    expect(desc.otherProjects).toHaveLength(1);
    const proj = desc.otherProjects[0];
    if (proj === undefined) throw new Error("expected one other project");
    expect(proj.entries).toHaveLength(1);
    expect(proj.entries[0]).toMatchObject({
      name: "shared-name",
      description: "Other project rule",
      type: "project",
    });
    expect(proj.count).toBe(1);
    expect(typeof proj.key).toBe("string");

    // 按 key 读取正文（带 key 时不需要 workspaceRoot）
    const entry = await h.client.runtime.readMemory({
      scope: "project",
      key: proj.key,
      name: "shared-name",
    });
    expect(entry.scope).toBe("project");
    expect(entry.content).toBe("Content of the other project.");

    // 按视角工作区寻址同名条目找不到：证明不带 key 时不会误读到其他项目
    await expect(
      h.client.call("memory.readMemory", {
        scope: "project",
        workspaceRoot: h.ws,
        name: "shared-name",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_command" });

    // 按 key 删除后该项目从总览消失
    await h.client.runtime.deleteMemory({ scope: "project", key: proj.key, name: "shared-name" });
    const afterDel = await h.client.runtime.describeMemory({ workspaceRoot: h.ws });
    expect(afterDel.otherProjects).toEqual([]);

    h.client.close();
    await h.served;
  });

  it("远程连接拒绝 memory.* 方法（remote_not_allowed）", async () => {
    const extraWs = tmpDir("nct-rpc-mem-rem-");
    mkdirSync(extraWs, { recursive: true });
    writeFileSync(path.join(extraWs, "dummy.txt"), "x");

    const h = await connectManyWithConfig({});
    const remote = await h.add("remote");

    await expect(h.client.runtime.describeMemory()).resolves.toBeDefined();
    await expect(remote.client.runtime.describeMemory()).rejects.toMatchObject({
      code: "remote_not_allowed",
    });
    await expect(
      remote.client.runtime.readMemory({ scope: "global", name: "x" }),
    ).rejects.toMatchObject({
      code: "remote_not_allowed",
    });
    await expect(
      remote.client.runtime.deleteMemory({ scope: "global", name: "x" }),
    ).rejects.toMatchObject({
      code: "remote_not_allowed",
    });
    await expect(remote.client.runtime.clearMemory({ scope: "global" })).rejects.toMatchObject({
      code: "remote_not_allowed",
    });

    remote.client.close();
    await remote.served;
    h.client.close();
    await h.served;
  });
});
