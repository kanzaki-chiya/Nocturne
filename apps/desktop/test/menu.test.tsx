/**
 * 弹出菜单焦点：打开后焦点进菜单（有选中项时进选中项），且聚焦时菜单已可见；
 * Esc 关闭后焦点回触发元素，不冒泡到外层。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceMenu, Menu, MenuItem } from "../src/Menu";
import { modelGroups } from "../src/session-controls";

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

  it("悬停把焦点移到该项，同一时刻只有一个高亮", () => {
    render(<Harness />);
    fireEvent.contextMenu(screen.getByText("文件引用"));
    const third = screen.getByRole("menuitem", { name: "在文件夹中显示" });
    fireEvent.pointerMove(third);
    expect(document.activeElement).toBe(third);
  });

  it("焦点与选中各一种样式，菜单和下拉一致：焦点 --a-sel 底色，选中只打 ✓", () => {
    const css = (name: string) =>
      readFileSync(path.resolve(import.meta.dirname, "../src", name), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
    const menu = css("composer.css");
    expect(menu).toMatch(/\.menu \.menu-item:focus \{\s*background: var\(--a-sel\);/);
    expect(menu).not.toMatch(/\.menu-item:(hover|focus-visible)/);
    const dropdown = css("dropdown.css");
    expect(dropdown).toMatch(/\.ddm \.ddo\.act \{\s*background: var\(--a-sel\);/);
    expect(dropdown).not.toMatch(/\.ddo\.on /);
  });

  it("modelGroups 显示名优先、无显示名回退 id，detail 保持服务商且悬停带原始 id", () => {
    const capabilities = {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none" as const,
      imageInput: false,
      promptCache: false,
      editTool: "edit" as const,
    };
    const groups = modelGroups(
      [
        {
          ref: { provider: "magpie", model: "mp-route-001" },
          displayName: "千问旗舰版",
          capabilities,
        },
        {
          ref: { provider: "openai", model: "gpt-5-mini" },
          capabilities,
        },
      ],
      [],
    );
    expect(groups).toEqual([
      {
        label: "magpie",
        options: [
          {
            value: "magpie/mp-route-001",
            label: "千问旗舰版",
            detail: "magpie",
            title: "mp-route-001",
          },
        ],
      },
      {
        label: "openai",
        options: [
          {
            value: "openai/gpt-5-mini",
            label: "gpt-5-mini",
            detail: "openai",
            title: "gpt-5-mini",
          },
        ],
      },
    ]);
  });

  it("ChoiceMenu searchable：少于 8 个模型时不显示搜索框", () => {
    const capabilities = {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none" as const,
      imageInput: false,
      promptCache: false,
      editTool: "edit" as const,
    };
    const models = Array.from({ length: 7 }, (_, i) => ({
      ref: { provider: "openai", model: `gpt-${i}` },
      displayName: `模型 ${i}`,
      capabilities,
    }));
    render(
      <ChoiceMenu
        anchor={null}
        label="模型"
        searchable
        control={{
          value: "openai/gpt-0",
          groups: modelGroups(models, []),
          onSelect: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText("搜索模型")).toBeNull();
  });

  it("ChoiceMenu searchable：打开聚焦搜索框，按显示名/id/服务商与中文过滤，↑↓/Enter/Esc 操作", () => {
    const capabilities = {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none" as const,
      imageInput: false,
      promptCache: false,
      editTool: "edit" as const,
    };
    const models = [
      {
        ref: { provider: "magpie", model: "mp-qwen-max-9x" },
        displayName: "通义千问旗舰",
        capabilities,
      },
      {
        ref: { provider: "magpie", model: "mp-deepseek-r2" },
        displayName: "深度求索推理",
        capabilities,
      },
      {
        ref: { provider: "anthropic", model: "claude-sonnet-4-5" },
        displayName: "Claude Sonnet 4.5",
        capabilities,
      },
      {
        ref: { provider: "anthropic", model: "claude-opus-4-5" },
        displayName: "Claude Opus 4.5",
        capabilities,
      },
      { ref: { provider: "openai", model: "gpt-5" }, displayName: "GPT-5", capabilities },
      { ref: { provider: "openai", model: "gpt-5-mini" }, capabilities },
      { ref: { provider: "gemini", model: "gemini-2.5-pro" }, capabilities },
      { ref: { provider: "gemini", model: "gemini-2.5-flash" }, capabilities },
    ];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <ChoiceMenu
        anchor={anchor}
        label="模型"
        searchable
        control={{
          value: "openai/gpt-5",
          groups: modelGroups(models, []),
          onSelect,
        }}
        onClose={onClose}
      />,
    );

    const search = screen.getByPlaceholderText<HTMLInputElement>("搜索模型");
    expect(document.activeElement).toBe(search);

    // 中文显示名直接匹配，其他分组标题隐藏
    fireEvent.change(search, { target: { value: "千问" } });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    const qwenItem = screen.getByRole("menuitemradio", { name: /通义千问旗舰/ });
    expect(qwenItem.getAttribute("title")).toBe("mp-qwen-max-9x");
    expect(screen.getByRole("heading", { name: "magpie" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "anthropic" })).toBeNull();

    // 按原始模型 id 命中（不区分大小写）
    fireEvent.change(search, { target: { value: "MP-DEEPSEEK" } });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio", { name: /深度求索推理/ })).toBeTruthy();

    // 按服务商名命中，并用 ↑↓ + Enter 选择第二项
    fireEvent.change(search, { target: { value: "Anthropic" } });
    const anthropicItems = screen.getAllByRole("menuitemradio");
    expect(anthropicItems).toHaveLength(2);
    expect(anthropicItems[0]?.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(anthropicItems[1]?.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(anthropicItems[0]?.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("anthropic/claude-opus-4-5");
    expect(onClose).toHaveBeenCalledTimes(1);

    // 无匹配时显示「没有匹配的模型」，首次 Esc 清空搜索，再次 Esc 关闭菜单
    onClose.mockClear();
    fireEvent.change(search, { target: { value: "不存在的模型" } });
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.getByText("没有匹配的模型")).toBeTruthy();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(8);

    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    anchor.remove();
  });
});
