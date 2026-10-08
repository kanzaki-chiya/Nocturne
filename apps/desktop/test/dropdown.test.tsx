/**
 * 自绘下拉：ARIA 关系、键盘导航（跳过不可选项）、选择即触发保存、Esc 与点外部关闭。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dropdown, type DropdownOption } from "../src/Dropdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OPTIONS: DropdownOption[] = [
  { value: "bypass", label: "bypass", tag: "全部放行", risk: true },
  { value: "read-only", label: "read-only", tag: "只读", description: "不改文件" },
  { value: "default", label: "default", tag: "默认", description: "改文件要确认" },
  { value: "guarded", label: "guarded", disabled: "当前会话不可用" },
  { value: "smart", label: "smart", tag: "智能" },
];

function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState("default");
  return (
    <>
      <Dropdown
        label="默认权限预设"
        value={value}
        options={OPTIONS}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
      <button type="button">外部</button>
    </>
  );
}

function activeOption(trigger: HTMLElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id);
}

describe("Dropdown", () => {
  it("可搜索列表内部滚动不重新定位；页面滚动更新位置且始终限高", () => {
    render(
      <Dropdown label="模型" value="default" options={OPTIONS} onChange={vi.fn()} searchable />,
    );
    const trigger = screen.getByRole("combobox");
    let top = 100;
    const bounds = vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + 30,
      left: 50,
      right: 350,
      width: 300,
      height: 30,
      x: 50,
      y: top,
      toJSON: () => ({}),
    }));
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox").parentElement;
    if (!list) throw new Error("缺少列表滚动容器");
    expect(list.style.maxHeight).toBe("420px");
    expect(list.style.top).toBe("136px");
    Object.defineProperty(list, "offsetHeight", { value: 420 });
    bounds.mockClear();
    fireEvent.scroll(list);
    fireEvent.scroll(screen.getAllByRole("option")[0] as HTMLElement);
    expect(bounds).not.toHaveBeenCalled();
    expect(list.style.maxHeight).toBe("420px");
    top = 80;
    fireEvent.scroll(window);
    expect(bounds).toHaveBeenCalledOnce();
    expect(list.style.top).toBe("116px");
    expect(list.style.maxHeight).toBe("420px");
  });

  it("触发器显示当前值与说明；打开后 listbox/option 关系完整，危险项排在最后", () => {
    render(<Harness onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "默认权限预设" });
    expect(trigger.textContent).toContain("default");
    expect(trigger.textContent).toContain("改文件要确认");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", { name: "默认权限预设" });
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.querySelector("b")?.textContent)).toEqual([
      "read-only",
      "default",
      "guarded",
      "smart",
      "bypass",
    ]);
    expect(options[4]?.className).toContain("risk");
    expect(options[4]?.className).toContain("sep");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options[2]?.getAttribute("aria-disabled")).toBe("true");
    // 打开时活动项是当前值
    expect(activeOption(trigger)).toBe(options[1]);
  });

  it("键盘：↓ 打开，↑↓ 移动并跳过不可选项，Home/End，Enter 选择后触发保存并收起", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "默认权限预设" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(activeOption(trigger)?.textContent).toContain("default");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    // guarded 不可选，被跳过
    expect(activeOption(trigger)?.textContent).toContain("smart");
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(activeOption(trigger)?.textContent).toContain("default");
    fireEvent.keyDown(trigger, { key: "End" });
    expect(activeOption(trigger)?.textContent).toContain("bypass");
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(activeOption(trigger)?.textContent).toContain("read-only");

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("read-only");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain("read-only");
  });

  it("点选项触发保存；选当前值或不可选项不触发", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "默认权限预设" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /^guarded/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /^default/ }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /^smart/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("smart");
  });

  it("Esc 只关下拉、焦点回到触发器，并且不再冒泡给外层", () => {
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    render(<Harness onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "默认权限预设" });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outer);
  });

  it("点外部关闭，不选择任何项", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "默认权限预设" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "外部" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
