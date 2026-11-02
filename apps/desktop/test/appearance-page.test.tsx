/**
 * 设置 › 外观：主题、字体、预览三组；字体下拉（默认在首、按等宽分组、各自字体显示、对勾）、
 * 字号滑块与恢复默认、字体读取失败、存储不可写、预览复用对话区组件。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FontFamily } from "../src/appearance";
import { SettingsPage, type AppearanceControls } from "../src/SettingsPage";

afterEach(cleanup);

const FONTS: FontFamily[] = [
  { name: "Arial", mono: false },
  { name: "Consolas", mono: true },
  { name: "Fira Code", mono: true },
  { name: "Segoe UI", mono: false },
];

function page(appearance: Partial<AppearanceControls> = {}) {
  const controls: AppearanceControls = {
    uiFont: undefined,
    codeFont: undefined,
    fontSize: 14,
    listFonts: () => Promise.resolve(FONTS),
    onChange: vi.fn(() => true),
    ...appearance,
  };
  const element = (
    <SettingsPage
      section="appearance"
      client={undefined}
      theme="system"
      fileOpener="panel"
      editors={{ vscode: false, cursor: false }}
      workspace={null}
      defaultWorkspace={null}
      workspaceOverridden={false}
      onThemeChange={() => true}
      onFileOpenerChange={() => true}
      onWorkspaceChange={() => Promise.resolve(undefined)}
      pickFolder={() => Promise.resolve(null)}
      providersVersion={0}
      notifications={{ sendTest: () => Promise.resolve({ shown: true }) }}
      appearance={controls}
    />
  );
  return { controls, element };
}

function group(title: string): HTMLElement {
  return screen.getByRole("region", { name: title });
}

async function openList(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  return screen.findByRole("listbox", { name });
}

describe("设置 › 外观", () => {
  it("从上到下是主题、字体、预览；字体三行，不写多余文字", async () => {
    render(page().element);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["主题", "字体", "预览"]);
    const fonts = group("字体");
    // 只有这些词：分组标题、三行标签、两个「默认」、字号数值
    await waitFor(() => {
      expect(fonts.textContent).toBe("字体界面字体默认代码字体默认字号14");
    });
    expect(within(fonts).queryByRole("button", { name: "恢复默认" })).toBeNull();
    expect(within(fonts).queryByRole("alert")).toBeNull();
  });

  it("代码字体：默认在首，等宽在前、其余在后，组间分隔线，名字用各自字体显示", async () => {
    render(page({ codeFont: "Fira Code" }).element);
    const list = await openList("代码字体");
    await waitFor(() => {
      expect(within(list).getAllByRole("option")).toHaveLength(5);
    });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.querySelector("b")?.textContent)).toEqual([
      "默认",
      "Consolas",
      "Fira Code",
      "Arial",
      "Segoe UI",
    ]);
    expect(options.map((o) => o.classList.contains("sep"))).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(options[1]?.querySelector("b")?.style.fontFamily).toMatch(/^"?Consolas"?/);
    // 选中项有对勾
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
    expect(options[2]?.querySelector(".ck")?.textContent).toBe("✓");
    expect(options[1]?.querySelector(".ck")?.textContent).toBe("");
    // 搜索框不写占位字
    const search = screen.getByRole("textbox");
    expect(search.getAttribute("placeholder")).toBeNull();
    fireEvent.change(search, { target: { value: "cons" } });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Consolas"]);
  });

  it("界面字体：非等宽在前；选择与选回默认都立即写入", async () => {
    const { controls, element } = page();
    render(element);
    let list = await openList("界面字体");
    await waitFor(() => {
      expect(within(list).getAllByRole("option")).toHaveLength(5);
    });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.querySelector("b")?.textContent),
    ).toEqual(["默认", "Arial", "Segoe UI", "Consolas", "Fira Code"]);
    fireEvent.click(within(list).getByRole("option", { name: /Segoe UI/ }));
    expect(controls.onChange).toHaveBeenLastCalledWith({ uiFont: "Segoe UI" });

    cleanup();
    const second = page({ uiFont: "Segoe UI" });
    render(second.element);
    list = await openList("界面字体");
    fireEvent.click(within(list).getByRole("option", { name: /默认/ }));
    expect(second.controls.onChange).toHaveBeenLastCalledWith({ uiFont: undefined });
  });

  it("字号滑块 12–20、步长 1；偏离 14 才有恢复默认，点它回到默认", () => {
    const { controls, element } = page();
    const view = render(element);
    const slider = screen.getByRole("slider", { name: "字号" });
    expect([
      slider.getAttribute("min"),
      slider.getAttribute("max"),
      slider.getAttribute("step"),
    ]).toEqual(["12", "20", "1"]);
    fireEvent.change(slider, { target: { value: "20" } });
    expect(controls.onChange).toHaveBeenLastCalledWith({ fontSize: 20 });

    view.rerender(page({ fontSize: 20, onChange: controls.onChange }).element);
    fireEvent.change(screen.getByRole("slider", { name: "字号" }), { target: { value: "14" } });
    expect(controls.onChange).toHaveBeenLastCalledWith({ fontSize: undefined });
    const reset = screen.getByRole("button", { name: "恢复默认" });
    expect(reset.getAttribute("title")).toBe("恢复默认");
    expect(reset.textContent).toBe("");
    fireEvent.click(reset);
    expect(controls.onChange).toHaveBeenLastCalledWith({ fontSize: undefined });
  });

  it("读取本机字体失败：列表只剩默认，不显示错误文字", async () => {
    render(page({ listFonts: () => Promise.reject(new Error("boom")) }).element);
    const list = await openList("界面字体");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.querySelector("b")?.textContent),
    ).toEqual(["默认"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/boom|失败/)).toBeNull();
  });

  it("本机存储不可写：本次仍生效，和主题一样在分组下报错", () => {
    render(page({ onChange: () => false }).element);
    fireEvent.change(screen.getByRole("slider", { name: "字号" }), { target: { value: "16" } });
    expect(within(group("字体")).getByRole("alert").textContent).toBe(
      "本机存储不可写，字体只在本次运行内生效",
    );
  });

  it("预览用对话区的真实类名与组件：用户消息、行内代码、三行工具调用、代码块", () => {
    render(page().element);
    const preview = screen.getByTestId("appearance-preview");
    expect(preview.classList.contains("conversation")).toBe(true);
    expect(preview.hasAttribute("inert")).toBe(true);
    expect(preview.querySelector(".u-bubble")?.textContent).toContain("嵌套列表");
    expect(preview.querySelector(".conversation-markdown code")?.textContent).toBe("parse_list()");
    const lines = [...preview.querySelectorAll(".tool-line")];
    expect(lines.map((line) => line.querySelector(".tool-name")?.textContent)).toEqual([
      "应用补丁",
      "读取",
      "命令",
    ]);
    expect(lines[0]?.querySelector(".diff-add")?.textContent).toBe("+18");
    expect(lines[0]?.querySelector(".diff-del")?.textContent).toBe("−6");
    expect(preview.querySelector(".conversation-code pre code")?.textContent).toContain(
      "def parse_list",
    );
  });
});
