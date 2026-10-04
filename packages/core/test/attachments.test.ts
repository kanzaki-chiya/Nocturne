/**
 * 附件存储 × 真实会话存储（ADR-0023 第 2 节）：
 * 恢复会话后历史保留附件引用，新 save 编号不与已落盘文件冲突。
 * 跨模块协作测试放在 test/（depcheck 只允许 tools 依赖 protocol/permission/platform）。
 */
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime } from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { createSessionStore } from "../src/session/index.js";
import { createAttachmentStore } from "../src/tools/index.js";
import type { ImageAttachment } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

const platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

const makeStore = (attachmentsDir: string, sessionId: string) =>
  createAttachmentStore({ fs: platform.fs, paths: platform.paths, attachmentsDir, sessionId });

describe("附件编号跨恢复续接（ADR-0023）", () => {
  it("带附件的会话恢复后历史含引用，新 save 续编号不撞旧文件", async () => {
    const sessionsDir = tmpDir("nct-att-sess-");
    const attachmentsDir = path.join(sessionsDir, "attachments");
    const store = createSessionStore({ platform, sessionsDir });
    const s1 = await store.create({
      cwd: "Z:\\repo",
      workspaceRoot: "Z:\\repo",
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      nocturneVersion: "0.0.0",
    });
    const a1 = await makeStore(attachmentsDir, s1.id).save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "read",
    });
    await s1.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s1.emit(
      "tool.completed",
      {
        callId: "c1",
        name: "read",
        status: "ok",
        modelContent: "Image file: x.png",
        attachments: [a1],
      },
      { turnId: "t1" },
    );
    await s1.emit(
      "turn.completed",
      { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
      { turnId: "t1" },
    );
    await s1.close();

    const s2 = await store.load(s1.id);
    const toolEntry = s2.state().history.find((h) => h.kind === "tool");
    expect(toolEntry?.kind === "tool" && toolEntry.attachments?.[0]?.file).toBe("img-1.png");
    const a2 = await makeStore(attachmentsDir, s2.id).save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "paste",
    });
    expect(a2.file).toBe("img-2.png");
    expect(await platform.fs.exists(path.join(attachmentsDir, s2.id, "img-1.png"))).toBe(true);
    await s2.close();
  });
});

describe("端到端：read 图片 → 下一次请求（ADR-0023）", () => {
  it("submit 图片落盘并投影到同一条用户消息", async () => {
    const ws = tmpDir("nct-att-ws-");
    const sessionsDir = tmpDir("nct-att-sess-");
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "已看" },
          { type: "finish", reason: "stop" },
        ],
      ],
      models: [
        {
          ref: { provider: "fake", model: "fake-model" },
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "none",
            imageInput: true,
            promptCache: false,
            editTool: "edit",
          },
        },
      ],
    });
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({
      text: "看 [Image #1]",
      attachments: [{ data: PNG_2x3, mimeType: "image/png", label: "剪贴板" }],
    });
    const user = session.state().history.find((h) => h.kind === "user");
    expect(user?.kind).toBe("user");
    if (user?.kind !== "user") throw new Error("missing user");
    expect(user.attachments?.[0]).toMatchObject({
      file: "img-1.png",
      source: "paste",
      label: "剪贴板",
    });
    const ref = user.attachments?.[0];
    if (ref === undefined) throw new Error("missing attachment");
    expect(
      await platform.fs.readFile(path.join(sessionsDir, "attachments", session.id, ref.file)),
    ).toEqual(Buffer.from(PNG_2x3));
    expect(ref.sha256).toBe(
      (await import("node:crypto")).createHash("sha256").update(PNG_2x3).digest("hex"),
    );
    expect(await session.readAttachment(ref.file)).toEqual({
      data: Buffer.from(PNG_2x3),
      mimeType: "image/png",
      bytes: PNG_2x3.byteLength,
    });
    const requestUser = provider.requests[0]?.messages.find((m) => m.role === "user");
    expect(requestUser?.role === "user" && requestUser.images?.[0]).toMatchObject({
      data: Buffer.from(PNG_2x3).toString("base64"),
      mimeType: "image/png",
    });
    await session.close();
  });
  const readImageScripts = (): FakeScript[] => [
    [
      { type: "tool_call", toolCallId: "tc1", name: "read", input: { path: "pic.png" } },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "看到图片" },
      { type: "finish", reason: "stop" },
    ],
  ];

  it("imageInput=true 的模型：tool 消息携带 base64 images", async () => {
    const ws = tmpDir("nct-att-ws-");
    const sessionsDir = tmpDir("nct-att-sess-");
    writeFileSync(path.join(ws, "pic.png"), PNG_2x3);
    const provider = new FakeProvider({
      scripts: readImageScripts(),
      models: [
        {
          ref: { provider: "fake", model: "fake-model" },
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "none",
            imageInput: true,
            promptCache: false,
            editTool: "edit",
          },
        },
      ],
    });
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({ text: "看这张图" });
    expect(provider.requests).toHaveLength(2);
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.images?.[0]?.data).toBe(
      Buffer.from(PNG_2x3).toString("base64"),
    );
    expect(toolMsg?.role === "tool" && toolMsg.images?.[0]?.mimeType).toBe("image/png");
    expect(await session.readAttachment("img-1.png")).toMatchObject({
      data: Buffer.from(PNG_2x3),
      mimeType: "image/png",
    });
    await session.close();
  });

  it("imageInput=false 的模型：tool 消息为不支持占位，无 images", async () => {
    const ws = tmpDir("nct-att-ws-");
    const sessionsDir = tmpDir("nct-att-sess-");
    writeFileSync(path.join(ws, "pic.png"), PNG_2x3);
    const provider = new FakeProvider({ scripts: readImageScripts() });
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({ text: "看这张图" });
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain(
      "[image omitted: current model does not support image input]",
    );
    await session.close();
  });
});

async function attachmentSession() {
  const ws = tmpDir("nct-att-api-ws-");
  const sessionsDir = tmpDir("nct-att-api-sessions-");
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [new FakeProvider({})],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const store = makeStore(path.join(sessionsDir, "attachments"), session.id);
  const attachment = await store.save({
    data: PNG_2x3,
    mimeType: "image/png",
    source: "paste",
  });
  const user = await internalSession(session).emit("message.user", {
    messageId: "image",
    content: [{ type: "text", text: "image" }],
    attachments: [attachment],
  });
  const dir = path.join(sessionsDir, "attachments", session.id);
  return { runtime, session, store, attachment, user, dir, sessionsDir };
}

describe("RuntimeSession.readAttachment 安全读取", () => {
  it("仅持久 message.user/tool.completed 引用授权，回退及恢复不撤销原日志授权", async () => {
    const { runtime, session, store, attachment, user } = await attachmentSession();
    const toolAttachment = await store.save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "mcp",
    });
    await internalSession(session).emit("tool.completed", {
      callId: "image-call",
      name: "arbitrary_image_source",
      status: "ok",
      modelContent: "image",
      attachments: [toolAttachment],
    });
    await session.rewind(user.seq, "conversation");
    expect(session.state().history.some((entry) => entry.kind === "user")).toBe(false);
    for (const file of [attachment.file, toolAttachment.file]) {
      expect((await session.readAttachment(file)).data).toEqual(Buffer.from(PNG_2x3));
    }
    await session.close();
    const restored = await runtime.resumeSession(session.id);
    expect((await restored.readAttachment(toolAttachment.file)).bytes).toBe(PNG_2x3.length);
    await restored.close();
  });

  it("附件目录中的未登记图片和文本落盘输出不可读取", async () => {
    const { session, store, dir } = await attachmentSession();
    const unregistered = await store.save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "read",
    });
    writeFileSync(path.join(dir, "output.txt"), "private output");
    for (const file of [unregistered.file, "output.txt", "absent.png"]) {
      await expect(session.readAttachment(file)).rejects.toMatchObject({
        name: "SessionError",
        code: "attachment_not_found",
      });
    }
    await session.close();
  });

  it.each([
    "",
    ".",
    "..",
    "../img-1.png",
    "..\\img-1.png",
    "/tmp/image.png",
    "C:\\image.png",
    "\\\\server\\image.png",
    "nested/img-1.png",
    "nested\\img-1.png",
    "img-1.png:secret",
    "img-1.png\0",
    "img-1.png.",
    "img-1.png ",
    "CON.png",
  ])("拒绝非法单文件名 %j", async (file) => {
    const { session, attachment } = await attachmentSession();
    await internalSession(session).emit("message.user", {
      messageId: "unsafe-image",
      content: [],
      attachments: [{ ...attachment, file }],
    });
    await expect(session.readAttachment(file)).rejects.toMatchObject({
      code: "invalid_attachment_file",
    });
    await session.close();
  });

  it.each(["sha256", "bytes"] as const)("拒绝日志 %s 与磁盘不符", async (field) => {
    const { session, attachment, store } = await attachmentSession();
    const ref = await store.save({ data: PNG_2x3, mimeType: "image/png", source: "paste" });
    const corrupt: ImageAttachment = {
      ...ref,
      ...(field === "sha256" ? { sha256: "0".repeat(64) } : { bytes: attachment.bytes + 1 }),
    };
    await internalSession(session).emit("message.user", {
      messageId: "corrupt-reference",
      content: [],
      attachments: [corrupt],
    });
    await expect(session.readAttachment(ref.file)).rejects.toMatchObject({
      code: "attachment_corrupt",
    });
    await session.close();
  });

  it("每次重新读取并校验磁盘，忽略 AttachmentStore 及此前公开读取的缓存", async () => {
    const { session, store, attachment, dir } = await attachmentSession();
    expect(await store.load(attachment)).toEqual(PNG_2x3);
    await session.readAttachment(attachment.file);
    const changed = new Uint8Array(PNG_2x3);
    changed[changed.length - 1] = 1;
    writeFileSync(path.join(dir, attachment.file), changed);
    await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "attachment_corrupt",
    });
    writeFileSync(path.join(dir, attachment.file), PNG_2x3.subarray(0, 4));
    await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "attachment_corrupt",
    });
    unlinkSync(path.join(dir, attachment.file));
    await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "attachment_missing",
    });
    await session.close();
  });

  it("非缺失 I/O 错误保留读取失败原因，不伪装成缺失", async () => {
    const { session, attachment } = await attachmentSession();
    const cause = Object.assign(new Error("access denied"), { code: "EACCES" });
    const read = vi.spyOn(fsPromises, "readFile").mockRejectedValueOnce(cause);
    try {
      await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
        name: "SessionError",
        code: "attachment_read_failed",
        cause,
      });
    } finally {
      read.mockRestore();
      await session.close();
    }
  });

  it("会话隔离：同名附件只读本会话字节，子会话不回溯父附件", async () => {
    const { runtime, session, attachment, sessionsDir } = await attachmentSession();
    const child = await createSessionStore({ platform, sessionsDir }).create({
      cwd: session.state().meta.cwd,
      workspaceRoot: session.state().meta.workspaceRoot,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      nocturneVersion: "0.0.0",
      parent: { sessionId: session.id, callId: "child-task" },
    });
    await child.close();
    const childSession = await runtime.resumeSession(child.id);
    await expect(childSession.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "attachment_not_found",
    });
    const ownBytes = new Uint8Array(PNG_2x3);
    ownBytes[ownBytes.length - 1] = 2;
    const ownAttachment = await makeStore(path.join(sessionsDir, "attachments"), child.id).save({
      data: ownBytes,
      mimeType: "image/png",
      source: "read",
    });
    expect(ownAttachment.file).toBe(attachment.file);
    await internalSession(childSession).emit("tool.completed", {
      callId: "child-image",
      name: "generic-image",
      status: "ok",
      modelContent: "image",
      attachments: [ownAttachment],
    });
    expect((await childSession.readAttachment(ownAttachment.file)).data).toEqual(
      Buffer.from(ownBytes),
    );
    expect((await session.readAttachment(attachment.file)).data).toEqual(Buffer.from(PNG_2x3));
    await childSession.close();
    await session.close();
  });

  it("分叉附件从新 id 目录读取，原附件改动或删除不影响分叉", async () => {
    const { runtime, session, attachment, dir, user } = await attachmentSession();
    const id = await runtime.forkSession(session.id, { targetSeq: user.seq });
    const fork = await runtime.resumeSession(id);
    expect(fork.state().history.some((entry) => entry.kind === "user")).toBe(false);
    unlinkSync(path.join(dir, attachment.file));
    expect((await fork.readAttachment(attachment.file)).data).toEqual(Buffer.from(PNG_2x3));
    await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "attachment_missing",
    });
    await fork.close();
    await session.close();
  });

  it("拒绝会话附件目录 junction/symlink 逃逸，即使外部字节及哈希完全相同", async () => {
    const { session, attachment, dir } = await attachmentSession();
    const outside = tmpDir("nct-att-outside-");
    writeFileSync(path.join(outside, attachment.file), PNG_2x3);
    renameSync(dir, `${dir}-original`);
    symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
    await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "invalid_attachment_file",
    });
    expect(createHash("sha256").update(PNG_2x3).digest("hex")).toBe(attachment.sha256);
    await session.close();
  });

  it.skipIf(process.platform === "win32")("拒绝普通文件符号链接逃逸", async () => {
    const { session, attachment, dir } = await attachmentSession();
    const outside = path.join(tmpDir("nct-att-link-"), "image.png");
    writeFileSync(outside, PNG_2x3);
    unlinkSync(path.join(dir, attachment.file));
    symlinkSync(outside, path.join(dir, attachment.file), "file");
    await expect(session.readAttachment(attachment.file)).rejects.toMatchObject({
      code: "invalid_attachment_file",
    });
    await session.close();
  });
});
