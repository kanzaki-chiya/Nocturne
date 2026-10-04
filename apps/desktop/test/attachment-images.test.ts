import { webcrypto } from "node:crypto";
import type { ReadAttachmentResult } from "@nocturne/core";
import type { ImageAttachment } from "@nocturne/core/protocol";
import { createMemoryTransportPair, createRpcClient, type RpcSession } from "@nocturne/rpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAttachmentImageSource } from "../src/attachment-images";

const data = new Uint8Array([1, 2, 3]);
const attachment: ImageAttachment = {
  type: "image",
  file: "history.png",
  mimeType: "image/png",
  bytes: 3,
  sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  source: "paste",
};

function sessionFixture() {
  return {
    readAttachment: vi.fn<RpcSession["readAttachment"]>().mockResolvedValue({
      data,
      mimeType: "image/png",
      bytes: data.byteLength,
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:attachment"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("AttachmentImageSource", () => {
  it("register 按 sha256 缓存，缓存命中不回读 RPC", async () => {
    const images = createAttachmentImageSource();
    const session = sessionFixture();
    const url = await images.register(data, "image/png");
    expect(images.url(attachment)).toBe(url);
    expect(await images.register(data, "image/png")).toBe(url);
    expect(await images.load({ ...attachment, file: "fork-copy.png" }, session)).toBe(url);
    expect(session.readAttachment).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    images.dispose();
  });

  it("真实 RpcSession 解码线上 base64 后供图片源生成 blob", async () => {
    const [transport, server] = createMemoryTransportPair();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    server.onLine((line) => {
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(request);
      if (request.method !== "initialize" && request.method !== "session.readAttachment") {
        throw new Error(`未处理 RPC 方法 ${request.method}`);
      }
      server.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "initialize"
              ? { protocolVersion: 1, nocturneVersion: "test" }
              : { data: "AQID", mimeType: "image/png", bytes: 3 },
        }),
      );
    });
    const client = createRpcClient(transport, { clientName: "desktop-images-test" });
    await client.initialize();
    const images = createAttachmentImageSource();
    expect(await images.load(attachment, client.session("history-session"))).toBe(
      "blob:attachment",
    );
    expect(calls.find((call) => call.method === "session.readAttachment")?.params).toEqual({
      sessionId: "history-session",
      file: "history.png",
    });
    expect(images.url(attachment)).toBe("blob:attachment");
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]?.[0]).toHaveProperty("size", 3);
    images.dispose();
    client.close();
  });

  it("未命中调用当前会话 readAttachment(file)，同 sha256 在途读取去重", async () => {
    const images = createAttachmentImageSource();
    const session = sessionFixture();
    let finish!: (result: ReadAttachmentResult) => void;
    session.readAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = images.load(attachment, session);
    const second = images.load({ ...attachment, file: "same-bytes.png" }, session);
    expect(first).toBe(second);
    expect(session.readAttachment).toHaveBeenCalledExactlyOnceWith("history.png");
    finish({ data, mimeType: "image/png", bytes: 3 });
    expect(await first).toBe("blob:attachment");
    expect(images.url(attachment)).toBe("blob:attachment");
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("image/png");
    expect((blob as Blob).size).toBe(3);
    images.dispose();
  });

  it("失败透传具体原因，并释放在途项，不污染成功缓存", async () => {
    const images = createAttachmentImageSource();
    const session = sessionFixture();
    session.readAttachment.mockRejectedValueOnce(new Error("附件文件缺失：history.png"));
    await expect(images.load(attachment, session)).rejects.toThrow("附件文件缺失：history.png");
    expect(images.url(attachment)).toBeUndefined();
    expect(await images.load(attachment, session)).toBe("blob:attachment");
    expect(session.readAttachment).toHaveBeenCalledTimes(2);
    images.dispose();
  });

  it("dispose 回收全部 URL，卸载后返回的读取不再创建 URL", async () => {
    const images = createAttachmentImageSource();
    await images.register(data, "image/png");
    const session = sessionFixture();
    let finish!: (result: ReadAttachmentResult) => void;
    session.readAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = images.load({ ...attachment, sha256: "other" }, session);
    images.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:attachment");
    expect(images.url(attachment)).toBeUndefined();
    finish({ data, mimeType: "image/png", bytes: 3 });
    await expect(loading).rejects.toThrow("图片缓存已释放");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    images.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("dispose 后的在途 register 哈希不再创建 URL，下一次挂载可以重新登记", async () => {
    const images = createAttachmentImageSource();
    const registering = images.register(data, "image/png");
    images.dispose();
    await expect(registering).rejects.toThrow("图片缓存已释放");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(await images.register(data, "image/png")).toBe("blob:attachment");
    images.dispose();
  });
});
