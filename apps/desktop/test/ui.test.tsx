import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Badge, Button, Checkbox, IconButton, SegmentedControl, Switch } from "../src/ui";

afterEach(() => {
  cleanup();
});

describe("共享基础控件 (src/ui)", () => {
  it("Button：变体与尺寸类名正确，禁用时不触发回调", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="primary" size="sm" onClick={onClick}>
        保存
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn.className).toBe("btn btn-primary btn-sm");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button variant="danger-solid" size="lg" disabled onClick={onClick}>
        确认删除
      </Button>,
    );
    const disabledBtn = screen.getByRole("button", { name: "确认删除" });
    expect(disabledBtn.className).toBe("btn btn-danger-solid btn-lg");
    expect(disabledBtn).toHaveProperty("disabled", true);
    fireEvent.click(disabledBtn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("IconButton：必须带 aria-label，支持 sm 与 active 状态，禁用时不触发回调", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <IconButton aria-label="刷新" size="sm" active onClick={onClick}>
        ↻
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "刷新" });
    expect(btn.className).toBe("ib sm on");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <IconButton aria-label="刷新" disabled onClick={onClick}>
        ↻
      </IconButton>,
    );
    expect(btn).toHaveProperty("disabled", true);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Switch：role=switch、aria-checked 与选中状态一致，内部不含文字，禁用时不触发回调", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Switch aria-label="启用服务" checked={false} onChange={onChange} />,
    );
    const sw = screen.getByRole("switch", { name: "启用服务" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toBe("");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Switch aria-label="启用服务" checked disabled onChange={onChange} />);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw).toHaveProperty("disabled", true);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Checkbox：role=checkbox、checked 状态正确，禁用时不触发回调", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox checked={false} onChange={onChange}>
        后台隔离运行
      </Checkbox>,
    );
    const cb = screen.getByRole("checkbox", { name: "后台隔离运行" });
    expect(cb).toHaveProperty("checked", false);
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(
      <Checkbox checked disabled onChange={onChange}>
        后台隔离运行
      </Checkbox>,
    );
    expect(cb).toHaveProperty("checked", true);
    expect(cb).toHaveProperty("disabled", true);
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("SegmentedControl：选中状态与 aria-pressed / aria-selected 一致，禁用时不触发回调", () => {
    const onChange = vi.fn();
    const options = [
      { value: "system", label: "跟随系统" },
      { value: "light", label: "亮色" },
      { value: "dark", label: "暗色", disabled: true },
    ] as const;
    const { rerender } = render(
      <SegmentedControl
        aria-label="主题"
        size="sm"
        options={options}
        value="light"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "主题" });
    expect(group.className).toBe("seg sm");
    const sysBtn = screen.getByRole("button", { name: "跟随系统" });
    const lightBtn = screen.getByRole("button", { name: "亮色" });
    const darkBtn = screen.getByRole("button", { name: "暗色" });
    expect(sysBtn.getAttribute("aria-pressed")).toBe("false");
    expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
    expect(darkBtn).toHaveProperty("disabled", true);

    fireEvent.click(sysBtn);
    expect(onChange).toHaveBeenCalledWith("system");
    fireEvent.click(darkBtn);
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(
      <SegmentedControl
        aria-label="视图"
        role="tablist"
        options={[
          { value: "settings", label: "设置" },
          { value: "history", label: "历史" },
        ]}
        value="history"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("tab", { name: "设置" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "历史" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Badge：渲染各语义变体类名", () => {
    const { rerender } = render(<Badge>只读</Badge>);
    const el = screen.getByText("只读");
    expect(el.className).toBe("badge");

    rerender(<Badge variant="accent">推荐</Badge>);
    expect(el.className).toBe("badge accent");

    rerender(<Badge variant="warn">待确认</Badge>);
    expect(el.className).toBe("badge warn");

    rerender(<Badge variant="err">失败</Badge>);
    expect(el.className).toBe("badge err");

    rerender(<Badge variant="ok">在线</Badge>);
    expect(el.className).toBe("badge ok");
  });
});
