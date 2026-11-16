/**
 * 设置 › 外观 自定义主题切片测试：
 * 主题条顺序与双面卡片、溢出渐隐与 80% 箭头滚动、铅笔编辑、新建/编辑/预览/校验、
 * 取消/关闭/Esc/遮罩、二次删除回退与删当前置 null、导出嵌套浮窗、导入严格校验与文件选择。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RpcClient } from "@nocturne/rpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expandCustomTheme,
  exportThemeJson,
  parseImportedTheme,
  type CustomTheme,
} from "../src/CustomThemeDialog";
import { SettingsPage, type AppearanceControls, type ThemePref } from "../src/SettingsPage";
import { previewThemeVars } from "../src/theme-presets";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FOG: CustomTheme = {
  id: "custom-fog1",
  name: "雾蓝",
  bg: "#f6f8fa",
  text: "#16202a",
  accent: "#2f6db5",
};

const MOSS: CustomTheme = {
  id: "custom-moss2",
  name: "苔绿",
  bg: "#11140f",
  text: "#e5eadf",
  accent: "#a3c98a",
};

function makeMockClient(updateImpl?: (patch: Record<string, unknown>) => Promise<never[]>) {
  const updateSettings = vi.fn(updateImpl ?? (() => Promise.resolve([])));
  const client = {
    runtime: {
      updateSettings,
    },
  } as unknown as RpcClient;
  return { client, updateSettings };
}

function renderAppearance({
  theme = "light",
  appearance = {},
  client,
}: {
  theme?: ThemePref;
  appearance?: Partial<AppearanceControls>;
  client?: RpcClient | undefined;
} = {}) {
  const controls: AppearanceControls = {
    uiFont: undefined,
    codeFont: undefined,
    fontSize: 14,
    themePreset: "workbench",
    customThemes: [],
    onThemeSelect: vi.fn(),
    onCustomThemesChange: vi.fn(),
    onChange: vi.fn(() => true),
    ...appearance,
  };
  const result = render(
    <SettingsPage
      section="appearance"
      client={client}
      theme={theme}
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
    />,
  );
  return { controls, ...result };
}

describe("自定义主题 UI 交互", () => {
  it("主题条按 5 预设后接自定义创建顺序排列，每张卡左亮右暗 1px 分割且不随当前模式变色", () => {
    const { container, rerender } = renderAppearance({
      theme: "light",
      appearance: { customThemes: [FOG, MOSS], themePreset: "custom-fog1" },
    });

    const radios = within(screen.getByRole("radiogroup", { name: "主题" })).getAllByRole("radio");
    expect(radios.map((el) => el.getAttribute("aria-label"))).toEqual([
      "工作台",
      "夜曲",
      "纸面",
      "青瓷",
      "松烟",
      "雾蓝",
      "苔绿",
    ]);

    const firstDual = radios[0]?.querySelector(".theme-dual");
    expect(firstDual).not.toBeNull();
    const minis = firstDual?.querySelectorAll<HTMLElement>(".theme-mini") ?? [];
    expect(minis).toHaveLength(2);
    expect(firstDual?.querySelector(".theme-dual-cut")).not.toBeNull();
    expect(minis[0]?.style.getPropertyValue("--a-bg")).toBe(
      previewThemeVars("workbench", "light")["--a-bg"],
    );
    expect(minis[1]?.style.getPropertyValue("--a-bg")).toBe(
      previewThemeVars("workbench", "dark")["--a-bg"],
    );

    // 切换页面深浅模式，卡片双面预览颜色不变
    rerender(
      <SettingsPage
        section="appearance"
        client={undefined}
        theme="dark"
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
        appearance={{
          uiFont: undefined,
          codeFont: undefined,
          fontSize: 14,
          themePreset: "custom-fog1",
          customThemes: [FOG, MOSS],
          onChange: () => true,
        }}
      />,
    );
    const darkModeFirstMinis = container.querySelectorAll<HTMLElement>(
      '[data-theme-id="workbench"] .theme-mini',
    );
    expect(darkModeFirstMinis[0]?.style.getPropertyValue("--a-bg")).toBe("#ffffff");
    expect(darkModeFirstMinis[1]?.style.getPropertyValue("--a-bg")).toBe("#0b0b0d");
  });

  it("溢出时仅在有剩余内容侧显示渐隐与圆箭头，点击按 80% 宽度滚动，打开设置选中卡可见", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    let scrollLeft = 0;
    let clientWidth = 500;
    let scrollWidth = 1200;

    const { container } = renderAppearance({
      appearance: { customThemes: [FOG, MOSS], themePreset: "custom-moss2" },
    });

    const wrap = container.querySelector(".theme-strip-wrap") as HTMLElement;
    const strip = screen.getByRole("radiogroup", { name: "主题" });

    Object.defineProperty(strip, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
    });
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => clientWidth });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => scrollWidth });
    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy;

    // 初始打开设置时将选中卡滚入视野
    expect(scrollIntoView).toHaveBeenCalled();

    // 仅右侧有剩余内容
    scrollLeft = 0;
    fireEvent.scroll(strip);
    expect(wrap.classList.contains("cl")).toBe(false);
    expect(wrap.classList.contains("cr")).toBe(true);
    expect(screen.queryByRole("button", { name: "向左" })).toBeNull();
    const rightBtn = screen.getByRole("button", { name: "向右" });
    fireEvent.click(rightBtn);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 400, behavior: "smooth" });

    // 两侧都有剩余内容
    scrollLeft = 200;
    fireEvent.scroll(strip);
    expect(wrap.classList.contains("cl")).toBe(true);
    expect(wrap.classList.contains("cr")).toBe(true);
    const leftBtn = screen.getByRole("button", { name: "向左" });
    fireEvent.click(leftBtn);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -400, behavior: "smooth" });

    // 到达最右端：仅左侧有剩余内容
    scrollLeft = 700;
    fireEvent.scroll(strip);
    expect(wrap.classList.contains("cl")).toBe(true);
    expect(wrap.classList.contains("cr")).toBe(false);
    expect(screen.queryByRole("button", { name: "向右" })).toBeNull();
    expect(screen.getByRole("button", { name: "向左" })).toBeTruthy();

    // 无溢出：双侧都不显示箭头
    scrollLeft = 0;
    clientWidth = 1400;
    scrollWidth = 1200;
    fireEvent(window, new Event("resize"));
    expect(wrap.classList.contains("cl")).toBe(false);
    expect(wrap.classList.contains("cr")).toBe(false);
    expect(screen.queryByRole("button", { name: "向左" })).toBeNull();
    expect(screen.queryByRole("button", { name: "向右" })).toBeNull();
  });

  it("仅自定义卡片有编辑铅笔按钮，点铅笔打开编辑但不选中，点卡片其他位置选中", () => {
    const { controls } = renderAppearance({
      appearance: { customThemes: [FOG], themePreset: "workbench" },
    });

    const editButtons = screen.getAllByRole("button", { name: "编辑" });
    expect(editButtons).toHaveLength(1);
    const firstEdit = editButtons[0];
    if (!firstEdit) throw new Error("missing edit button");

    fireEvent.click(firstEdit);
    expect(controls.onThemeSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "编辑主题" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "雾蓝" }));
    expect(controls.onThemeSelect).toHaveBeenCalledWith("custom-fog1");
  });

  it("新建主题默认名称为「我的主题」、颜色取选中主题当前 mode，实时双面预览与非法 hex 失焦恢复", async () => {
    const { client, updateSettings } = makeMockClient();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const { controls } = renderAppearance({
      client,
      theme: "dark",
      appearance: { themePreset: "paper", customThemes: [] },
    });

    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    const dlg = screen.getByRole("dialog", { name: "新建主题" });
    expect(within(dlg).queryByText("删除")).toBeNull();
    expect(within(dlg).queryByText("导出")).toBeNull();

    const nameInput = within(dlg).getByRole("textbox", { name: "名称" }) as HTMLInputElement;
    expect(nameInput.value).toBe("我的主题");

    // 纸面 dark 模式种子色
    const bgHex = within(dlg).getByRole("textbox", { name: "背景" }) as HTMLInputElement;
    const textHex = within(dlg).getByRole("textbox", { name: "文字" }) as HTMLInputElement;
    const accentHex = within(dlg).getByRole("textbox", { name: "强调" }) as HTMLInputElement;
    expect(bgHex.value).toBe("#171512");
    expect(textHex.value).toBe("#ece6da");
    expect(accentHex.value).toBe("#d9a46c");

    // 右侧亮/暗双迷你应用预览，实时响应三色变化且整块 inert
    const previews = dlg.querySelectorAll<HTMLElement>(".theme-app-pv");
    expect(previews).toHaveLength(2);
    expect(previews[0]?.hasAttribute("inert")).toBe(true);
    expect(previews[1]?.hasAttribute("inert")).toBe(true);
    expect(previews[1]?.style.getPropertyValue("--a-bg")).toBe("#171512");

    // 输入合法 hex 实时更新色块与预览
    fireEvent.change(bgHex, { target: { value: "#f0f4f8" } });
    expect(bgHex.classList.contains("bad")).toBe(false);
    expect(previews[0]?.style.getPropertyValue("--a-bg")).toBe("#f0f4f8");

    // 输入非法 hex 红边，blur 恢复上一次合法值
    fireEvent.change(bgHex, { target: { value: "#zzz" } });
    expect(bgHex.classList.contains("bad")).toBe(true);
    fireEvent.blur(bgHex);
    expect(bgHex.classList.contains("bad")).toBe(false);
    expect(bgHex.value).toBe("#f0f4f8");

    // 通过原生 color input 修改强调色
    const accentColor = dlg.querySelectorAll<HTMLInputElement>('input[type="color"]')[2];
    if (!accentColor) throw new Error("missing accent color input");
    fireEvent.change(accentColor, { target: { value: "#225588" } });
    expect(accentHex.value).toBe("#225588");

    fireEvent.change(nameInput, { target: { value: "  海雾  " } });
    fireEvent.click(within(dlg).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const patch = updateSettings.mock.calls[0]?.[0] as {
      "appearance.customThemes": CustomTheme[];
      "appearance.themePreset": string;
    };
    expect(patch["appearance.customThemes"]).toHaveLength(1);
    const saved = patch["appearance.customThemes"][0];
    if (!saved) throw new Error("missing saved theme");
    expect(saved.id).toMatch(/^custom-[a-z0-9]+$/);
    expect(saved.name).toBe("海雾");
    expect(saved.bg).toBe("#f0f4f8");
    expect(saved.accent).toBe("#225588");
    expect(patch["appearance.themePreset"]).toBe(saved.id);
    expect(controls.onCustomThemesChange).toHaveBeenCalledWith([saved], saved.id);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("取消 / 关闭 / Esc / 点击遮罩都不保存", () => {
    const { client, updateSettings } = makeMockClient();
    const { controls } = renderAppearance({
      client,
      appearance: { customThemes: [FOG], themePreset: "custom-fog1" },
    });

    const openEdit = () => {
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      const dlg = screen.getByRole("dialog", { name: "编辑主题" });
      fireEvent.change(within(dlg).getByRole("textbox", { name: "名称" }), {
        target: { value: "未保存改动" },
      });
      return dlg;
    };

    // 取消
    fireEvent.click(within(openEdit()).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // 关闭按钮
    fireEvent.click(within(openEdit()).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Esc 键
    openEdit();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // 点击遮罩
    const dlg = openEdit();
    const scrim = dlg.parentElement;
    if (!scrim) throw new Error("missing scrim");
    fireEvent.mouseDown(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(controls.onCustomThemesChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "雾蓝" })).toBeTruthy();
  });

  it("删除需二次确认，点别处恢复；删非当前主题不写 themePreset，删当前主题写 themePreset: null", async () => {
    const { client, updateSettings } = makeMockClient();
    renderAppearance({
      client,
      appearance: { customThemes: [FOG, MOSS], themePreset: "custom-fog1" },
    });

    // 先编辑非当前主题「苔绿」
    const editBtns = screen.getAllByRole("button", { name: "编辑" });
    const mossEdit = editBtns[1];
    if (!mossEdit) throw new Error("missing second edit button");
    fireEvent.click(mossEdit);
    const dlg = screen.getByRole("dialog", { name: "编辑主题" });

    // 第一次点击删除 -> 确认删除；点别处恢复为删除
    const delBtn = within(dlg).getByRole("button", { name: "删除" });
    fireEvent.click(delBtn);
    expect(delBtn.textContent).toBe("确认删除");
    fireEvent.click(within(dlg).getByRole("textbox", { name: "名称" }));
    expect(delBtn.textContent).toBe("删除");

    // 连续两次点击确认删除非当前主题
    fireEvent.click(delBtn);
    fireEvent.click(delBtn);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(updateSettings).toHaveBeenLastCalledWith({
      "appearance.customThemes": [FOG],
    });
    expect(screen.queryByRole("radio", { name: "苔绿" })).toBeNull();

    // 删除当前选中的主题「雾蓝」 -> themePreset: null 并回到工作台
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const delCurrent = screen.getByRole("button", { name: "删除" });
    fireEvent.click(delCurrent);
    fireEvent.click(delCurrent);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(updateSettings).toHaveBeenLastCalledWith({
      "appearance.customThemes": [],
      "appearance.themePreset": null,
    });
    expect(screen.getByRole("radio", { name: "工作台" }).getAttribute("aria-checked")).toBe("true");
  });

  it("导出嵌套浮窗显示 readonly 2 空格 JSON，仅复制按钮且成功变为已复制，关闭返回编辑保留草稿", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderAppearance({
      appearance: { customThemes: [FOG], themePreset: "custom-fog1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const editDlg = screen.getByRole("dialog", { name: "编辑主题" });
    fireEvent.change(within(editDlg).getByRole("textbox", { name: "名称" }), {
      target: { value: "雾蓝改" },
    });

    fireEvent.click(within(editDlg).getByRole("button", { name: "导出" }));
    const expDlg = screen.getByRole("dialog", { name: "导出主题" });
    const textarea = expDlg.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe(
      exportThemeJson({ name: "雾蓝改", bg: FOG.bg, text: FOG.text, accent: FOG.accent }),
    );
    expect(textarea.value).toBe(
      JSON.stringify(
        {
          nocturneTheme: 1,
          name: "雾蓝改",
          bg: "#f6f8fa",
          text: "#16202a",
          accent: "#2f6db5",
        },
        null,
        2,
      ),
    );

    const buttons = within(expDlg).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") || b.textContent)).toEqual([
      "关闭",
      "复制",
    ]);

    await act(async () => {
      fireEvent.click(within(expDlg).getByRole("button", { name: "复制" }));
    });
    expect(writeText).toHaveBeenCalledWith(textarea.value);
    expect(within(expDlg).getByRole("button", { name: "已复制" })).toBeTruthy();

    fireEvent.click(within(expDlg).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "导出主题" })).toBeNull();
    const returnedEdit = screen.getByRole("dialog", { name: "编辑主题" });
    expect(
      (within(returnedEdit).getByRole("textbox", { name: "名称" }) as HTMLInputElement).value,
    ).toBe("雾蓝改");
  });

  it("导入校验：失败红边与错误文案；选择 .json 文件与合法 JSON 导入生成 custom- id 并选中保存", async () => {
    const { client, updateSettings } = makeMockClient();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    renderAppearance({ client, appearance: { customThemes: [FOG] } });

    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    const impDlg = screen.getByRole("dialog", { name: "导入主题" });
    const textarea = impDlg.querySelector("textarea") as HTMLTextAreaElement;

    // 失败案例
    fireEvent.change(textarea, { target: { value: '{"nocturneTheme":2,"name":"x"}' } });
    fireEvent.click(within(impDlg).getByRole("button", { name: "导入" }));
    expect(textarea.classList.contains("bad")).toBe(true);
    expect(within(impDlg).getByRole("alert").textContent).toBe("不是有效的主题文件");
    expect(updateSettings).not.toHaveBeenCalled();

    // 选择文件导入合法 JSON（含大写 hex 与额外字段）
    const fileInput = impDlg.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toBe(".json,application/json");
    const jsonPayload = JSON.stringify({
      nocturneTheme: 1,
      name: "  新主题  ",
      bg: "#ABCDEF",
      text: "#112233",
      accent: "#445566",
      extra: "ignored",
      id: "ignored-id",
    });
    const file = new File([jsonPayload], "theme.json", { type: "application/json" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(textarea.value).toBe(jsonPayload);
    expect(textarea.classList.contains("bad")).toBe(false);

    fireEvent.click(within(impDlg).getByRole("button", { name: "导入" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    const patch = updateSettings.mock.calls[0]?.[0] as {
      "appearance.customThemes": CustomTheme[];
      "appearance.themePreset": string;
    };
    const imported = patch["appearance.customThemes"][1];
    if (!imported) throw new Error("missing imported theme");
    expect(imported).toEqual({
      id: expect.stringMatching(/^custom-[a-z0-9]+$/),
      name: "新主题",
      bg: "#abcdef",
      text: "#112233",
      accent: "#445566",
    });
    expect(patch["appearance.themePreset"]).toBe(imported.id);
    expect(screen.getByRole("radio", { name: "新主题" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("导入校验与双面推算规则", () => {
  it("严格校验 nocturneTheme: 1、非空且 ≤24 码点名称、#rrggbb、忽略多余字段", () => {
    expect(parseImportedTheme("not json")).toBeNull();
    expect(
      parseImportedTheme(
        JSON.stringify({
          nocturneTheme: "1",
          name: "a",
          bg: "#112233",
          text: "#445566",
          accent: "#778899",
        }),
      ),
    ).toBeNull();
    expect(
      parseImportedTheme(
        JSON.stringify({
          nocturneTheme: 1,
          name: "   ",
          bg: "#112233",
          text: "#445566",
          accent: "#778899",
        }),
      ),
    ).toBeNull();
    // 25 码点失败
    expect(
      parseImportedTheme(
        JSON.stringify({
          nocturneTheme: 1,
          name: "a".repeat(25),
          bg: "#112233",
          text: "#445566",
          accent: "#778899",
        }),
      ),
    ).toBeNull();
    // 24 个 emoji（UTF-16 长度 48，但码点数为 24）应当通过
    const emojis24 = "🎨".repeat(24);
    const okEmoji = parseImportedTheme(
      JSON.stringify({
        nocturneTheme: 1,
        name: emojis24,
        bg: "#AABBCC",
        text: "#112233",
        accent: "#445566",
        side: "#000000",
      }),
    );
    expect(okEmoji).toEqual({
      id: expect.stringMatching(/^custom-[a-z0-9]+$/),
      name: emojis24,
      bg: "#aabbcc",
      text: "#112233",
      accent: "#445566",
    });
    // 3 位简写 hex 不接受
    expect(
      parseImportedTheme(
        JSON.stringify({
          nocturneTheme: 1,
          name: "ok",
          bg: "#fff",
          text: "#112233",
          accent: "#445566",
        }),
      ),
    ).toBeNull();
  });

  it("expandCustomTheme 从单套种子推算亮暗双面", () => {
    const lightExpanded = expandCustomTheme(FOG);
    expect(lightExpanded.light.bg).toBe("#f6f8fa");
    expect(lightExpanded.dark.bg).toMatch(/^#[0-9a-f]{6}$/);
    expect(lightExpanded.dark.bg).not.toBe(lightExpanded.light.bg);

    const darkExpanded = expandCustomTheme(MOSS);
    expect(darkExpanded.dark.bg).toBe("#11140f");
    expect(darkExpanded.light.bg).toMatch(/^#[0-9a-f]{6}$/);
    expect(darkExpanded.light.bg).not.toBe(darkExpanded.dark.bg);
  });
});
