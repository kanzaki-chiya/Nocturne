import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { REMOTE_METHODS, remoteAttachmentLimit } from "@nocturne/rpc/server";
import { RPC_METHOD_NAMES } from "../src/shared/methods.js";
import {
  cleanupTmp,
  connectMany,
  connectManyWithConfig,
  MODEL,
  textScript,
  tmpDir,
  until,
} from "./harness.js";

afterEach(cleanupTmp);

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

const writeScript = [
  {
    type: "tool_call" as const,
    toolCallId: "w",
    name: "write",
    input: { path: "out.txt", content: "ok" },
  },
  { type: "finish" as const, reason: "tool_calls" as const },
];

/** 到达 Core：要么成功，要么是 Core / 参数错误，但绝不是远程越界 */
async function reaches(call: Promise<unknown>): Promise<void> {
  await call.catch((error: unknown) => {
    expect(error).not.toMatchObject({ code: "remote_not_allowed" });
  });
}

/** 撤销手机后仍会生效的写入方法，以及电脑独占的只读设置查询 */
const STILL_LOCAL = [
  "shutdown",
  "runtime.updateSettings",
  "runtime.setDefaultModel",
  "runtime.setModelRole",
  "runtime.setShellSetting",
  "runtime.setPreference",
  "runtime.getPreference",
  "runtime.reloadConfig",
  "runtime.testReviewerSample",
  "runtime.describeSettings",
  "runtime.listReviewerProviders",
  "runtime.listReviewerModels",
  "runtime.listReviewerSamples",
  "runtime.defaultReviewer",
  "session.setShell",
  "session.readFile",
  "skills.importSkills",
  "skills.setSkillEnabled",
  "provider.refreshModelsDev",
  "provider.refreshUpstreamLimits",
] as const;

describe("远程白名单（ADR-0052 修订 2026-10-15）", () => {
  it("清单外的方法全部禁止：provider/login/remote/mcp/agents 与设置写入", () => {
    const denied = RPC_METHOD_NAMES.filter(
      (name) => !(REMOTE_METHODS as readonly string[]).includes(name),
    );
    for (const name of STILL_LOCAL) expect(denied).toContain(name);
    for (const name of RPC_METHOD_NAMES) {
      if (/^(provider|login|remote|mcp|agents)\./.test(name)) expect(denied).toContain(name);
    }
    // 会话方法只有写 settings.json 的 setShell 与面板读文件（ADR-0060）留在本机
    expect(denied.filter((name) => name.startsWith("session.")).sort()).toEqual([
      "session.readFile",
      "session.setShell",
    ]);
  });

  it("新放开的会话方法都能经远程到达 Core", async () => {
    const h = await connectMany({
      scripts: [writeScript, textScript("写好了"), textScript("看到了")],
    });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    const events: RuntimeEvent[] = [];
    await b.subscribe((e) => events.push(e));
    // 电脑端同一会话的订阅：手机改档位、预设后桌面状态栏靠它刷新
    const local: RuntimeEvent[] = [];
    await a.subscribe((e) => local.push(e));

    // 第一轮：写文件，从手机批准本会话
    const turn = b.submit({ text: "写" });
    await until(() => events.some((e) => e.type === "permission.requested"));
    const asked = events.find((e) => e.type === "permission.requested");
    if (asked?.type !== "permission.requested") throw new Error("缺少权限请求");
    await b.respondPermission(asked.payload.requestId, { decision: "allow", remember: "session" });
    expect(await turn).toBe("done");

    // 第二轮：图片附件 + 文件引用的完整载荷
    expect(
      await b.submit({
        text: "看 [Image #1] @out.txt",
        attachments: [{ data: PNG_2x3, mimeType: "image/png", label: "相册" }],
      }),
    ).toBe("done");
    const user = events.findLast((e) => e.type === "message.user");
    const file = user?.type === "message.user" ? user.payload.attachments?.[0]?.file : undefined;
    expect(file).toBeDefined();
    expect(await b.readAttachment(file ?? "")).toMatchObject({ mimeType: "image/png" });

    await b.setModel(MODEL);
    await b.setReasoningEffort("off");
    await b.setPermissionPreset("read-only");
    expect((await b.state()).config.permissionPreset).toBe("read-only");
    expect((await a.state()).config.permissionPreset).toBe("read-only");
    await until(
      () =>
        local.some(
          (e) => e.type === "session.config_changed" && e.payload.permissionPreset === "read-only",
        ) &&
        local.some(
          (e) => e.type === "session.config_changed" && e.payload.reasoningEffort === "off",
        ),
      "电脑端收到手机的配置变更",
    );

    const turns = await b.turnChanges();
    expect(turns.length).toBeGreaterThan(0);
    const changed = turns.find((t) => t.files.length > 0);
    if (changed?.files[0]) await reaches(b.turnChangeDiff(changed.seq, changed.files[0].path));
    expect((await b.describeContext()).report.estimatedTokens).toBeGreaterThan(0);
    await reaches(b.describeSkills());
    await reaches(b.describeExternalAgents());
    await b.mcpServers();
    await b.listShells();
    await b.shellInfo();
    await b.reasoningEffortInfo();
    await b.visionInfo();
    await reaches(b.fileIndex());
    expect(await b.resolveFiles(["out.txt"])).toHaveLength(1);
    // 面板读文件只给电脑（ADR-0060 第 3 节）：远程被拒，本机可读
    await expect(b.readFile("out.txt")).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(await a.readFile("out.txt")).toMatchObject({ kind: "text", text: "ok" });
    await b.recordInputHistory("手机输入");
    expect(await b.readInputHistory()).toContain("手机输入");
    await reaches(b.compact());
    await reaches(
      remote.client.call("session.submit", {
        sessionId: b.id,
        text: "/外部 任务",
        delegate: { agent: "missing", task: "任务" },
      }),
    );
    await reaches(
      remote.client.call("session.submit", {
        sessionId: b.id,
        text: "/技能",
        skill: { name: "missing" },
      }),
    );
    const targets = await b.rewindTargets();
    expect(targets.length).toBeGreaterThan(0);

    const forked = await remote.client.runtime.forkSession(a.id);
    expect(forked).not.toBe(a.id);
    await reaches(b.rewind(targets.at(-1)?.seq ?? 0, "conversation"));

    // 运行时只读查询与新建、恢复的完整参数
    await remote.client.runtime.usageStats({ days: 7 });
    await remote.client.runtime.listRecentModels();
    await remote.client.runtime.describeModelRoles();
    await remote.client.runtime.listShells();
    const elsewhere = tmpDir("nct-rpc-other-");
    await remote.client.runtime.listModels({ workspaceRoot: elsewhere });
    await remote.client.runtime.defaultModel({ workspaceRoot: elsewhere });
    const { session: c } = await remote.client.runtime.createSession({
      model: MODEL,
      cwd: elsewhere,
      permissionPreset: "default",
      reasoningEffort: "off",
    });
    expect((await c.state()).meta.cwd).toBe(elsewhere);
    await c.close();
    const { session: d } = await remote.client.runtime.resumeSession(c.id, {
      model: MODEL,
      force: false,
    });
    await d.close();
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("禁止的方法报 remote_not_allowed，不调用 Core，不消费待处理的权限请求", async () => {
    const h = await connectManyWithConfig({ scripts: [writeScript, textScript("ok")] });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    const events: RuntimeEvent[] = [];
    await a.subscribe((e) => events.push(e));
    const turn = a.submit({ text: "写" });
    await until(() => events.some((e) => e.type === "permission.requested"));
    const asked = events.find((e) => e.type === "permission.requested");
    if (asked?.type !== "permission.requested") throw new Error("缺少权限请求");
    const shellBefore = await a.shellInfo();
    const presetBefore = (await a.state()).config.permissionPreset;

    const denied = RPC_METHOD_NAMES.filter(
      (name) => !(REMOTE_METHODS as readonly string[]).includes(name),
    );
    // 参数取会产生副作用的有效值：被拒说明根本没进处理器
    const params: Record<string, unknown> = {
      "runtime.setPreference": { key: "phone", value: "yes" },
      "session.setShell": { sessionId: b.id, kind: "auto" },
      "runtime.setShellSetting": { kind: "auto" },
      "runtime.updateSettings": { patch: { "permissions.preset": "bypass" } },
      "runtime.setDefaultModel": { model: MODEL, reasoningEffort: "off" },
    };
    for (const method of denied) {
      await expect(
        remote.client.call(method as "shutdown", (params[method] ?? {}) as never),
      ).rejects.toMatchObject({ code: "remote_not_allowed", rpcCode: -32004 });
    }
    // 持久授权同样拒绝，请求保持待处理
    await expect(
      b.respondPermission(asked.payload.requestId, { decision: "allow", remember: "project" }),
    ).rejects.toMatchObject({ code: "remote_not_allowed" });

    expect(await h.client.runtime.getPreference("phone")).toBeUndefined();
    expect(await a.shellInfo()).toEqual(shellBefore);
    expect((await a.state()).config.permissionPreset).toBe(presetBefore);
    expect(events.some((e) => e.type === "permission.resolved")).toBe(false);
    await a.respondPermission(asked.payload.requestId, { decision: "allow" });
    expect(await turn).toBe("done");
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("新建会话：目录必须存在；未信任的新项目要在电脑上决定，已用过或已信任的照常", async () => {
    const h = await connectManyWithConfig();
    const remote = await h.add();
    const missing = path.join(tmpDir("nct-rpc-gone-"), "nope");
    await expect(
      remote.client.runtime.createSession({ model: MODEL, cwd: missing }),
    ).rejects.toMatchObject({ code: "workspace_not_found", rpcCode: -32004 });
    await expect(
      remote.client.runtime.createSession({ model: MODEL, cwd: "relative/dir" }),
    ).rejects.toMatchObject({ code: "workspace_not_found" });
    const file = path.join(tmpDir("nct-rpc-file-"), "a.txt");
    writeFileSync(file, "x");
    await expect(
      remote.client.runtime.createSession({ model: MODEL, cwd: file }),
    ).rejects.toMatchObject({ code: "workspace_not_found" });

    // 没有项目配置的目录不需要信任决定
    const plain = tmpDir("nct-rpc-plain-");
    await (await remote.client.runtime.createSession({ model: MODEL, cwd: plain })).session.close();

    const project = tmpDir("nct-rpc-project-");
    mkdirSync(path.join(project, ".nocturne"));
    writeFileSync(path.join(project, ".nocturne", "config.json"), "{}");
    const untrusted = remote.client.runtime.createSession({ model: MODEL, cwd: project });
    await expect(untrusted).rejects.toMatchObject({ code: "workspace_untrusted", rpcCode: -32004 });
    await expect(untrusted).rejects.toThrow(/在电脑上信任/);
    await expect(
      remote.client.runtime.createSession({ model: MODEL, workspaceRoot: project }),
    ).rejects.toMatchObject({ code: "workspace_untrusted" });
    // 本机照常创建（未信任方式），此后手机可在这个已用过的工作区新建
    await h.client.runtime.createSession({ model: MODEL, cwd: project });
    await (
      await remote.client.runtime.createSession({ model: MODEL, cwd: project })
    ).session.close();

    const trusted = tmpDir("nct-rpc-trusted-");
    mkdirSync(path.join(trusted, ".nocturne"));
    writeFileSync(path.join(trusted, ".nocturne", "config.json"), "{}");
    await h.config.setWorkspaceTrusted(trusted, true);
    await (
      await remote.client.runtime.createSession({ model: MODEL, cwd: trusted })
    ).session.close();
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("远程结果超过报文上限改报错误，连接保持可用；本机不受限", async () => {
    const limit = 4096;
    const h = await connectMany({ scripts: [textScript("看到了")], remoteMessageLimit: limit });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL });
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    for (let i = 0; i < 40; i++) await b.recordInputHistory(`第 ${i} 条 ${"很长".repeat(40)}`);
    await expect(b.readInputHistory()).rejects.toMatchObject({
      code: "response_too_large",
      rpcCode: -32004,
    });
    expect((await a.readInputHistory()).length).toBe(40);
    // 附件按原始字节预检，返回明确文案；小图照常
    const big = new Uint8Array(remoteAttachmentLimit(limit) + 1);
    big.set(PNG_2x3);
    await a.submit({
      text: "看 [Image #1] [Image #2]",
      attachments: [
        { data: PNG_2x3, mimeType: "image/png", label: "小图" },
        { data: big, mimeType: "image/png", label: "大图" },
      ],
    });
    expect((await b.readAttachment("img-1.png")).bytes).toBe(PNG_2x3.length);
    const tooLarge = b.readAttachment("img-2.png");
    await expect(tooLarge).rejects.toMatchObject({ code: "attachment_too_large" });
    await expect(tooLarge).rejects.toThrow("图片过大，请在电脑上查看");
    expect((await a.readAttachment("img-2.png")).bytes).toBe(big.length);
    expect(await b.state()).toBeDefined();
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });
});
