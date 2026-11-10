import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { READ_FILE_MAX_BYTES } from "@nocturne/core";
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
  "grants.setTrusted",
  "grants.describeProject",
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
  "runtime.searchSessions",
  "runtime.defaultReviewer",
  "session.setShell",
  "runtime.readFile",
  "subagent.diff",
  "subagent.worktrees",
  "subagent.deleteWorktree",
  "subagent.readAttachment",
  "skills.importSkills",
  "skills.setSkillEnabled",
  "schedule.save",
  "schedule.delete",
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
    // 会话方法只有写 settings.json 的 setShell 留在本机；session.readFile 与子会话观察已开放
    expect(denied.filter((name) => name.startsWith("session.")).sort()).toEqual([
      "session.setShell",
    ]);
    for (const allowed of [
      "subagent.cancel",
      "subagent.list",
      "subagent.subscribe",
      "subagent.unsubscribe",
      "session.readFile",
    ]) {
      expect(REMOTE_METHODS as readonly string[]).toContain(allowed);
    }
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
    // 面板读文件只给电脑（ADR-0060 第 3 节）：远程被拒，本机可读；会话受限读文件（session.readFile）对远程开放
    const out = path.join(h.ws, "out.txt");
    await expect(remote.client.runtime.readFile(out)).rejects.toMatchObject({
      code: "remote_not_allowed",
    });
    expect(await h.client.runtime.readFile(out)).toMatchObject({ kind: "text", text: "ok" });
    expect(await b.readFile("out.txt")).toEqual({
      kind: "text",
      path: "out.txt",
      text: "ok",
      bytes: 2,
    });
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
    const used = await h.client.runtime.createSession({ model: MODEL, cwd: project });
    await h.client.runtime.archiveSession(used.session.id);
    expect(
      await remote.client.runtime.listSessions({ cwd: project, includeArchived: true }),
    ).toEqual([]);
    // 归档只影响列表，不改变 allowWorkspace 的已用工作区判定。
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
    await expect(
      b.submit({
        attachments: [{ data: big, mimeType: "application/octet-stream", label: "large.bin" }],
      }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    await expect(
      b.enqueueInput("queue", {
        attachments: [{ data: big, mimeType: "text/plain", label: "large.txt" }],
      }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    await expect(
      b.respondQuestion("unused", {
        answers: [{ selected: [], attachments: [{ data: big, mimeType: "text/plain" }] }],
      }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    const tooLarge = b.readAttachment("img-2.png");
    await expect(tooLarge).rejects.toMatchObject({ code: "attachment_too_large" });
    await expect(tooLarge).rejects.toThrow("附件过大，请在电脑上查看");
    expect((await a.readAttachment("img-2.png")).bytes).toBe(big.length);
    expect(await b.state()).toBeDefined();
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("远程连接带 branch 调用 runtime.createSession 被拒绝（ADR-0085），本机连接允许", async () => {
    const h = await connectMany({ scripts: [textScript("ok")] });
    const remote = await h.add();
    await expect(
      remote.client.runtime.createSession({
        model: MODEL,
        cwd: h.ws,
        branch: { name: "main" },
      }),
    ).rejects.toMatchObject({ code: "remote_not_allowed" });
    await reaches(
      h.client.runtime.createSession({
        model: MODEL,
        cwd: h.ws,
        branch: { name: "main" },
      }),
    );
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("session.readFile 边界：只读 fileIndex 内的工作区文本，拒绝 ..、外路径、符号链接逃逸、隐藏/忽略文件与二进制", async () => {
    const h = await connectMany();
    const outside = tmpDir("nct-rpc-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "top-secret");

    mkdirSync(path.join(h.ws, "src"), { recursive: true });
    mkdirSync(path.join(h.ws, "dist"), { recursive: true });
    mkdirSync(path.join(h.ws, ".git"), { recursive: true });
    mkdirSync(path.join(h.ws, ".nocturne"), { recursive: true });
    mkdirSync(path.join(h.ws, ".hidden"), { recursive: true });
    writeFileSync(path.join(h.ws, ".gitignore"), "ignored.txt\ndist/\n");
    writeFileSync(path.join(h.ws, "src", "hello.ts"), "export const a = 1;\n中文\n");
    writeFileSync(path.join(h.ws, "ignored.txt"), "ignored");
    writeFileSync(path.join(h.ws, "dist", "bundle.js"), "bundle");
    writeFileSync(path.join(h.ws, ".env"), "SECRET=1");
    writeFileSync(path.join(h.ws, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(h.ws, ".nocturne", "config.json"), "{}");
    writeFileSync(path.join(h.ws, ".hidden", "note.txt"), "hidden");
    writeFileSync(path.join(h.ws, "blob.bin"), Uint8Array.from([1, 0, 2, 0, 3]));
    writeFileSync(path.join(h.ws, "raw-nul.txt"), Uint8Array.from([0x61, 0x00, 0x62]));
    writeFileSync(path.join(h.ws, "bad-utf8.txt"), Uint8Array.from([0x80, 0x81, 0xfe]));
    writeFileSync(path.join(h.ws, "logo.png"), PNG_2x3);
    symlinkSync(
      outside,
      path.join(h.ws, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    symlinkSync(
      path.join(h.ws, "src"),
      path.join(h.ws, "linked-inside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let hasFileSymlink = false;
    try {
      symlinkSync(path.join(outside, "secret.txt"), path.join(h.ws, "escape-file.txt"), "file");
      hasFileSymlink = true;
    } catch {
      hasFileSymlink = false;
    }

    const { session: local } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const remote = await h.add();
    const { session: phone } = await remote.client.runtime.resumeSession(local.id);

    // 正常文本读取
    const expectedBytes = Buffer.byteLength("export const a = 1;\n中文\n", "utf8");
    expect(await phone.readFile("src/hello.ts")).toEqual({
      kind: "text",
      path: "src/hello.ts",
      text: "export const a = 1;\n中文\n",
      bytes: expectedBytes,
    });

    // 拒绝 .. 段、. 段、空路径、前导/尾随斜杠、绝对路径、工作区外路径、UNC
    for (const badPath of [
      "",
      "   ",
      ".",
      "..",
      "./src/hello.ts",
      "../secret.txt",
      "src/../src/hello.ts",
      "src/../../secret.txt",
      "/src/hello.ts",
      "\\src\\hello.ts",
      "src/hello.ts/",
      path.join(h.ws, "src", "hello.ts"),
      path.join(outside, "secret.txt"),
      "\\\\127.0.0.1\\share\\a.txt",
      "src/hello.ts\u0000",
    ]) {
      await expect(phone.readFile(badPath), badPath).rejects.toMatchObject({
        code: "invalid_file_path",
        rpcCode: -32002,
      });
    }

    // 拒绝符号链接 / junction（逃逸到工作区外或指向工作区内）
    for (const linkPath of [
      "linked-outside/secret.txt",
      "linked-inside/hello.ts",
      ...(hasFileSymlink ? ["escape-file.txt"] : []),
    ]) {
      await expect(phone.readFile(linkPath), linkPath).rejects.toMatchObject({
        code: "invalid_file_path",
        rpcCode: -32002,
      });
    }

    // 拒绝不在 session.fileIndex() 中的工作区文件（.gitignore、隐藏文件、.git、.nocturne）
    const indexPaths = (await phone.fileIndex()).map((entry) => entry.path);
    expect(indexPaths).toContain("src/hello.ts");
    for (const hiddenOrIgnored of [
      "ignored.txt",
      "dist/bundle.js",
      ".env",
      ".git/HEAD",
      ".nocturne/config.json",
      ".hidden/note.txt",
    ]) {
      expect(indexPaths).not.toContain(hiddenOrIgnored);
      await expect(phone.readFile(hiddenOrIgnored), hiddenOrIgnored).rejects.toMatchObject({
        code: "invalid_file_path",
        rpcCode: -32002,
      });
    }

    // 目录与不存在的文件
    await expect(phone.readFile("src")).rejects.toMatchObject({
      code: "file_not_regular",
      rpcCode: -32002,
    });
    await expect(phone.readFile("src/missing.ts")).rejects.toMatchObject({
      code: "file_not_found",
      rpcCode: -32002,
    });

    // 二进制文件（含图片、NUL 字节、非法 UTF-8）不返回内容，报 file_binary 并附带 bytes
    for (const [binPath, size] of [
      ["blob.bin", 5],
      ["raw-nul.txt", 3],
      ["bad-utf8.txt", 3],
      ["logo.png", PNG_2x3.byteLength],
    ] as const) {
      const err = await phone.readFile(binPath).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "file_binary",
        rpcCode: -32002,
        bytes: size,
        data: { code: "file_binary", bytes: size },
      });
      expect(err).not.toHaveProperty("text");
    }

    // 参数校验
    await expect(
      remote.client.call("session.readFile", { sessionId: phone.id, path: 123 as never }),
    ).rejects.toMatchObject({ code: "invalid_params", rpcCode: -32602 });

    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("session.readFile 超过远程通道上限或 READ_FILE_MAX_BYTES 时报 file_too_large 且 error.data 带 bytes，不截断", async () => {
    const limit = 4096;
    const h = await connectMany({ remoteMessageLimit: limit });
    const overChannelText = "x".repeat(limit + 200);
    const overChannelBytes = Buffer.byteLength(overChannelText, "utf8");
    // 原始字节 < limit，但因 JSON 转义 + 报文封装超过 limit
    const expandText = '"\n'.repeat(1800);
    const expandBytes = Buffer.byteLength(expandText, "utf8");
    expect(expandBytes).toBeLessThan(limit);
    const overMaxBytes = READ_FILE_MAX_BYTES + 10;

    writeFileSync(path.join(h.ws, "over-channel.txt"), overChannelText);
    writeFileSync(path.join(h.ws, "expand-json.txt"), expandText);
    writeFileSync(path.join(h.ws, "over-max.txt"), "a".repeat(overMaxBytes));

    const { session: local } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const remote = await h.add();
    const { session: phone } = await remote.client.runtime.resumeSession(local.id);

    // 1. 超过远程通道上限：远程报 file_too_large 并带精确 bytes，本机完整读出不截断
    const remoteErr1 = await phone.readFile("over-channel.txt").catch((e: unknown) => e);
    expect(remoteErr1).toMatchObject({
      code: "file_too_large",
      rpcCode: -32002,
      bytes: overChannelBytes,
      data: { code: "file_too_large", bytes: overChannelBytes },
    });
    const localRead1 = await local.readFile("over-channel.txt");
    expect(localRead1.bytes).toBe(overChannelBytes);
    expect(localRead1.text).toBe(overChannelText);

    // 2. 原始大小未超 limit、但 JSON-RPC 编码后超 limit：同样明确报 file_too_large + bytes，不报 response_too_large 也不截断
    const remoteErr2 = await phone.readFile("expand-json.txt").catch((e: unknown) => e);
    expect(remoteErr2).toMatchObject({
      code: "file_too_large",
      rpcCode: -32002,
      bytes: expandBytes,
      data: { code: "file_too_large", bytes: expandBytes },
    });
    const localRead2 = await local.readFile("expand-json.txt");
    expect(localRead2.bytes).toBe(expandBytes);
    expect(localRead2.text).toBe(expandText);

    // 3. 超过 READ_FILE_MAX_BYTES（2 MiB）：本机与远程均报 file_too_large + bytes
    for (const reader of [local, phone]) {
      const err = await reader.readFile("over-max.txt").catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "file_too_large",
        rpcCode: -32002,
        bytes: overMaxBytes,
        data: { code: "file_too_large", bytes: overMaxBytes },
      });
    }

    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });
});
