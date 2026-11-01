import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sourceMarker } from "../src/setting-source";
import {
  DataTable,
  DetailHeader,
  EmptyState,
  Field,
  Form,
  FormFooter,
  ListGroup,
  ListItem,
  MasterDetail,
  PageHeader,
  SettingsGroup,
  SettingsRow,
  SourceMarker,
} from "../src/ui";

afterEach(() => {
  cleanup();
});

describe("设置页骨架组件 (src/ui)", () => {
  it("PageHeader：标题为一级标题，页级操作在页头里", () => {
    render(<PageHeader title="MCP" actions={<button type="button">添加服务器</button>} />);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1, name: "MCP" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "添加服务器" })).toBeTruthy();
  });

  it("SettingsGroup：标题带计数与右侧操作；默认包卡片，plain 不包；无标题时不渲染标题行", () => {
    const { container, rerender } = render(
      <SettingsGroup title="已配置" count={2} action={<button type="button">全部撤销</button>}>
        <span>内容</span>
      </SettingsGroup>,
    );
    const group = screen.getByRole("region", { name: "已配置 · 2" });
    expect(within(group).getByRole("heading", { level: 2 }).textContent).toBe("已配置 · 2");
    expect(within(group).getByRole("button", { name: "全部撤销" })).toBeTruthy();
    expect(screen.getByText("内容").parentElement?.className).toBe("card");

    rerender(
      <SettingsGroup title="项目授权" plain>
        <span>内容</span>
      </SettingsGroup>,
    );
    expect(screen.getByText("内容").parentElement?.tagName).toBe("SECTION");

    rerender(
      <SettingsGroup>
        <span>内容</span>
      </SettingsGroup>,
    );
    expect(container.querySelector("h2")).toBeNull();
  });

  it("SettingsRow：标签、说明、来源标记、徽标与右侧控件；错误为 alert", () => {
    render(
      <SettingsRow
        label="默认权限预设"
        marker={{ label: "config.json" }}
        badge={<span>只读</span>}
        desc="换位置后，旧位置的对话仍显示在「对话」里"
        error="保存失败"
      >
        <button type="button">编辑</button>
      </SettingsRow>,
    );
    expect(screen.getByText("默认权限预设")).toBeTruthy();
    expect(screen.getByText("config.json")).toBeTruthy();
    expect(screen.getByText("只读")).toBeTruthy();
    expect(screen.getByText("换位置后，旧位置的对话仍显示在「对话」里")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("保存失败");
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
  });

  it("SettingsRow：labelFor 让输入框获得可访问名称", () => {
    render(
      <SettingsRow label="完成提醒的阈值" labelFor="th">
        <input id="th" className="input sm-w" />
      </SettingsRow>,
    );
    expect(screen.getByRole("textbox", { name: "完成提醒的阈值" })).toBeTruthy();
  });

  it("SourceMarker：无 label 不渲染；warn / accent 变体带类名与 title", () => {
    const { container, rerender } = render(<SourceMarker />);
    expect(container.textContent).toBe("");

    rerender(<SourceMarker label="settings.json" />);
    expect(screen.getByText("settings.json").className).toBe("marker");

    rerender(<SourceMarker label="magpie.json" tone="warn" title="被覆盖" />);
    const warn = screen.getByText("magpie.json");
    expect(warn.className).toBe("marker warn");
    expect(warn.getAttribute("title")).toBe("被覆盖");

    rerender(<SourceMarker label="已编辑" tone="accent" />);
    expect(screen.getByText("已编辑").className).toBe("marker accent");
  });

  it("MasterDetail：左栏为导航，分组带计数，条目选中为 aria-current，详情区有标题与操作", () => {
    const onPick = vi.fn();
    render(
      <MasterDetail
        listLabel="服务商列表"
        list={
          <ListGroup title="已配置" count={2}>
            <ListItem label="openrouter" mono dot="ok" selected meta="当前" />
            <ListItem label="lab-vllm" mono dot="" off meta="已停用" onClick={onPick} />
          </ListGroup>
        }
        listFoot={<button type="button">添加服务商</button>}
      >
        <DetailHeader title="openrouter" mono actions={<button type="button">编辑</button>} />
      </MasterDetail>,
    );
    const nav = screen.getByRole("navigation", { name: "服务商列表" });
    expect(within(nav).getByText("已配置 · 2")).toBeTruthy();
    const current = within(nav).getByRole("button", { name: /openrouter/ });
    expect(current.getAttribute("aria-current")).toBe("true");
    const other = within(nav).getByRole("button", { name: /lab-vllm/ });
    expect(other.getAttribute("aria-current")).toBeNull();
    fireEvent.click(other);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(within(nav).getByRole("button", { name: "添加服务商" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "openrouter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
  });

  it("ListItem：名字元素禁止收缩，右侧 badge 与 meta 允许收缩，长 meta 不会把名字压没", () => {
    render(
      <ListItem
        label="enterprise-customer-portal"
        mono
        dot="warn"
        badge={<span className="badge">只读</span>}
        meta="0 项授权 · 没有项目配置 · 额外长说明文字"
      />,
    );
    const btn = screen.getByRole("button", { name: /enterprise-customer-portal/ });
    const nameEl = btn.querySelector(".name.trunc.mono");
    const badgeEl = btn.querySelector(".badge");
    const metaEl = btn.querySelector(".meta");
    expect(nameEl?.textContent).toBe("enterprise-customer-portal");
    expect(badgeEl?.textContent).toBe("只读");
    expect(metaEl?.textContent).toBe("0 项授权 · 没有项目配置 · 额外长说明文字");

    const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui.css");
    const css = readFileSync(cssPath, "utf8");
    const nameRule = /\.nav-item\s+\.trunc\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const shrinkRule =
      /\.nav-item\s+\.badge,\s*\.nav-item\s+\.meta\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(nameRule).toContain("flex-shrink: 0");
    expect(shrinkRule).toContain("flex-shrink: 1");
    expect(shrinkRule).toContain("min-width: 0");
  });

  it("DataTable：表头为 columnheader，数字列右对齐", () => {
    render(
      <DataTable
        aria-label="按模型用量"
        columns={[
          { key: "m", header: "模型", mono: true, render: (r: { m: string; n: number }) => r.m },
          { key: "n", header: "tokens", numeric: true, render: (r) => r.n },
        ]}
        rows={[
          { m: "a", n: 12 },
          { m: "b", n: 3 },
        ]}
        rowKey={(r) => r.m}
      />,
    );
    const table = screen.getByRole("table", { name: "按模型用量" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["模型", "tokens"]);
    expect(headers[1]?.className).toBe("r");
    const cell = within(table).getByRole("cell", { name: "12" });
    expect(cell.className).toBe("r");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("Field / Form / FormFooter：标签关联输入框，说明在下，底部状态在左、按钮在右", () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => {
      e.preventDefault();
    });
    render(
      <Form aria-label="添加 MCP 服务器" onSubmit={onSubmit}>
        <Field label="名称" htmlFor="m-name" desc="模型看到的工具前缀，创建后不能改">
          <input id="m-name" className="input lg mono" />
        </Field>
        <Field label="类型" error="必填">
          <span>seg</span>
        </Field>
        <FormFooter reason="测试通过">
          <button type="button">取消</button>
          <button type="submit">保存</button>
        </FormFooter>
      </Form>,
    );
    const form = screen.getByRole("form", { name: "添加 MCP 服务器" });
    expect(within(form).getByRole("textbox", { name: "名称" })).toBeTruthy();
    expect(within(form).getByText("模型看到的工具前缀，创建后不能改")).toBeTruthy();
    expect(within(form).getByRole("alert").textContent).toBe("必填");
    const foot = within(form).getByText("测试通过").parentElement;
    expect(foot?.className).toBe("form-foot");
    expect(Array.from(foot?.children ?? []).map((n) => n.textContent)).toEqual([
      "测试通过",
      "取消",
      "保存",
    ]);
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("EmptyState：整页与行内两种", () => {
    const { rerender } = render(
      <EmptyState action={<button type="button">添加服务器</button>}>还没有 MCP 服务器</EmptyState>,
    );
    expect(screen.getByText("还没有 MCP 服务器").parentElement?.className).toBe("empty");
    expect(screen.getByRole("button", { name: "添加服务器" })).toBeTruthy();

    rerender(<EmptyState inline>还没有项目授权</EmptyState>);
    expect(screen.getByText("还没有项目授权").className).toBe("inline-empty");
  });
});

describe("来源标记规则 (setting-source)", () => {
  it("默认值不显示标记", () => {
    expect(sourceMarker({ source: "default", overridden: false })).toBeUndefined();
    expect(sourceMarker(undefined)).toBeUndefined();
  });

  it("来自配置文件时显示文件名，普通样式", () => {
    expect(sourceMarker({ source: "user", overridden: false })).toEqual({ label: "config.json" });
    expect(sourceMarker({ source: "settings", overridden: false })).toEqual({
      label: "settings.json",
    });
  });

  it("被更高层覆盖时为 warn，并在 title 写明覆盖它的那一层", () => {
    const marker = sourceMarker({ source: "magpie", overridden: true });
    expect(marker?.tone).toBe("warn");
    expect(marker?.label).toBe("magpie.json");
    expect(marker?.title).toBe("保存的值被更高层（magpie.json）覆盖，改了也不生效");

    render(<SettingsRow label="压缩阈值" marker={marker} />);
    const el = screen.getByText("magpie.json");
    expect(el.className).toBe("marker warn");
    expect(el.getAttribute("title")).toContain("magpie.json");
  });
});
