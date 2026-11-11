// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  type ImageAttachment,
  type SessionView,
  type ToolEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { createAttachmentImageSource, type AttachmentImageSource } from "../src/attachment-images";
import { Composer } from "../src/Composer";
import { Conversation, type ReadOnlyConversationProps } from "../src/Conversation";
import { ImageViewer, ImageViewerProvider } from "../src/ImageViewer";
import { SidePanel, type SidePanelProps } from "../src/SidePanel";
import type { FileTab } from "../src/side-panel";
import { PhoneComposer } from "../src/web/PhoneComposer";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { PhonePush } from "../src/web/push";
import { appPlatform } from "../../android/src/platform";
import { shellHost } from "../../android/src/host";

let urlSeq = 0;
const visibilityObservers: {
  callback: IntersectionObserverCallback;
}[] = [];

beforeEach(() => {
  urlSeq = 0;
  visibilityObservers.length = 0;
  vi.stubGlobal("crypto", webcrypto);
  URL.createObjectURL = vi.fn(() => `blob:iv-${++urlSeq}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        visibilityObservers.push({ callback });
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function enterAllViewports() {
  act(() => {
    for (const obs of visibilityObservers) {
      obs.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
  });
}

function makeAttachment(n: number, label?: string): ImageAttachment {
  const hex = n.toString(16).padStart(64, "0");
  return {
    type: "image",
    file: `img-${n}.png`,
    label: label ?? `照片${n}.png`,
    mimeType: "image/png",
    bytes: 4,
    sha256: hex,
    source: "paste",
  };
}

function makeReadOnlyProps(
  view: SessionView,
  images: AttachmentImageSource,
  readAttachment?: RpcSession["readAttachment"],
): ReadOnlyConversationProps {
  return {
    session: {
      id: "s-iv",
      readOnly: true,
      readAttachment:
        readAttachment ??
        vi.fn(async (file: string) => ({
          data: new Uint8Array([file.charCodeAt(4) || 1, 2, 3, 4]),
          mimeType: "image/png",
          bytes: 4,
        })),
    },
    readOnly: { frozen: false },
    view,
    openUrl: vi.fn(),
    cwd: "Z:/proj",
    subscribeEvents: () => () => undefined,
    images,
    busy: false,
  };
}

function parseScale(transform: string): number {
  const match = /scale\(([^)]+)\)/.exec(transform);
  if (!match) throw new Error(`missing scale in transform: ${transform}`);
  return Number(match[1]);
}

function parseTranslate(transform: string): { tx: number; ty: number } {
  const matches = [...transform.matchAll(/translate\(([^,)]+)px,\s*([^)]+)px\)/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`missing translate in transform: ${transform}`);
  return { tx: Number(last[1]), ty: Number(last[2]) };
}

describe("ImageViewer", () => {
  it("点用户消息第 2 张图打开，计数为 2 / 4；方向键与按钮切换并循环；单张图无箭头和计数", async () => {
    const images = createAttachmentImageSource();
    const list = [1, 2, 3, 4].map((n) => makeAttachment(n));
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u-4",
        seq: 1,
        turnId: "t1",
        content: [{ type: "text", text: "四张图" }],
        attachments: list,
      },
      {
        kind: "user",
        key: "u-1",
        seq: 2,
        turnId: "t2",
        content: [{ type: "text", text: "单张图" }],
        attachments: [makeAttachment(9, "单张图.png")],
      },
    ];
    render(<Conversation {...makeReadOnlyProps(view, images)} />);
    enterAllViewports();

    const secondThumb = await screen.findByRole("button", { name: "照片2.png" });
    fireEvent.click(secondThumb);

    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("image-viewer")).toBe(true);
    expect(dialog.textContent).toBe("2 / 4");
    expect(within(dialog).getByRole("img").getAttribute("alt")).toBe("照片2.png");

    // 右方向键 -> 3 / 4 -> 4 / 4 -> 循环回 1 / 4
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(dialog.textContent).toBe("3 / 4");
    fireEvent.click(within(dialog).getByRole("button", { name: "下一张" }));
    expect(dialog.textContent).toBe("4 / 4");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(dialog.textContent).toBe("1 / 4");

    // 左方向键与上一张按钮反向循环 -> 4 / 4 -> 3 / 4
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(dialog.textContent).toBe("4 / 4");
    fireEvent.click(within(dialog).getByRole("button", { name: "上一张" }));
    expect(dialog.textContent).toBe("3 / 4");

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // 打开单张图：没有左右箭头和计数，textContent 为空
    const singleThumb = await screen.findByRole("button", { name: "单张图.png" });
    fireEvent.click(singleThumb);
    const singleDialog = screen.getByRole("dialog");
    expect(within(singleDialog).queryByRole("button", { name: "上一张" })).toBeNull();
    expect(within(singleDialog).queryByRole("button", { name: "下一张" })).toBeNull();
    expect(singleDialog.querySelector(".iv-count")).toBeNull();
    expect(singleDialog.textContent).toBe("");

    images.dispose();
  });

  it("工具结果的图与用户消息的图各自成组，互不混入", async () => {
    const images = createAttachmentImageSource();
    const userImgs = [makeAttachment(1, "用户1.png"), makeAttachment(2, "用户2.png")];
    const toolImg = makeAttachment(3, "工具截图.png");
    const toolEntry: ToolEntry = {
      kind: "tool",
      key: "tool-1",
      turnId: "t1",
      seq: 2,
      callId: "c1",
      name: "read",
      status: "ok",
      input: { path: "Z:/proj/shot.png" },
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: {
        status: "ok",
        error: undefined,
        durationMs: 5,
        output: undefined,
        truncated: false,
        spillPath: undefined,
        modelContent: "ok",
        attachments: [toolImg],
      },
    };
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u1",
        seq: 1,
        turnId: "t1",
        content: [{ type: "text", text: "看" }],
        attachments: userImgs,
      },
      toolEntry,
    ];
    render(<Conversation {...makeReadOnlyProps(view, images)} />);
    enterAllViewports();

    // 展开工具详情点工具图：单张独立成组，不含用户消息的两张图
    fireEvent.click(screen.getByLabelText("工具详细信息"));
    const toolThumb = await screen.findByRole("button", { name: "工具截图.png" });
    fireEvent.click(toolThumb);
    const toolDialog = screen.getByRole("dialog");
    expect(toolDialog.textContent).toBe("");
    expect(within(toolDialog).queryByRole("button", { name: "下一张" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // 点用户消息第 1 张：组内只有 2 张（1 / 2），不含工具图
    const userThumb = await screen.findByRole("button", { name: "用户1.png" });
    fireEvent.click(userThumb);
    const userDialog = screen.getByRole("dialog");
    expect(userDialog.textContent).toBe("1 / 2");
    images.dispose();
  });

  it("Esc、点空白、点关闭按钮都能关闭并把焦点还给原缩略图；点图片本身或拖动结束不关闭", () => {
    const items = [
      { src: "blob:one", filename: "one.png", alt: "图一" },
      { src: "blob:two", filename: "two.png", alt: "图二" },
    ];
    function Harness() {
      return (
        <ImageViewerProvider>
          <Trigger />
        </ImageViewerProvider>
      );
    }
    function Trigger() {
      const ref = { current: null as HTMLButtonElement | null };
      return <ConversationThumbHarness items={items} buttonRef={(el) => (ref.current = el)} />;
    }
    render(<Harness />);
    const thumb = screen.getByRole("button", { name: "打开缩略图" });

    // 1. Esc 关闭并恢复焦点；打开时焦点进入查看器内部且 Tab 被困在里面
    thumb.focus();
    fireEvent.click(thumb);
    let dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const buttons = within(dialog).getAllByRole("button");
    buttons[buttons.length - 1]?.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    // 点图片本身不关闭
    const img = within(dialog).getByRole("img");
    fireEvent.click(img);
    expect(screen.getByRole("dialog")).toBe(dialog);

    // 放大后拖动到空白松手不算点击，不关闭
    const stage = dialog.querySelector<HTMLElement>(".iv-stage");
    if (!stage) throw new Error("missing stage");
    fireEvent.wheel(stage, { deltaY: -500, clientX: 400, clientY: 300 });
    fireEvent.pointerDown(stage, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 400,
      clientY: 300,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 460,
      clientY: 340,
    });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", clientX: 460, clientY: 340 });
    fireEvent.click(stage);
    expect(screen.getByRole("dialog")).toBe(dialog);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(thumb);

    // 2. 点空白关闭并恢复焦点
    fireEvent.click(thumb);
    dialog = screen.getByRole("dialog");
    const stage2 = dialog.querySelector<HTMLElement>(".iv-stage");
    if (!stage2) throw new Error("missing stage");
    fireEvent.click(stage2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(thumb);

    // 3. 点关闭按钮关闭并恢复焦点
    fireEvent.click(thumb);
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it("滚轮放大后 transform 缩放值变化，双击回到适应窗口；缩放范围限制在适应窗口到 8 倍之间", () => {
    const onClose = vi.fn();
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    render(
      <ImageViewer
        items={[
          { src: "blob:big", filename: "big.png", alt: "大图" },
          { src: "blob:next", filename: "next.png", alt: "次图" },
        ]}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const stage = dialog.querySelector<HTMLElement>(".iv-stage");
    const img = within(dialog).getByRole("img") as HTMLImageElement;
    if (!stage) throw new Error("missing stage");

    // 模拟 1500x1500 大图在 1200x800 桌面窗口（可用高 752 -> fit = 752 / 1500 ≈ 0.5013）
    Object.defineProperty(img, "naturalWidth", { value: 1500, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1500, configurable: true });
    fireEvent.load(img);

    const fitScale = parseScale(img.style.transform);
    expect(fitScale).toBeCloseTo(752 / 1500, 3);

    // 滚轮继续缩小不会低于适应窗口 fitScale
    fireEvent.wheel(stage, { deltaY: 5000, clientX: 600, clientY: 400 });
    expect(parseScale(img.style.transform)).toBeCloseTo(fitScale, 4);

    // 滚轮向上放大，scale 增大
    fireEvent.wheel(stage, { deltaY: -400, clientX: 600, clientY: 400 });
    const zoomedScale = parseScale(img.style.transform);
    expect(zoomedScale).toBeGreaterThan(fitScale);
    expect(stage.classList.contains("zoomed")).toBe(true);

    // 双击回到适应窗口；再次双击切换到原始大小 1
    fireEvent.doubleClick(stage, { clientX: 600, clientY: 400 });
    expect(parseScale(img.style.transform)).toBeCloseTo(fitScale, 4);
    expect(stage.classList.contains("zoomed")).toBe(false);

    fireEvent.doubleClick(stage, { clientX: 600, clientY: 400 });
    expect(parseScale(img.style.transform)).toBeCloseTo(1, 4);

    // 极端滚轮放大不超过 8 倍，且拖动平移受边界钳制
    fireEvent.wheel(stage, { deltaY: -100000, clientX: 600, clientY: 400 });
    expect(parseScale(img.style.transform)).toBe(8);
    fireEvent.pointerDown(stage, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 600,
      clientY: 400,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 99999,
      clientY: 99999,
    });
    fireEvent.pointerUp(stage, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 99999,
      clientY: 99999,
    });
    const maxBoundX = (1500 * 8 - 1200) / 2 + 24;
    expect(parseTranslate(img.style.transform).tx).toBeLessThanOrEqual(maxBoundX);

    // 切换到下一张后回到适应窗口
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(parseScale(img.style.transform)).toBeCloseTo(fitScale, 4);
  });

  it("占位、加载中与加载失败的图片不可点", async () => {
    // 1. 加载中（readAttachment 挂起）
    const pendingImages = createAttachmentImageSource();
    const hangRead = vi.fn(() => new Promise<never>(() => undefined));
    const view1 = createSessionView();
    view1.entries = [
      {
        kind: "user",
        key: "u-loading",
        seq: 1,
        turnId: "t1",
        content: [{ type: "text", text: "加载中" }],
        attachments: [makeAttachment(1, "加载中.png")],
      },
    ];
    const r1 = render(<Conversation {...makeReadOnlyProps(view1, pendingImages, hangRead)} />);
    enterAllViewports();
    const loadingEl = r1.container.querySelector(".u-img-placeholder");
    expect(loadingEl).not.toBeNull();
    expect(r1.container.querySelector("button.u-img-frame")).toBeNull();
    if (loadingEl) fireEvent.click(loadingEl);
    expect(screen.queryByRole("dialog")).toBeNull();
    r1.unmount();
    pendingImages.dispose();

    // 2. 远程过大等读取失败（showErrors 为 true）
    const errImages = createAttachmentImageSource();
    errImages.showErrors = true;
    const failRead = vi.fn(async () => {
      throw new Error("附件过大，请在电脑上查看");
    });
    const view2 = createSessionView();
    view2.entries = [
      {
        kind: "user",
        key: "u-err",
        seq: 1,
        turnId: "t1",
        content: [{ type: "text", text: "超限" }],
        attachments: [makeAttachment(2, "大图.png")],
      },
    ];
    const r2 = render(<Conversation {...makeReadOnlyProps(view2, errImages, failRead)} />);
    enterAllViewports();
    await waitFor(() => {
      expect(r2.container.querySelector(".u-img-chip")?.textContent).toContain("附件过大");
    });
    expect(r2.container.querySelector("button.u-img-frame")).toBeNull();
    const chip = r2.container.querySelector(".u-img-chip");
    if (chip) fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
    r2.unmount();
    errImages.dispose();

    // 3. 纯占位模式（images.placeholder）
    const phImages = createAttachmentImageSource();
    phImages.placeholder = "图片占位";
    const r3 = render(<Conversation {...makeReadOnlyProps(view2, phImages)} />);
    enterAllViewports();
    expect(r3.container.querySelector("button.u-img-frame")).toBeNull();
    r3.unmount();
    phImages.dispose();
  });

  it("桌面与手机输入框待发缩略图：点缩略图打开查看器，点移除按钮只移除不打开", async () => {
    // 桌面 Composer
    const desktop = render(
      <Composer
        running={false}
        fileRefs={null}
        onSubmit={vi.fn(async () => true)}
        onInterrupt={vi.fn()}
        onSlash={vi.fn(async () => false)}
        pickImages={vi.fn(async () => [
          { name: "first.png", data: new Uint8Array([1, 2, 3]) },
          { name: "second.png", data: new Uint8Array([4, 5, 6]) },
        ])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加图片或引用文件" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /添加文件/ }));
    const openFirst = await screen.findByRole("button", { name: "first.png" });
    fireEvent.click(openFirst);
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toBe("1 / 2");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // 点移除按钮：移除对应缩略图，不打开查看器
    fireEvent.click(screen.getByRole("button", { name: "移除 first.png" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "first.png" })).toBeNull();
    expect(screen.getByRole("button", { name: "second.png" })).toBeTruthy();
    desktop.unmount();

    // 手机 PhoneComposer
    const phone = render(
      <PhoneComposer
        variant="session"
        controls={undefined}
        running={false}
        onSubmit={vi.fn(async () => true)}
        onInterrupt={vi.fn()}
        onSlash={vi.fn(async () => false)}
        prepareImage={async (file) => ({
          data: new Uint8Array([7, 8]),
          mimeType: "image/png",
          name: file.name,
          width: 100,
          height: 100,
        })}
      />,
    );
    const inputs = phone.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const galleryInput = inputs[1];
    if (!galleryInput) throw new Error("missing gallery input");
    await act(async () => {
      fireEvent.change(galleryInput, {
        target: { files: [new File(["ab"], "mobile.png", { type: "image/png" })] },
      });
    });
    const mobileThumb = await screen.findByRole("button", { name: "mobile.png" });
    fireEvent.click(mobileThumb);
    expect(screen.getByRole("dialog").textContent).toBe("");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "移除 mobile.png" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "mobile.png" })).toBeNull();
    phone.unmount();
  });

  it("侧栏文件查看器图片点击按单张打开，复制失败仅写入按钮 title，安卓平台隐藏复制与下载", async () => {
    const tab: FileTab = {
      id: "img-tab",
      kind: "file",
      workspace: "Z:\\proj",
      absolutePath: "Z:\\proj\\assets\\diagram.png",
    };
    const sideProps: SidePanelProps = {
      tabs: [tab],
      activeId: "img-tab",
      overlay: false,
      width: 520,
      onActivate: vi.fn(),
      onCloseTab: vi.fn(),
      onMoveTab: vi.fn(),
      onNewTab: vi.fn(),
      onResize: vi.fn(),
      onOpenChanges: vi.fn(),
      onQuickOpen: vi.fn(),
      onOpenTerminal: vi.fn(),
      onAddress: vi.fn(async () => undefined),
      changes: undefined,
      canOpenFiles: true,
      readFile: vi.fn(async (absolutePath: string) => ({
        kind: "image" as const,
        absolutePath,
        mimeType: "image/png" as const,
        data: new Uint8Array([137, 80, 78, 71]),
        bytes: 4,
      })),
      readerKey: "1",
      fileActions: {
        externalLabel: "用 VS Code 打开",
        openExternal: vi.fn(async () => undefined),
        reveal: vi.fn(async () => undefined),
        openInBrowser: vi.fn(async () => undefined),
        browserLabel: "在系统浏览器打开",
      },
      terminals: undefined,
      loadShells: vi.fn(async () => ({ shells: [], setting: undefined })),
      onShellChange: vi.fn(),
    };

    const writeMock = vi.fn(async () => {
      throw new Error("Clipboard write blocked");
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        items: Record<string, unknown>;
        constructor(items: Record<string, unknown>) {
          this.items = items;
        }
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { write: writeMock },
      configurable: true,
    });

    const side = render(<SidePanel {...sideProps} />);
    const imgBtn = await screen.findByRole("button", { name: "assets/diagram.png" });
    fireEvent.click(imgBtn);

    const dialog = screen.getByRole("dialog");
    // 除计数外没有任何可见文字，单张图连计数也没有
    expect(dialog.textContent).toBe("");
    const copyBtn = within(dialog).getByRole("button", { name: "复制" });
    expect(copyBtn.getAttribute("title")).toBe("复制");
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(copyBtn.getAttribute("title")).toBe("Clipboard write blocked");
    expect(dialog.textContent).toBe("");

    // 验证下载使用侧栏文件名 diagram.png
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    let downloadedName = "";
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      const el = origCreate(tagName);
      if (tagName.toLowerCase() === "a") {
        Object.defineProperty(el, "download", {
          set(v: string) {
            downloadedName = v;
          },
          get() {
            return downloadedName;
          },
        });
      }
      return el;
    }) as typeof document.createElement);
    fireEvent.click(within(dialog).getByRole("button", { name: "下载" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(downloadedName).toBe("diagram.png");
    side.unmount();

    // 验证安卓平台能力配置隐藏复制与下载按钮
    const androidPlatform = appPlatform(shellHost);
    render(
      <ImageViewer
        items={[{ src: "blob:a", filename: "a.png", alt: "a" }]}
        capabilities={androidPlatform.imageViewer}
        onClose={vi.fn()}
      />,
    );
    const androidDialog = screen.getByRole("dialog");
    expect(within(androidDialog).queryByRole("button", { name: "复制" })).toBeNull();
    expect(within(androidDialog).queryByRole("button", { name: "下载" })).toBeNull();
    expect(within(androidDialog).getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("非 PNG 图片复制时先转为 image/png 再写入剪贴板；手机触屏支持未放大左右滑切换与双触缩放", async () => {
    let writtenBlob: Blob | undefined;
    const writeMock = vi.fn(async (items: { items: Record<string, unknown> }[]) => {
      const val = items[0]?.items["image/png"];
      writtenBlob = val instanceof Promise ? ((await val) as Blob) : (val as Blob);
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        items: Record<string, unknown>;
        constructor(items: Record<string, unknown>) {
          this.items = items;
        }
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { write: writeMock },
      configurable: true,
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
      drawImage,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb, type) => {
      cb(new Blob(["png-bytes"], { type: type ?? "image/png" }));
    });

    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });

    render(
      <ImageViewer
        items={[
          {
            src: "blob:jpeg-1",
            filename: "photo.jpg",
            alt: "首图",
            blob: new Blob(["jpg"], { type: "image/jpeg" }),
          },
          { src: "blob:jpeg-2", filename: "photo2.jpg", alt: "次图" },
        ]}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const stage = dialog.querySelector<HTMLElement>(".iv-stage");
    const img = within(dialog).getByRole("img") as HTMLImageElement;
    if (!stage) throw new Error("missing stage");
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 780, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 780, configurable: true });
    fireEvent.load(img);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));
    });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(writtenBlob?.type).toBe("image/png");

    // 手机未放大时向左滑动切换下一张
    expect(dialog.textContent).toBe("1 / 2");
    fireEvent.pointerDown(stage, {
      pointerId: 10,
      pointerType: "touch",
      clientX: 300,
      clientY: 400,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 10,
      pointerType: "touch",
      clientX: 180,
      clientY: 405,
    });
    fireEvent.pointerUp(stage, { pointerId: 10, pointerType: "touch", clientX: 180, clientY: 405 });
    expect(dialog.textContent).toBe("2 / 2");

    // 手机在图片上双触放大，再双触回到适应窗口
    Object.defineProperty(img, "naturalWidth", { value: 780, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 780, configurable: true });
    fireEvent.load(img);
    const fit = parseScale(img.style.transform);
    fireEvent.pointerDown(img, { pointerId: 11, pointerType: "touch", clientX: 195, clientY: 420 });
    fireEvent.pointerUp(img, { pointerId: 11, pointerType: "touch", clientX: 195, clientY: 420 });
    fireEvent.pointerDown(img, { pointerId: 12, pointerType: "touch", clientX: 196, clientY: 421 });
    fireEvent.pointerUp(img, { pointerId: 12, pointerType: "touch", clientX: 196, clientY: 421 });
    expect(parseScale(img.style.transform)).toBeGreaterThan(fit);
  });

  it("安卓返回键在查看器打开时先关闭查看器，不退回上一页", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const baseRuntime: Record<string, unknown> = {
      listSessions: async () => [
        {
          id: "s1",
          createdAt: new Date().toISOString(),
          model: { provider: "fake", model: "fake-1" },
          cwd: "Z:/work",
          workspaceRoot: "Z:/work",
          mtimeMs: 1,
          locked: false,
          firstText: "会话一",
        },
      ],
      listScheduleTasks: async () => [],
    };
    const fakeClient = {
      onNotification: () => () => undefined,
      describeComputer: async () => ({
        name: "PC",
        homeDir: "Z:/home",
        plainWorkspace: "Z:/plain",
      }),
      runtime: new Proxy(baseRuntime, {
        get(target, key) {
          if (typeof key === "symbol" || key === "then") return undefined;
          if (key in target) return target[key];
          return () => Promise.reject(new Error(`unimplemented ${key}`));
        },
      }),
    };
    const storage = memoryStorage();
    await storage.putHost({ hostId: "h1", hostPub: "pub", name: "PC", pairedAt: 1 });
    await storage.identity();
    const push = new PhonePush({
      registration: () => Promise.reject(new Error("unsupported")),
      permission: () => "default",
      requestPermission: vi.fn(),
      info: vi.fn(),
      changed: vi.fn(),
    });
    let triggerBack: (() => void) | undefined;
    let connectClient: ((c: unknown, r: unknown) => Promise<void>) | undefined;
    const moveTaskToBack = vi.fn();

    const app = render(
      <PhoneApp
        storage={storage}
        push={push}
        platform={{
          relay: "page",
          createConnection: (opts) => {
            connectClient = opts.connected as (c: unknown, r: unknown) => Promise<void>;
            return {
              state: "online",
              message: "",
              sessionsDir: "Z:/sessions",
              start: vi.fn(),
              stop: vi.fn(),
              visibility: vi.fn(),
            };
          },
          onAndroidBack: (listener) => {
            triggerBack = listener;
            return () => {
              triggerBack = undefined;
            };
          },
          moveTaskToBack,
        }}
      />,
    );

    await waitFor(() => expect(connectClient).toBeDefined());
    await act(async () => {
      await connectClient?.(fakeClient, { subscribePush: vi.fn(), unsubscribePush: vi.fn() });
    });

    // 进入 work 项目页（带有新建会话输入框）
    const projBtn = await waitFor(() => {
      const btn = [...app.container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((b) =>
        b.textContent?.includes("work"),
      );
      if (!btn) throw new Error("waiting project row");
      return btn;
    });
    fireEvent.click(projBtn);
    expect(app.container.querySelector("textarea")?.placeholder).toBe("输入消息");

    // 粘贴一张 PNG 到待发区并点缩略图打开查看器
    const textarea = app.container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    );
    const file = new File([pngBytes], "back.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [
            {
              kind: "file",
              type: "image/png",
              getAsFile: () => file,
            },
          ],
          files: [file],
          getData: () => "",
        },
      });
    });

    const thumb = await screen.findByRole("button", { name: "back.png" });
    fireEvent.click(thumb);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // 第一次按安卓返回键：只关闭查看器，仍留在 work 项目页
    act(() => {
      triggerBack?.();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(app.container.querySelector("textarea")?.placeholder).toBe("输入消息");
    expect(moveTaskToBack).not.toHaveBeenCalled();
    app.unmount();
  });
});

function ConversationThumbHarness({
  items,
  buttonRef,
}: {
  items: { src: string; filename: string; alt: string }[];
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const [open, setOpen] = useStateLocal(false);
  const [opener, setOpener] = useStateLocal<HTMLElement | null>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          setOpener(e.currentTarget);
          setOpen(true);
        }}
      >
        打开缩略图
      </button>
      {open && (
        <ImageViewer
          items={items}
          initialIndex={0}
          opener={opener}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

import { useState as useStateLocal } from "react";
