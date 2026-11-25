/**
 * ConfirmDialog / Scrim（设置区与会话区概览共用的模态确认框）：
 * - 打开时默认焦点在「取消」，关闭后焦点还给打开前聚焦的元素
 * - Esc、点遮罩都等于取消，不触发确认
 * - 快速双击确认按钮，onConfirm 只执行一次
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { ConfirmDialog, Scrim } from "../src/ProvidersPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

function Fixture({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-label="删除副本与分支 nocturne/x" onClick={() => setOpen(true)}>
        删除
      </button>
      {open ? (
        <ConfirmDialog
          title="删除副本与分支？"
          body="nocturne/x"
          note="其中的改动会丢失"
          confirmLabel="删除"
          danger
          onClose={() => {
            setOpen(false);
          }}
          onConfirm={async () => {
            await onConfirm();
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

async function openDialog() {
  const trigger = screen.getByRole("button", { name: "删除副本与分支 nocturne/x" });
  trigger.focus();
  fireEvent.click(trigger);
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeTruthy();
  return trigger;
}

it("打开时焦点落在「取消」，关闭后焦点还给触发按钮", async () => {
  render(<Fixture onConfirm={async () => undefined} />);
  const trigger = await openDialog();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("Esc 关闭对话框（等于取消），不触发确认", async () => {
  const onConfirm = vi.fn(async () => undefined);
  render(<Fixture onConfirm={onConfirm} />);
  await openDialog();
  fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), { key: "Escape" });
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("焦点在对话框之外（例如输入框）时，Esc 同样关闭对话框且不触发确认", async () => {
  const onConfirm = vi.fn(async () => undefined);
  render(
    <div>
      <textarea aria-label="草稿输入" />
      <Fixture onConfirm={onConfirm} />
    </div>,
  );
  await openDialog();
  // 焦点挪到对话框外（用户点过别处或浏览器行为）
  const outside = screen.getByRole("textbox", { name: "草稿输入" });
  outside.focus();
  expect(document.activeElement).toBe(outside);
  await act(async () => {
    outside.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("即使触发元素在打开前聚焦，焦点仍会进入对话框（不被提交阶段的焦点恢复覆盖）", async () => {
  render(<Fixture onConfirm={async () => undefined} />);
  await openDialog();
  const scrim = document.querySelector(".scrim") as HTMLElement;
  expect(scrim.contains(document.activeElement)).toBe(true);
});

it("点遮罩空白处等于取消；点对话框内部不关闭", async () => {
  const onConfirm = vi.fn(async () => undefined);
  render(<Fixture onConfirm={onConfirm} />);
  await openDialog();
  fireEvent.mouseDown(screen.getByRole("dialog", { name: "删除副本与分支？" }));
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeTruthy();
  fireEvent.mouseDown(document.querySelector(".scrim") as HTMLElement);
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("快速双击「删除」确认只调用一次 onConfirm", async () => {
  let resolveConfirm: (() => void) | undefined;
  const onConfirm = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      }),
  );
  render(<Fixture onConfirm={onConfirm} />);
  await openDialog();
  const confirm = screen.getByRole("button", { name: "删除" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await flush();
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveConfirm?.();
  });
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeNull();
});

it("标题、主体与补充说明按 dialog 结构渲染（dh3 标题在上、两行说明分开）", async () => {
  render(<Fixture onConfirm={async () => undefined} />);
  await openDialog();
  const dialog = screen.getByRole("dialog", { name: "删除副本与分支？" });
  const head = dialog.querySelector(".dh3");
  expect(head).toBeTruthy();
  const rows = [...(head?.childNodes ?? [])].map((node) => node.textContent);
  expect(rows).toEqual(["删除副本与分支？", "nocturne/x", "其中的改动会丢失"]);
  // 遮罩类名是全局组件类：不依赖 .page3 祖先（会话区概览里也在 .main 下直接渲染）
  const scrim = document.querySelector(".scrim");
  expect(scrim).toBeTruthy();
  expect(scrim?.contains(dialog)).toBe(true);
  expect(scrim?.closest(".page3")).toBeNull();
});

it("Scrim 单独使用时同样恢复焦点", async () => {
  function ScrimFixture() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" aria-label="打开" onClick={() => setOpen(true)}>
          打开
        </button>
        {open ? (
          <Scrim onClose={() => setOpen(false)}>
            <button type="button" aria-label="关闭" onClick={() => setOpen(false)}>
              关闭
            </button>
          </Scrim>
        ) : null}
      </div>
    );
  }
  render(<ScrimFixture />);
  const trigger = screen.getByRole("button", { name: "打开" });
  trigger.focus();
  fireEvent.click(trigger);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await flush();
  expect(document.activeElement).toBe(trigger);
});

it("卸载后以一致的 capture 移除窗口捕获监听（移除成功返回 effect 注册的同一回调）", async () => {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      if (type === "keydown" && options === true) added.push(listener);
      return originalAdd.call(window, type, listener as never, options as never);
    },
  );
  vi.spyOn(window, "removeEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      if (type === "keydown" && options === true) removed.push(listener);
      return originalRemove.call(window, type, listener as never, options as never);
    },
  );
  render(<Fixture onConfirm={async () => undefined} />);
  await openDialog();
  expect(added).toHaveLength(1);
  // 点取消关闭并卸载对话框
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await flush();
  expect(screen.queryByRole("dialog", { name: "删除副本与分支？" })).toBeNull();
  // 卸载后必须按 capture=true 移除同一个监听（历史上用 bubble 移除导致泄漏）
  await vi.waitFor(() => {
    expect(removed).toContain(added[0]);
  });
});

it("一次 Esc 只关闭最上层的遮罩，外层不吃这次 Esc（嵌套弹层）", async () => {
  const outerClose = vi.fn();
  const innerClose = vi.fn();
  render(
    <Scrim onClose={outerClose}>
      <div className="outer-layer">
        <Scrim onClose={innerClose}>
          <button type="button" aria-label="内层按钮">
            内层
          </button>
        </Scrim>
      </div>
    </Scrim>,
  );
  await flush();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await flush();
  expect(innerClose).toHaveBeenCalledTimes(1);
  expect(outerClose).not.toHaveBeenCalled();
});

it("Esc 已被上层监听 preventDefault 时，遮罩不再关闭（输入法/更上层弹层优先）", async () => {
  const onClose = vi.fn();
  const upper = (e: KeyboardEvent) => {
    if (e.key === "Escape") e.preventDefault();
  };
  window.addEventListener("keydown", upper, true);
  try {
    render(
      <Scrim onClose={onClose}>
        <button type="button">x</button>
      </Scrim>,
    );
    await flush();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", upper, true);
  }
});

it("输入法组合期间（isComposing）的 Esc 不关闭对话框", async () => {
  const onClose = vi.fn();
  render(
    <Scrim onClose={onClose}>
      <button type="button">x</button>
    </Scrim>,
  );
  await flush();
  fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });
  await flush();
  expect(onClose).not.toHaveBeenCalled();
  // 组合结束后的普通 Esc 仍然生效
  fireEvent.keyDown(document.body, { key: "Escape" });
  await flush();
  expect(onClose).toHaveBeenCalledTimes(1);
});
