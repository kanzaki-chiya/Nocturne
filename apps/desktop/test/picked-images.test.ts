import { describe, expect, it } from "vitest";

import { decodePickedImages, mimeTypeForImageName } from "../src/picked-images";

function frame(records: [string, Uint8Array][]): ArrayBuffer {
  const parts: number[] = [];
  const name = new TextEncoder();
  for (const [n, data] of records) {
    const nb = name.encode(n);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, nb.length, true);
    parts.push(...len, ...nb);
    const dlen = new Uint8Array(4);
    new DataView(dlen.buffer).setUint32(0, data.length, true);
    parts.push(...dlen, ...data);
  }
  return new Uint8Array(parts).buffer;
}

describe("decodePickedImages", () => {
  it("空数据返回空列表（用户取消）", () => {
    expect(decodePickedImages(new ArrayBuffer(0))).toEqual([]);
  });

  it("按记录帧解码文件名与字节", () => {
    const buf = frame([
      ["a.png", new Uint8Array([1, 2, 3])],
      ["b.jpg", new Uint8Array([])],
    ]);
    const images = decodePickedImages(buf);
    expect(images).toHaveLength(2);
    expect(images[0]?.name).toBe("a.png");
    expect(Array.from(images[0]?.data ?? [])).toEqual([1, 2, 3]);
    expect(images[1]?.name).toBe("b.jpg");
    expect(images[1]?.data).toHaveLength(0);
  });

  it("unicode 文件名正确解码", () => {
    const images = decodePickedImages(frame([["截图🌙.png", new Uint8Array([0x89])]]));
    expect(images[0]?.name).toBe("截图🌙.png");
  });

  it("截断的数据抛出错误而不是静默", () => {
    const buf = frame([["a.png", new Uint8Array([1, 2, 3])]]);
    expect(() => decodePickedImages(buf.slice(0, buf.byteLength - 2))).toThrow("图片数据格式错误");
  });
});

describe("mimeTypeForImageName", () => {
  it("按扩展名取 MIME，未知返回 undefined", () => {
    expect(mimeTypeForImageName("a.png")).toBe("image/png");
    expect(mimeTypeForImageName("B.JPEG")).toBe("image/jpeg");
    expect(mimeTypeForImageName("a.jpg")).toBe("image/jpeg");
    expect(mimeTypeForImageName("a.gif")).toBe("image/gif");
    expect(mimeTypeForImageName("a.webp")).toBe("image/webp");
    expect(mimeTypeForImageName("a.svg")).toBeUndefined();
    expect(mimeTypeForImageName("noext")).toBeUndefined();
  });
});
