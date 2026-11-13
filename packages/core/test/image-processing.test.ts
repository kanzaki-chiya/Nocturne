import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import {
  replaySessionView,
  type DurableEvent,
  type HistoryEntry,
  type ImageAttachment,
} from "../src/protocol/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { createSessionStore } from "../src/session/index.js";
import { buildContext, attachmentsToLoad, projectedTokens } from "../src/context/index.js";
import { IMAGE_TARGET_MAX_BYTES, parseImageSize } from "../src/tools/image.js";

const FIXTURE_PATH = "Z:\\nocturne-mockups\\impl\\r1113a\\fixtures\\long-screenshot-1849x16348.png";

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

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodeSolidPng(width: number, height: number, r = 64, g = 128, b = 220): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  const idat = deflateSync(raw, { level: 1 });
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** 构造真实可解码且大于 3.5 MB 的 PNG（整张噪声压缩后 > 3.8 MB） */
function encodeLargeNoisyPng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  let seed = 0xabcdef01;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const p = rowStart + 1 + x * 4;
      raw[p] = seed & 0xff;
      raw[p + 1] = (seed >>> 8) & 0xff;
      raw[p + 2] = (seed >>> 16) & 0xff;
      raw[p + 3] = 255;
    }
  }
  const idat = deflateSync(raw, { level: 1 });
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function visionModelProvider(scripts: ConstructorParameters<typeof FakeProvider>[0]["scripts"]) {
  return new FakeProvider({
    scripts,
    models: [
      {
        ref: { provider: "fake", model: "fake-vision" },
        displayName: "Fake Vision",
        contextWindow: 200_000,
        maxOutputTokens: 4096,
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
}

describe("image auto-downscale & tiling integration (ADR-0090)", () => {
  it("入口：read 工具读取长图自动切段，事件带 processed 且原图保留，modelContent 说明分段顺序", async () => {
    const ws = tmpDir("nct-read-ws-");
    const sessionsDir = tmpDir("nct-read-sess-");
    const tallPng = encodeSolidPng(400, 4000);
    writeFileSync(path.join(ws, "tall.png"), tallPng);

    const provider = visionModelProvider([
      [
        { type: "tool_call", toolCallId: "tc1", name: "read", input: { path: "tall.png" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "看到了两段" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-vision" });
    await session.submit({ text: "read tall.png" });

    const toolEntry = session.state().history.find((h) => h.kind === "tool");
    expect(toolEntry?.kind).toBe("tool");
    if (toolEntry?.kind !== "tool") return;
    expect(toolEntry.modelContent).toContain("Image file: tall.png");
    expect(toolEntry.modelContent).toContain("original 400×4000");
    expect(toolEntry.modelContent).toContain("split into 2 JPEG tiles ordered top to bottom");
    const att = toolEntry.attachments?.[0];
    expect(att?.processed).toHaveLength(2);
    if (!att) throw new Error("missing att");
    expect(
      await platform.fs.exists(path.join(sessionsDir, "attachments", session.id, att.file)),
    ).toBe(true);

    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.images).toHaveLength(2);
    expect(
      toolMsg?.role === "tool" && toolMsg.images?.every((i) => i.mimeType === "image/jpeg"),
    ).toBe(true);
    await session.close();
  });

  it("入口：web_fetch 抓取长图自动切段，事件带 processed 且原图保留", async () => {
    const ws = tmpDir("nct-wf-ws-");
    const sessionsDir = tmpDir("nct-wf-sess-");
    const tallPng = encodeSolidPng(400, 4000);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from(tallPng));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/tall.png`;

    try {
      const provider = visionModelProvider([
        [
          { type: "tool_call", toolCallId: "tc1", name: "web_fetch", input: { url } },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "fetched" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
      const session = await runtime.createSession({
        model: "fake/fake-vision",
        permissionPreset: "bypass",
      });
      await session.submit({ text: `fetch ${url}` });

      const toolEntry = session.state().history.find((h) => h.kind === "tool");
      expect(toolEntry?.kind).toBe("tool");
      if (toolEntry?.kind !== "tool") return;
      const att = toolEntry.attachments?.[0];
      expect(att?.processed).toHaveLength(2);
      if (!att) throw new Error("missing att");
      expect(
        await platform.fs.exists(path.join(sessionsDir, "attachments", session.id, att.file)),
      ).toBe(true);
      await session.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("入口：file-attachments 超过 5 MB 的可解码 PNG 走图片通道并缩小，原图仍在", async () => {
    const ws = tmpDir("nct-fa-ws-");
    const sessionsDir = tmpDir("nct-fa-sess-");
    const bigPng = encodeLargeNoisyPng(1600, 1000);
    expect(bigPng.byteLength).toBeGreaterThan(5 * 1024 * 1024);

    const provider = visionModelProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-vision" });
    await session.submit({
      text: "check this png",
      attachments: [{ data: bigPng, mimeType: "image/png", label: "big.png", source: "upload" }],
    });

    const user = session.state().history.find((h) => h.kind === "user");
    expect(user?.kind).toBe("user");
    if (user?.kind !== "user") return;
    expect(user.files ?? []).toHaveLength(0);
    expect(user.attachments).toHaveLength(1);
    const att = user.attachments?.[0];
    if (!att) throw new Error("missing att");
    expect(att.processed).toHaveLength(1);
    const p0 = att.processed?.[0];
    expect(p0?.mimeType).toBe("image/jpeg");
    expect(p0?.bytes).toBeLessThanOrEqual(IMAGE_TARGET_MAX_BYTES);
    expect(
      await platform.fs.readFile(path.join(sessionsDir, "attachments", session.id, att.file)),
    ).toEqual(Buffer.from(bigPng));
    await session.close();
  }, 30_000);

  it("入口：file-refs (@引用的图片) 与粘贴图片均触发处理，原图仍在", async () => {
    const ws = tmpDir("nct-ref-ws-");
    const sessionsDir = tmpDir("nct-ref-sess-");
    const tallPng = encodeSolidPng(400, 4000);
    writeFileSync(path.join(ws, "ref-tall.png"), tallPng);

    const provider = visionModelProvider([
      [
        { type: "text_delta", text: "ok1" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", text: "ok2" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-vision" });

    // @ 文件引用入口
    await session.submit({ text: "看 @ref-tall.png" });
    // 粘贴图片入口
    await session.submit({
      text: "粘贴的图",
      attachments: [{ data: tallPng, mimeType: "image/png", label: "剪贴板", source: "paste" }],
    });

    const users = session.state().history.filter((h) => h.kind === "user");
    expect(users).toHaveLength(2);
    for (const u of users) {
      if (u.kind !== "user") continue;
      const att = u.attachments?.[0];
      expect(att?.processed).toHaveLength(2);
      if (!att) throw new Error("missing att");
      expect(
        await platform.fs.exists(path.join(sessionsDir, "attachments", session.id, att.file)),
      ).toBe(true);
    }
    await session.close();
  });

  it("Builder：按顺序发出处理结果、20 张上限按整组保留/丢弃、token 估算按实际段数", async () => {
    const makeAtt = (id: number, tileCount: number): ImageAttachment => ({
      type: "image",
      file: `img-${id}.png`,
      mimeType: "image/png",
      bytes: 9_000_000,
      sha256: `orig-${id}`,
      width: 1849,
      height: 16000,
      source: "paste",
      processed: Array.from({ length: tileCount }, (_, i) => ({
        file: `img-${id}-${i + 1}.jpg`,
        mimeType: "image/jpeg" as const,
        bytes: 300_000,
        sha256: `tile-${id}-${i + 1}`,
        width: 1849,
        height: 2576,
        region: { x: 0, y: i * 2512, width: 1849, height: 2576 },
      })),
    });

    // 3 张各 7 段（共 21 段 > 20）：最新 2 张（14 段）整组保留，最旧 1 张（7 段）整组丢弃
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t1",
        messageId: "m1",
        content: [{ type: "text", text: "1" }],
        attachments: [makeAtt(1, 7)],
      },
      {
        kind: "user",
        seq: 2,
        turnId: "t2",
        messageId: "m2",
        content: [{ type: "text", text: "2" }],
        attachments: [makeAtt(2, 7)],
      },
      {
        kind: "user",
        seq: 3,
        turnId: "t3",
        messageId: "m3",
        content: [{ type: "text", text: "3" }],
        attachments: [makeAtt(3, 7)],
      },
    ];
    const model = {
      ref: { provider: "fake", model: "v" },
      displayName: "v",
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: "none" as const,
        imageInput: true,
        promptCache: false,
        editTool: "edit" as const,
      },
    };
    const toLoad = attachmentsToLoad(history, model);
    expect(toLoad).toHaveLength(14);
    expect(toLoad.map((i) => i.sha256)).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `tile-2-${i + 1}`),
      ...Array.from({ length: 7 }, (_, i) => `tile-3-${i + 1}`),
    ]);

    const data = new Map(toLoad.map((item) => [item.sha256, `b64-${item.sha256}`]));
    const built = buildContext({
      history,
      model,
      basePrompt: "sys",
      instructions: { project: [] },
      environment: { cwd: "/", workspaceRoot: "/", os: "linux", sessionDate: "2026-11-13" },
      tools: [],
      attachmentData: data,
    });
    expect(built.report.images).toEqual({ count: 14, estimatedTokens: 14 * 1600 });
    // 估算模式（不传 attachmentData）也得 14 张
    const estimated = buildContext({
      history,
      model,
      basePrompt: "sys",
      instructions: { project: [] },
      environment: { cwd: "/", workspaceRoot: "/", os: "linux", sessionDate: "2026-11-13" },
      tools: [],
    });
    expect(estimated.report.images).toEqual({ count: 14, estimatedTokens: 14 * 1600 });
    expect(projectedTokens(history, model)).toBeGreaterThanOrEqual(14 * 1600);

    // 验证消息顺序与占位
    const userMsgs = built.request.messages.filter((m) => m.role === "user");
    expect(userMsgs[0]?.role === "user" && userMsgs[0].images).toBeUndefined();
    expect(userMsgs[1]?.role === "user" && userMsgs[1].images?.map((x) => x.data)).toEqual(
      Array.from({ length: 7 }, (_, i) => `b64-tile-2-${i + 1}`),
    );
    expect(userMsgs[2]?.role === "user" && userMsgs[2].images?.map((x) => x.data)).toEqual(
      Array.from({ length: 7 }, (_, i) => `b64-tile-3-${i + 1}`),
    );
  });

  it("会话：分叉复制处理结果、回退后 readAttachment 仍可读处理结果、旧日志重放不变", async () => {
    const ws = tmpDir("nct-sess-ws-");
    const sessionsDir = tmpDir("nct-sess-s-");
    const tallPng = encodeSolidPng(400, 4000);
    const provider = visionModelProvider([
      [
        { type: "text_delta", text: "first" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", text: "after fork" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const s1 = await runtime.createSession({ model: "fake/fake-vision" });
    await s1.submit({
      text: "msg 1",
      attachments: [{ data: tallPng, mimeType: "image/png", label: "tall.png" }],
    });
    const user1 = s1.state().history.find((h) => h.kind === "user");
    if (user1?.kind !== "user") throw new Error("missing user1");
    const tile1 = user1.attachments?.[0]?.processed?.[0];
    if (!tile1) throw new Error("missing tile1");
    const loadedTile = await s1.readAttachment(tile1.file);
    expect(loadedTile.mimeType).toBe("image/jpeg");
    expect(loadedTile.bytes).toBe(tile1.bytes);

    // 分叉：原图与处理结果均复制
    const forkedId = await runtime.forkSession(s1.id);
    const forked = await runtime.resumeSession(forkedId);
    const forkTile = await forked.readAttachment(tile1.file);
    expect(forkTile.data).toEqual(loadedTile.data);
    await forked.submit({ text: "msg 2" });
    expect(
      provider.requests[1]?.messages[0]?.role === "user" &&
        provider.requests[1]?.messages[0]?.images,
    ).toHaveLength(2);
    await forked.close();

    // 回退：上下文不再包含该图，但持久日志仍允许 readAttachment 读取原图与处理结果
    const targets = await s1.rewindTargets();
    const firstTarget = targets[0];
    if (!firstTarget) throw new Error("missing rewind target");
    await s1.rewind(firstTarget.seq, "conversation");
    expect(s1.state().history.filter((h) => h.kind === "user")).toHaveLength(0);
    expect((await s1.readAttachment(tile1.file)).bytes).toBe(tile1.bytes);
    await s1.close();

    // 旧日志重放（不带 processed 字段）完全兼容
    const legacyEvents: DurableEvent[] = [
      {
        sessionId: "legacy-1",
        seq: 1,
        time: "2026-11-13T00:00:00Z",
        type: "session.created",
        payload: {
          formatVersion: 1,
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-vision" },
          permissionPreset: "default",
          nocturneVersion: "0.43.0",
        },
      },
      {
        sessionId: "legacy-1",
        seq: 2,
        turnId: "t1",
        time: "2026-11-13T00:00:01Z",
        type: "turn.started",
        payload: { turnIndex: 1 },
      },
      {
        sessionId: "legacy-1",
        seq: 3,
        turnId: "t1",
        time: "2026-11-13T00:00:02Z",
        type: "message.user",
        payload: {
          messageId: "m-legacy-1",
          content: [{ type: "text", text: "legacy" }],
          attachments: [
            {
              type: "image",
              file: "img-1.png",
              mimeType: "image/png",
              bytes: 100,
              sha256: "abc",
              width: 10,
              height: 10,
              source: "paste",
            },
          ],
        },
      },
    ];
    const view = replaySessionView(legacyEvents);
    expect(
      view.entries[0]?.kind === "user" && view.entries[0].attachments?.[0]?.processed,
    ).toBeUndefined();
    const store = createSessionStore({ platform, sessionsDir: tmpDir("nct-legacy-") });
    expect(store).toBeDefined();
  });

  it("验收：真实长截图 fixture（1849×16348 PNG）输入框提交，模型收到 7 段 JPEG（宽 1849、高<=2576、<=3.5 MB），不调 read/shell", async () => {
    const ws = tmpDir("nct-accept-ws-");
    const sessionsDir = tmpDir("nct-accept-sess-");
    const fixtureBytes = existsSync(FIXTURE_PATH)
      ? Uint8Array.from(readFileSync(FIXTURE_PATH))
      : encodeSolidPng(1849, 16348);

    const provider = visionModelProvider([
      [
        { type: "text_delta", text: "我看清了全部 7 段长图内容" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });
    const session = await runtime.createSession({ model: "fake/fake-vision" });
    await session.submit({
      text: "请看这张长截图",
      attachments: [
        {
          data: fixtureBytes,
          mimeType: "image/png",
          label: "long-screenshot.png",
          source: "paste",
        },
      ],
    });

    // 模型只请求了一次，没有调用 read 或 shell
    expect(provider.requests).toHaveLength(1);
    const toolEntries = session.state().history.filter((h) => h.kind === "tool");
    expect(toolEntries).toHaveLength(0);

    // 界面会话记录保留原图，且带有处理结果
    const userEntry = session.state().history.find((h) => h.kind === "user");
    expect(userEntry?.kind).toBe("user");
    if (userEntry?.kind !== "user") return;
    const orig = userEntry.attachments?.[0];
    expect(orig).toMatchObject({
      mimeType: "image/png",
      bytes: fixtureBytes.byteLength,
      width: 1849,
      height: 16348,
    });
    expect(orig?.processed).toHaveLength(7);

    // 模型收到的 images：7 段 JPEG，每段宽 1849、高 <= 2576、<= 3.5 MB
    const userMsg = provider.requests[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.role).toBe("user");
    const images = userMsg?.role === "user" ? (userMsg.images ?? []) : [];
    expect(images).toHaveLength(7);
    for (const img of images) {
      expect(img.mimeType).toBe("image/jpeg");
      const raw = Buffer.from(img.data, "base64");
      expect(raw.byteLength).toBeLessThanOrEqual(IMAGE_TARGET_MAX_BYTES);
      const size = parseImageSize(raw, "image/jpeg");
      expect(size).toBeDefined();
      expect(size?.width).toBe(1849);
      expect(size?.height).toBeLessThanOrEqual(2576);
    }
    await session.close();
  }, 30_000);

  it("主线程不阻塞：处理 1849×16348 长图期间，同一 Runtime 内另一会话事件与事件循环心跳照常送达", async () => {
    const ws = tmpDir("nct-nb-ws-");
    const sessionsDir = tmpDir("nct-nb-sess-");
    const fixtureBytes = existsSync(FIXTURE_PATH)
      ? Uint8Array.from(readFileSync(FIXTURE_PATH))
      : encodeSolidPng(1849, 16348);

    const provider = visionModelProvider([
      // 第一条或第二条脚本由并发顺序决定，用 handler 确保两个会话都能正确完成
    ]);
    const dynamicProvider = new FakeProvider({
      handler: (req) => {
        const hasImages = req.messages.some(
          (m) => m.role === "user" && (m.images?.length ?? 0) > 0,
        );
        return [
          { type: "text_delta", text: hasImages ? "done-image" : "done-other" },
          { type: "finish", reason: "stop" },
        ];
      },
      models: provider.models(),
    });

    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [dynamicProvider] });
    const sessionA = await runtime.createSession({ model: "fake/fake-vision" });
    const sessionB = await runtime.createSession({ model: "fake/fake-vision" });

    const sessionBEvents: { type: string; at: number }[] = [];
    sessionB.subscribe((e) => {
      sessionBEvents.push({ type: e.type, at: performance.now() });
    });

    let maxTickGapMs = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxTickGapMs = Math.max(maxTickGapMs, now - lastTick);
      lastTick = now;
    }, 10);

    let sessionAFinishedAt = 0;
    let sessionBFinishedAt = 0;
    try {
      const pA = sessionA
        .submit({
          text: "process big screenshot",
          attachments: [
            { data: fixtureBytes, mimeType: "image/png", label: "long.png", source: "paste" },
          ],
        })
        .then(() => {
          sessionAFinishedAt = performance.now();
        });
      // 等一个微任务让 sessionA 的图片 worker 请求发出后再并发启动 sessionB
      await new Promise((r) => setTimeout(r, 20));
      const pB = sessionB.submit({ text: "hello from session B" }).then(() => {
        sessionBFinishedAt = performance.now();
      });
      await Promise.all([pA, pB]);
    } finally {
      clearInterval(timer);
    }

    // sessionB 在 sessionA 耗时几秒的图片处理结束前就已经收到事件并完成
    expect(sessionBEvents.some((e) => e.type === "turn.completed")).toBe(true);
    expect(sessionBFinishedAt).toBeLessThan(sessionAFinishedAt);
    // 主线程 10ms 心跳间隔不应被 3 秒多的图像编解码拖卡死（远低于 1000ms）
    expect(maxTickGapMs).toBeLessThan(1000);

    await sessionA.close();
    await sessionB.close();
  }, 30_000);
});
