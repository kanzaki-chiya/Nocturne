/**
 * 附件存储与执行器落盘（ADR-0023 第 2 节）：
 * img-<n> 编号续接、并发串行化、sha256 校验、事件只带引用。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceReadPolicy } from "../permission/index.js";
import { createPlatform, type Platform } from "../platform/index.js";
import type { ImageAttachment, ToolCallRef } from "../protocol/index.js";
import { createAttachmentStore, type AttachmentStore } from "./attachments.js";
import {
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  type ExecutionScope,
  type ToolDefinition,
} from "./index.js";

const platform: Platform = createPlatform();
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

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function makeStore(attachmentsDir: string, sessionId = "sess-1"): AttachmentStore {
  return createAttachmentStore({
    fs: platform.fs,
    paths: platform.paths,
    attachmentsDir,
    sessionId,
  });
}

describe("AttachmentStore", () => {
  it("save 写入 <attachmentsDir>/<sessionId>/img-1.png，引用含 sha256 与宽高", async () => {
    const dir = tmpDir("nct-att-");
    const store = makeStore(dir);
    const att = await store.save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "read",
      label: "x.png",
    });
    expect(att).toEqual({
      type: "image",
      file: "img-1.png",
      mimeType: "image/png",
      bytes: PNG_2x3.length,
      sha256: sha256Hex(PNG_2x3),
      width: 2,
      height: 3,
      label: "x.png",
      source: "read",
    });
    const onDisk = await platform.fs.readFile(path.join(dir, "sess-1", "img-1.png"));
    expect(onDisk).toEqual(Buffer.from(PNG_2x3));
  });

  it("编号从目录已有文件续接：img-1.png/img-7.jpg 存在时新存储首张为 img-8", async () => {
    const dir = tmpDir("nct-att-");
    const sd = path.join(dir, "sess-1");
    await platform.fs.mkdir(sd);
    await platform.fs.writeFile(path.join(sd, "img-1.png"), PNG_2x3);
    await platform.fs.writeFile(path.join(sd, "img-7.jpg"), PNG_2x3);
    const store = makeStore(dir);
    const att = await store.save({ data: PNG_2x3, mimeType: "image/png", source: "paste" });
    expect(att.file).toBe("img-8.png");
  });

  it("并发两次 save 不抢号：img-1 / img-2", async () => {
    const dir = tmpDir("nct-att-");
    const store = makeStore(dir);
    const [a, b] = await Promise.all([
      store.save({ data: PNG_2x3, mimeType: "image/png", source: "read" }),
      store.save({ data: PNG_2x3, mimeType: "image/jpeg", source: "read" }),
    ]);
    expect(new Set([a.file, b.file])).toEqual(new Set(["img-1.png", "img-2.jpg"]));
  });

  it("load：命中返回字节；文件缺失或 sha256 不符 → undefined", async () => {
    const dir = tmpDir("nct-att-");
    const store = makeStore(dir);
    const att = await store.save({ data: PNG_2x3, mimeType: "image/png", source: "read" });
    // 缓存命中与磁盘读取的统一比较口径：读回值统一转 Buffer 再比
    const asBuf = (d: Uint8Array | undefined) => (d === undefined ? undefined : Buffer.from(d));
    expect(asBuf(await store.load(att))).toEqual(Buffer.from(PNG_2x3));
    // 绕过缓存的新实例：从磁盘读
    const fresh = makeStore(dir);
    expect(asBuf(await fresh.load(att))).toEqual(Buffer.from(PNG_2x3));
    // 引用指向不存在的文件 → undefined（注意缓存按 sha256 命中优先，
    // 需要一个没见过该 sha 的实例来走磁盘路径）
    expect(await makeStore(dir).load({ ...att, file: "img-99.png" })).toBeUndefined();
    // 篡改文件内容 → sha 不符
    await platform.fs.writeFile(path.join(dir, "sess-1", att.file), new Uint8Array([1, 2, 3]));
    const again = makeStore(dir);
    expect(await again.load(att)).toBeUndefined();
  });
});

// ── 执行器落盘 ────────────────────────────────────────────

interface Captured {
  type: string;
  payload: Record<string, unknown>;
}

const imgTool: ToolDefinition = {
  name: "imgtool",
  description: "returns an image attachment",
  inputSchema: { type: "object" },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 5_000 },
  permissionSubjects: () => [],
  execute: () =>
    Promise.resolve({
      status: "ok",
      modelContent: "Image file: pic.png (image/png, 2×3, 29 B)",
      attachments: [{ mimeType: "image/png", data: PNG_2x3, label: "pic.png" }],
    }),
};

async function makeScope(
  ws: string,
  opts: { attachments?: AttachmentStore; diagnostics?: ExecutionScope["diagnostics"] } = {},
): Promise<{ scope: ExecutionScope; events: Captured[] }> {
  const workspaceRoot = await platform.resolveReal(ws);
  const policy = createWorkspaceReadPolicy({
    workspaceRoot,
    caseSensitive: platform.caseSensitivePaths,
  });
  const events: Captured[] = [];
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot,
    paths: platform.paths,
    sessionId: "sess-1",
    turnId: "turn-1",
    signal: new AbortController().signal,
    platform,
    gate: createPolicyGate(policy),
    readState: createReadStateStore(platform.paths),
    events: {
      emit: (type, payload) => {
        events.push({ type, payload: payload as unknown as Captured["payload"] });
        return Promise.resolve();
      },
      emitEphemeral: () => undefined,
    },
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
    ...(opts.diagnostics !== undefined ? { diagnostics: opts.diagnostics } : {}),
  };
  return { scope, events };
}

const executor = () => {
  const r = createToolRegistry();
  r.register(imgTool);
  return createToolExecutor(r);
};

const call = (callId = "c1"): ToolCallRef => ({ callId, name: "imgtool", input: {} });

describe("执行器附件落盘（ADR-0023）", () => {
  it("结果带附件 → 文件落盘、tool.completed.attachments 只有引用", async () => {
    const ws = tmpDir("nct-att-ws-");
    const attachmentsDir = tmpDir("nct-att-");
    const { scope, events } = await makeScope(ws, { attachments: makeStore(attachmentsDir) });
    const r = await executor().execute(call(), scope);
    expect(r.status).toBe("ok");

    const done = events.find((e) => e.type === "tool.completed");
    const refs = done?.payload.attachments as ImageAttachment[] | undefined;
    expect(refs).toHaveLength(1);
    expect(refs?.[0]?.file).toBe("img-1.png");
    expect(refs?.[0]?.sha256).toBe(sha256Hex(PNG_2x3));
    expect(refs?.[0]?.source).toBe("read");
    // 事件里没有字节：payload 序列化不含 data 字段与 base64 形态
    const json = JSON.stringify(done?.payload);
    expect(json).not.toContain('"data"');
    expect(json).not.toContain(Buffer.from(PNG_2x3).toString("base64").slice(0, 16));
    // 落盘文件存在且字节一致
    const onDisk = await platform.fs.readFile(path.join(attachmentsDir, "sess-1", "img-1.png"));
    expect(onDisk).toEqual(Buffer.from(PNG_2x3));
  });

  it("save 抛错：仍恰好一个 tool.completed，modelContent 注明并记诊断", async () => {
    const ws = tmpDir("nct-att-ws-");
    const failing: AttachmentStore = {
      save: () => Promise.reject(new Error("disk full")),
      load: () => Promise.resolve(undefined),
    };
    const diag: { kind: string; data: Record<string, unknown> | undefined }[] = [];
    const { scope, events } = await makeScope(ws, {
      attachments: failing,
      diagnostics: { record: (kind, data) => diag.push({ kind, data }) },
    });
    await executor().execute(call(), scope);
    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload.attachments).toBeUndefined();
    expect(String(completed[0]?.payload.modelContent)).toContain("图片附件保存失败：disk full");
    expect(diag.some((d) => d.kind === "tool.attachment_failed")).toBe(true);
  });

  it("store 缺失：降级注明附件目录不可用，事件不带 attachments", async () => {
    const ws = tmpDir("nct-att-ws-");
    const diag: { kind: string }[] = [];
    const { scope, events } = await makeScope(ws, {
      diagnostics: { record: (kind) => diag.push({ kind }) },
    });
    await executor().execute(call(), scope);
    const done = events.find((e) => e.type === "tool.completed");
    expect(done?.payload.attachments).toBeUndefined();
    expect(String(done?.payload.modelContent)).toContain("附件目录不可用");
    expect(diag.some((d) => d.kind === "tool.attachment_failed")).toBe(true);
  });
});
