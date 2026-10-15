import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ComposerSubmit } from "../src/Composer";
import { PhoneComposer } from "../src/web/PhoneComposer";
import {
  estimateSubmitBytes,
  IMAGE_MAX_BYTES,
  preparePhoneImage,
  REENCODE_MAX_EDGE,
  SUBMIT_MESSAGE_LIMIT,
  type ImageCodec,
  type PhoneImage,
} from "../src/web/phone-images";

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const codec = (width: number, height: number, sizes: number[] = []) => {
  const encoded: { width: number; height: number; mimeType: string; quality: number }[] = [];
  const fake: ImageCodec = {
    decode: () => Promise.resolve({ width, height, source: {} as CanvasImageSource }),
    encode: (_source, w, h, mimeType, quality) => {
      encoded.push({ width: w, height: h, mimeType, quality });
      const size = sizes[encoded.length - 1] ?? 1000;
      return Promise.resolve(new Blob([new Uint8Array(size)], { type: mimeType }));
    },
  };
  return { fake, encoded };
};

it("图片在上限内原样发送；超限或类型不支持时缩放转码并逐级降质", async () => {
  const small = new File([new Uint8Array(2000)], "a.png", { type: "image/png" });
  const plain = codec(800, 600);
  const kept = await preparePhoneImage(small, plain.fake);
  expect(kept).toMatchObject({ name: "a.png", mimeType: "image/png", width: 800 });
  expect(kept.data.length).toBe(2000);
  expect(plain.encoded).toEqual([]);

  // HEIC 等不支持的类型：转 JPEG
  const heic = new File([new Uint8Array(10)], "IMG_1.HEIC", { type: "image/heic" });
  const photo = codec(4032, 3024);
  const converted = await preparePhoneImage(heic, photo.fake);
  expect(converted).toMatchObject({ name: "IMG_1.jpg", mimeType: "image/jpeg" });
  expect(photo.encoded[0]).toMatchObject({ width: 4032, height: 3024, mimeType: "image/jpeg" });

  // 过大的 PNG：先试 PNG，超限再转 JPEG 降质
  const big = new File([new Uint8Array(IMAGE_MAX_BYTES + 1)], "shot.png", { type: "image/png" });
  const heavy = codec(2000, 1000, [IMAGE_MAX_BYTES + 10, IMAGE_MAX_BYTES + 5, 4000]);
  const shrunk = await preparePhoneImage(big, heavy.fake);
  expect(heavy.encoded.map((e) => [e.mimeType, e.quality])).toEqual([
    ["image/png", 1],
    ["image/jpeg", 0.9],
    ["image/jpeg", 0.8],
  ]);
  expect(shrunk.mimeType).toBe("image/jpeg");

  // 超过边长上限的 JPEG 也要缩
  const wide = new File([new Uint8Array(100)], "pano.jpg", { type: "image/jpeg" });
  const pano = codec(9000, 1000);
  await preparePhoneImage(wide, pano.fake);
  expect(pano.encoded[0]?.width).toBe(REENCODE_MAX_EDGE);

  const broken: ImageCodec = { ...plain.fake, decode: () => Promise.reject(new Error("x")) };
  await expect(preparePhoneImage(small, broken)).rejects.toThrow("无法读取图片");
});

it("报文估算按 base64 计附件", () => {
  const data = new Uint8Array(3 * 1024 * 1024);
  const estimate = estimateSubmitBytes("你好", [{ data, label: "a.jpg" }]);
  expect(estimate).toBeGreaterThan(4 * 1024 * 1024);
  expect(estimate).toBeLessThan(4 * 1024 * 1024 + 8192);
});

const setText = async (value: string, caret = value.length) => {
  const field = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("缺少输入框");
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.includes(label),
  );
  if (!found) throw new Error(`缺少 ${label}`);
  return found;
};
const pick = async (files: File[]) => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="选择图片"]');
  if (!input) throw new Error("缺少相册输入");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 0));
  });
};

it("图片附件随消息发出，报文超限时不发送并提示", async () => {
  const onSubmit = vi.fn((_input: ComposerSubmit) => Promise.resolve(true));
  let next = 1000;
  const prepareImage = (file: File): Promise<PhoneImage> =>
    Promise.resolve({
      name: file.name,
      data: new Uint8Array(next),
      mimeType: "image/jpeg",
      width: 10,
      height: 10,
    });
  await act(async () => {
    root?.render(
      <PhoneComposer
        variant="session"
        controls={undefined}
        running={false}
        onSubmit={onSubmit}
        onInterrupt={vi.fn()}
        onSlash={vi.fn()}
        prepareImage={prepareImage}
        getVisionHint={() => Promise.resolve("当前模型不支持图片")}
      />,
    );
  });
  await act(() => button("添加图片").click());
  expect(container.textContent).toContain("拍照");
  expect(container.textContent).toContain("选择图片");
  await pick([new File(["x"], "a.jpg", { type: "image/jpeg" })]);
  expect(container.querySelectorAll(".phone-attachment img")).toHaveLength(1);
  await vi.waitFor(() => {
    expect(container.textContent).toContain("当前模型不支持图片");
  });
  await act(async () => {
    button("发送").click();
    await Promise.resolve();
  });
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onSubmit.mock.calls[0]?.[0].attachments).toMatchObject([
    { mimeType: "image/jpeg", label: "a.jpg" },
  ]);
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-attachment")).toBeNull();
  });

  // 三张约 5 MB 的图片：base64 后超过远程单条上限
  next = Math.floor((SUBMIT_MESSAGE_LIMIT / 3) * 0.8);
  await pick([1, 2, 3].map((i) => new File(["x"], `${i}.jpg`, { type: "image/jpeg" })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("超过远程连接单条上限");
  expect(button("发送").disabled).toBe(true);
  await act(() => button("移除 3.jpg").click());
  expect(button("发送").disabled).toBe(false);
});

it("@ 文件引用用文件索引补全，普通对话不可用；输入历史填回输入框", async () => {
  const load = vi.fn(() =>
    Promise.resolve([
      { path: "src/", kind: "directory" as const },
      { path: "src/main.ts", kind: "file" as const },
      { path: "README.md", kind: "file" as const },
    ]),
  );
  const render = (fileRefs: { load: typeof load; key: number } | null) =>
    act(async () => {
      root?.render(
        <PhoneComposer
          variant="session"
          controls={undefined}
          running={false}
          onSubmit={vi.fn()}
          onInterrupt={vi.fn()}
          onSlash={vi.fn()}
          fileRefs={fileRefs}
          readInputHistory={() => Promise.resolve(["旧的一条", "最近一条"])}
        />,
      );
    });
  await render(null);
  await act(() => button("添加图片").click());
  expect(button("引用文件").disabled).toBe(true);
  await act(() => button("添加图片").click());

  await render({ load, key: 1 });
  await setText("看 @mai");
  await vi.waitFor(() => {
    expect(container.querySelector('[aria-label="文件引用补全"]')?.textContent).toContain(
      "src/main.ts",
    );
  });
  expect(load).toHaveBeenCalledOnce();
  await act(async () => {
    button("src/main.ts").click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(container.querySelector("textarea")?.value).toBe("看 @src/main.ts ");
  expect(container.querySelector('[aria-label="文件引用补全"]')).toBeNull();

  await act(() => button("更多").click());
  await act(async () => {
    button("输入历史").click();
    await Promise.resolve();
  });
  const rows = [...container.querySelectorAll(".phone-history-row")].map((r) => r.textContent);
  expect(rows).toEqual(["最近一条", "旧的一条"]);
  await act(async () => {
    button("最近一条").click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(container.querySelector("textarea")?.value).toBe("最近一条");
});
