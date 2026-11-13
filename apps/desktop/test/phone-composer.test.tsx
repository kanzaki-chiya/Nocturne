import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ComposerSubmit } from "../src/Composer";
import type { ContextSummary } from "@nocturne/rpc/client";
import { PhoneComposer } from "../src/web/PhoneComposer";
import { SessionHeaderTools, sessionInputHistory } from "../src/web/SessionHeaderTools";
import { PanelHarness, panelFixture } from "./phone-panel-fixtures";
import {
  estimateSubmitBytes,
  IMAGE_MAX_PIXELS,
  preparePhoneImage,
  SUBMIT_MESSAGE_LIMIT,
  type ImageCodec,
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

const headerTools = (props: Partial<Parameters<typeof SessionHeaderTools>[0]>) => (
  <SessionHeaderTools
    connected
    running={false}
    shell={{ label: "pwsh" }}
    onRename={vi.fn()}
    onCompact={vi.fn()}
    loadMcp={() => Promise.resolve("")}
    inputHistory={() => []}
    onPickHistory={vi.fn()}
    {...props}
  />
);

it("侧边栏上下文回放时不查，完成只查一次，实时变化合并补拉", async () => {
  // 与桌面状态栏同一 single-flight：回放不查，结束后一次，飞行中的变化只补一次。
  const pending: ((value: ContextSummary) => void)[] = [];
  const load = vi.fn(() => new Promise<ContextSummary>((resolve) => pending.push(resolve)));
  const fixture = panelFixture();
  const ui = (replaying: boolean, key: string) => (
    <PanelHarness fixture={fixture} context={{ load, key, replaying }} />
  );
  for (let i = 0; i < 4; i++) await act(() => root?.render(ui(true, String(i))));
  expect(load).not.toHaveBeenCalled();
  await act(() => root?.render(ui(false, "ready")));
  expect(load).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 4; i++) await act(() => root?.render(ui(false, String(i))));
  expect(load).toHaveBeenCalledTimes(1);
  const summary: ContextSummary = {
    report: { sections: [], totalChars: 0, estimatedTokens: 0, budgetTokens: 100 },
    overBudget: false,
    mustCompact: false,
  };
  await act(() => pending.shift()?.(summary));
  expect(load).toHaveBeenCalledTimes(2);
  await act(() => pending.shift()?.(summary));
  expect(load).toHaveBeenCalledTimes(2);
});

it("图片在硬上限与单条报文上限内原样发送；超限或类型不支持时先保尺寸转 JPEG，仍超再缩尺寸", async () => {
  // 9.5 MB 长截图（< 50 MB、30.2M 像素 < 64M、base64 < SUBMIT_MESSAGE_LIMIT）：原样发送，不缩图
  const longShot = new File([new Uint8Array(Math.floor(9.5 * 1024 * 1024))], "long.png", {
    type: "image/png",
  });
  const plain = codec(1849, 16348);
  const kept = await preparePhoneImage(longShot, plain.fake);
  expect(kept).toMatchObject({
    name: "long.png",
    mimeType: "image/png",
    width: 1849,
    height: 16348,
  });
  expect(kept.data.length).toBe(longShot.size);
  expect(plain.encoded).toEqual([]);

  // 超过 8000 px 但像素总数 <= 64M 的 JPEG：不再因 8000 px 缩图
  const wide = new File([new Uint8Array(100)], "pano.jpg", { type: "image/jpeg" });
  const pano = codec(9000, 1000);
  const keptPano = await preparePhoneImage(wide, pano.fake);
  expect(keptPano).toMatchObject({ name: "pano.jpg", mimeType: "image/jpeg", width: 9000 });
  expect(pano.encoded).toEqual([]);

  // HEIC 等不支持的类型：保持原尺寸转 JPEG
  const heic = new File([new Uint8Array(10)], "IMG_1.HEIC", { type: "image/heic" });
  const photo = codec(4032, 3024);
  const converted = await preparePhoneImage(heic, photo.fake);
  expect(converted).toMatchObject({ name: "IMG_1.jpg", mimeType: "image/jpeg" });
  expect(photo.encoded[0]).toMatchObject({ width: 4032, height: 3024, mimeType: "image/jpeg" });

  // 超过 SUBMIT_MESSAGE_LIMIT 的 PNG：先保持尺寸转 JPEG 降质，仍超再缩尺寸
  const tooLargeForWs = new File([new Uint8Array(13 * 1024 * 1024)], "shot.png", {
    type: "image/png",
  });
  const oversized = 13 * 1024 * 1024;
  const heavy = codec(2000, 1000, [oversized, oversized, oversized, oversized, 4000]);
  const shrunk = await preparePhoneImage(tooLargeForWs, heavy.fake);
  expect(heavy.encoded.map((e) => [e.width, e.height, e.mimeType, e.quality])).toEqual([
    [2000, 1000, "image/jpeg", 0.9],
    [2000, 1000, "image/jpeg", 0.8],
    [2000, 1000, "image/jpeg", 0.65],
    [2000, 1000, "image/jpeg", 0.5],
    [1000, 500, "image/jpeg", 0.9],
  ]);
  expect(shrunk).toMatchObject({ mimeType: "image/jpeg", width: 1000, height: 500 });

  // 超过 64M 像素硬上限的图：按像素上限等比缩入后再转 JPEG
  const huge = new File([new Uint8Array(1000)], "huge.png", { type: "image/png" });
  const ultra = codec(10000, 7000);
  const fit = await preparePhoneImage(huge, ultra.fake);
  expect(fit.width * fit.height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
  expect(fit.mimeType).toBe("image/jpeg");

  const broken: ImageCodec = { ...plain.fake, decode: () => Promise.reject(new Error("x")) };
  await expect(preparePhoneImage(longShot, broken)).rejects.toThrow("无法读取图片");
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

it("权限底栏附会话授权段", async () => {
  const control = {
    value: "default",
    label: "default",
    groups: [{ options: [{ value: "default", label: "default" }] }],
    onSelect: vi.fn(),
  };
  await act(async () =>
    root?.render(
      <PhoneComposer
        variant="session"
        controls={{ preset: control, model: control, effort: control }}
        running={false}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        onSlash={vi.fn()}
        grantsFooter={<section>本会话已允许 3 项</section>}
      />,
    ),
  );
  const trigger = [...container.querySelectorAll("button")].find((el) =>
    el.getAttribute("aria-label")?.includes("权限"),
  );
  await act(() => trigger?.click());
  expect(container.textContent).toContain("本会话已允许 3 项");
});

it("图片附件随消息发出，报文超限时不发送并提示", async () => {
  const onSubmit = vi.fn((_input: ComposerSubmit) => Promise.resolve(true));

  await act(async () => {
    root?.render(
      <PhoneComposer
        variant="session"
        controls={undefined}
        running={false}
        onSubmit={onSubmit}
        onInterrupt={vi.fn()}
        onSlash={vi.fn()}
        getVisionHint={() => Promise.resolve("当前模型不支持图片")}
      />,
    );
  });
  await act(() => button("添加文件").click());
  expect(container.textContent).toContain("拍照");
  expect(container.textContent).not.toContain("用相机拍一张发给模型");
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
  const bytes = new Uint8Array(Math.floor((SUBMIT_MESSAGE_LIMIT / 3) * 0.8));
  await pick([1, 2, 3].map((i) => new File([bytes], `${i}.jpg`, { type: "image/jpeg" })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("超过远程连接单条上限");
  expect(button("发送").disabled).toBe(true);
  await act(() => button("移除 3.jpg").click());
  expect(button("发送").disabled).toBe(false);
});

it("输入历史只取当前会话的消息：带命令名，不含 Runtime 写入的消息和助手回复", () => {
  const user = (text: string, workMode?: { name: string; source?: string }) =>
    ({
      kind: "user",
      // 执行方式的说明块排在正文之后，userEntryText 会去掉
      content: [{ type: "text", text }, ...(workMode ? [{ type: "text", text: "说明块" }] : [])],
      ...(workMode ? { workMode } : {}),
    }) as never;
  expect(
    sessionInputHistory([
      user("普通消息"),
      { kind: "assistant" } as never,
      user("目标", { name: "goal" }),
      user("", { name: "goal", source: "runtime" }),
    ]),
  ).toEqual(["普通消息", "/goal 目标"]);
});

it("会话菜单合并输入历史与 Shell，无重复项；选中的输入历史交给输入框", async () => {
  const onPickHistory = vi.fn();
  await act(async () => {
    root?.render(
      headerTools({
        inputHistory: () => ["旧的一条", "最近一条", "旧的一条"],
        onPickHistory,
      }),
    );
  });
  expect(
    [...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
  ).toEqual(["会话菜单"]);
  await act(() => button("会话菜单").click());
  const options = [...container.querySelectorAll(".phone-option")].map((o) => o.textContent);
  expect(options).toEqual(["重命名", "压缩上下文", "MCP 状态", "输入历史", "Shellpwsh"]);
  // 五项都没有图标与说明行，浮层没有可见标题，aria-label 保留
  const menu = container.querySelector('[role="dialog"][aria-label="会话菜单"]');
  expect(menu).not.toBeNull();
  expect(menu?.querySelector(".phone-option-icon, small, .phone-popover-h")).toBeNull();
  expect(menu?.querySelector(".phone-option.readout")?.textContent).toBe("Shellpwsh");
  await act(async () => {
    button("输入历史").click();
    await Promise.resolve();
  });
  const rows = [...container.querySelectorAll(".phone-history-row")].map((r) => r.textContent);
  expect(rows).toEqual(["旧的一条", "最近一条"]);
  await act(() => button("最近一条").click());
  expect(onPickHistory).toHaveBeenCalledWith("最近一条");
  expect(container.querySelector(".phone-history-row")).toBeNull();
});

it("探测 Shell 中只置灰，不写说明，打开菜单时触发探测；上下文明细不重复标题", async () => {
  const load = vi.fn();
  await act(async () => {
    root?.render(
      headerTools({
        shell: { label: "—", probing: true, load },
      }),
    );
  });
  await act(() => button("会话菜单").click());
  expect(load).toHaveBeenCalledTimes(1);
  const shell = [...container.querySelectorAll(".phone-option")].at(-1);
  expect(shell?.textContent).toBe("Shell—");
  expect(shell?.classList.contains("readout")).toBe(false);
  expect(container.textContent).not.toContain("探测");
  await act(() => root?.render(<PanelHarness fixture={panelFixture()} />));
  await act(() => button("上下文").click());
  const panel = container.querySelector(".phone-panel-context-detail");
  expect(panel).not.toBeNull();
  expect(panel?.querySelector(".phone-popover-h")).toBeNull();
  expect(panel?.textContent).not.toContain("上下文用量");
});

it("@ 文件引用用文件索引补全，普通对话不可用；输入历史填回输入框", async () => {
  const load = vi.fn(() =>
    Promise.resolve([
      { path: "src/", kind: "directory" as const },
      { path: "src/main.ts", kind: "file" as const },
      { path: "README.md", kind: "file" as const },
    ]),
  );
  const extra: { fill?: { text: string; seq: number } } = {};
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
          fill={extra.fill}
        />,
      );
    });
  await render(null);
  await act(() => button("添加文件").click());
  expect(button("引用文件").disabled).toBe(true);
  await act(() => button("添加文件").click());

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

  // 工具行没有「更多」和上下文圆环；菜单在顶栏，上下文在侧边栏
  expect(container.querySelector('[aria-label="更多"]')).toBeNull();
  expect(container.querySelector('[aria-label^="上下文用量"]')).toBeNull();
  extra.fill = { text: "最近一条", seq: 1 };
  await render({ load, key: 1 });
  await act(() => new Promise((done) => setTimeout(done, 0)));
  expect(container.querySelector("textarea")?.value).toBe("最近一条");
  // 同一 seq 重渲染不覆盖用户之后的输入
  await setText("改过了");
  await render({ load, key: 1 });
  expect(container.querySelector("textarea")?.value).toBe("改过了");
});

// ADR-0070 修订 2026-11-01：运行中发送一律排队，待发列表排队行提供「立即发送」转为插话
it("运行中：无切换按钮、发送默认排队、待发列表「立即发送」转插话", async () => {
  const onSubmit = vi.fn((_input: ComposerSubmit, _mode?: "steer" | "queue") =>
    Promise.resolve(true),
  );
  const onUpdate = vi.fn(() => Promise.resolve());
  const onCancel = vi.fn(() => Promise.resolve());
  const onResume = vi.fn(() => Promise.resolve());
  const field = () => container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    root?.render(
      <PhoneComposer
        variant="session"
        controls={undefined}
        running
        onSubmit={onSubmit}
        onInterrupt={vi.fn()}
        onSlash={vi.fn()}
        pendingInputs={{
          items: [
            {
              id: "pi-1",
              mode: "steer",
              text: "插话一条",
              attachments: 0,
              createdAt: "2026-10-28T10:00:00Z",
              paused: false,
            },
            {
              id: "pi-2",
              mode: "queue",
              text: "排队一条",
              attachments: 0,
              createdAt: "2026-10-28T10:00:01Z",
              paused: false,
            },
          ],
          paused: true,
        }}
        onUpdatePending={onUpdate}
        onCancelPending={onCancel}
        onResumePending={onResume}
      />,
    );
  });
  // 运行中没有 .phone-send-mode 切换按钮；占位与空闲时一致，不含「插话」「排队」
  expect(container.querySelector(".phone-send-mode")).toBeNull();
  expect(field().placeholder).toBe("输入消息");
  expect(field().placeholder).not.toContain("/ 查看命令");
  expect(field().placeholder).not.toMatch(/插话|排队/);
  // 待发列表：单行内容 + 暂停提示，无送达说明；排队条目提供「立即发送」转为插话
  expect(container.querySelector(".pending-inputs")?.textContent).toContain("插话一条");
  expect(container.querySelector(".pending-inputs .pi-note")).toBeNull();
  expect(container.textContent).toContain("已暂停");
  await act(async () => {
    button("继续发送").click();
    await Promise.resolve();
  });
  expect(onResume).toHaveBeenCalledOnce();
  const sendNow = container.querySelector<HTMLButtonElement>(
    '.pending-inputs button[aria-label="立即发送"]',
  );
  expect(sendNow).toBeTruthy();
  await act(async () => {
    sendNow?.click();
    await Promise.resolve();
  });
  expect(onUpdate).toHaveBeenCalledWith("pi-2", { mode: "steer" });
  // 运行中：■ 与发送键并存（有草稿时），发送一律排队，title 只写「发送」
  expect(container.querySelector('[aria-label="中断"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="发送"]')).toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field(), "运行中补一句");
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sendBtn = container.querySelector<HTMLButtonElement>('button[aria-label="发送"]');
  expect(sendBtn?.title).toBe("发送");
  await act(async () => {
    sendBtn?.click();
    await Promise.resolve();
  });
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: "运行中补一句" }), "queue");
});

it("空闲时发送键是普通发送，不带 mode", async () => {
  const onSubmit = vi.fn((_input: ComposerSubmit) => Promise.resolve(true));
  await act(async () => {
    root?.render(
      <PhoneComposer
        variant="session"
        controls={undefined}
        running={false}
        onSubmit={onSubmit}
        onInterrupt={vi.fn()}
        onSlash={vi.fn()}
      />,
    );
  });
  const field = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, "普通发送");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    button("发送").click();
    await Promise.resolve();
  });
  expect(onSubmit.mock.calls[0]).toHaveLength(1);
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: "普通发送" }));
});
