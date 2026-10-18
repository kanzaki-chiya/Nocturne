/**
 * 弹出菜单焦点：打开后焦点进菜单（有选中项时进选中项），且聚焦时菜单已可见；
 * Esc 关闭后焦点回触发元素，不冒泡到外层。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu, MenuItem } from "../src/Menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({ checked, onOuterKey }: { checked?: string; onOuterKey?: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <div onKeyDown={onOuterKey}>
      <span
        tabIndex={-1}
        ref={setAnchor}
        onContextMenu={() => {
          setOpen(true);
        }}
      >
        文件引用
      </span>
      {open && (
        <Menu
          anchor={anchor}
          label="文件"
          onClose={() => {
            setOpen(false);
          }}
        >
          {["打开", "复制路径", "在文件夹中显示"].map((label) =>
            checked === undefined ? (
              <MenuItem key={label} label={label} onSelect={vi.fn()} />
            ) : (
              <MenuItem key={label} label={label} checked={label === checked} onSelect={vi.fn()} />
            ),
          )}
        </Menu>
      )}
    </div>
  );
}

/** 记录每次 focus() 调用时所在菜单的 visibility；真实浏览器里 hidden 元素聚焦会静默失败 */
function trackFocusVisibility(): string[] {
  const seen: string[] = [];
  const original = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    const menu = this.closest<HTMLElement>('[role="menu"]');
    if (menu !== null) seen.push(menu.style.visibility);
    original.call(this, options);
  });
  return seen;
}

describe("Menu", () => {
  it("打开后焦点在第一项，聚焦时菜单已可见", () => {
    const seen = trackFocusVisibility();
    render(<Harness />);
    fireEvent.contextMenu(screen.getByText("文件引用"));
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "打开" }));
    expect(seen).toEqual(["visible"]);
  });

  it("有选中项时焦点在选中项", () => {
    render(<Harness checked="复制路径" />);
    fireEvent.contextMenu(screen.getByText("文件引用"));
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "复制路径" }));
  });

  it("方向键移动焦点；Esc 关闭、焦点回 anchor 且不冒泡", () => {
    const outer = vi.fn();
    render(<Harness onOuterKey={outer} />);
    const anchor = screen.getByText("文件引用");
    fireEvent.contextMenu(anchor);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "打开" }), { key: "ArrowDown" });
    const second = screen.getByRole("menuitem", { name: "复制路径" });
    expect(document.activeElement).toBe(second);
    outer.mockClear();
    fireEvent.keyDown(second, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(outer).not.toHaveBeenCalled();
  });
});
