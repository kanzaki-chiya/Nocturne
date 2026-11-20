/**
 * 「文件」标签顶栏的「打开」分裂按钮与菜单（ADR-0060 修订 2026-11-21、ADR-0102）：
 * 左半的去向（系统默认 → 第一项 → 脚本与查询失败交给系统默认程序 → 禁用）、应用组的排序与兜底、
 * 各组按条件显示、复制 / 资源管理器 / 另存为调用对的函数、自动换行开关。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FAILED_APP_LIST,
  FileOpenButton,
  appEntries,
  openTarget,
  type FileOpenActions,
  type FileOpenButtonProps,
} from "../src/FileOpenMenu";
import type { FileApp, FileAppList } from "../src/host";

afterEach(() => {
  cleanup();
});

const ICON = "data:image/png;base64,iVBORw0KGgo=";

function app(id: string, name: string, extra: Partial<FileApp> = {}): FileApp {
  return { id, name, isDefault: false, ...extra };
}

function list(overrides: Partial<FileAppList> = {}): FileAppList {
  return { apps: [], launchesCode: false, failed: false, editorIcons: {}, ...overrides };
}

function actions(overrides: Partial<FileOpenActions> = {}): FileOpenActions {
  return {
    listApps: vi.fn(async () => list()),
    openWithApp: vi.fn(async () => undefined),
    openDefault: vi.fn(async () => undefined),
    editors: { vscode: true, cursor: false },
    openInEditor: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    openInBrowser: vi.fn(async () => undefined),
    browserLabel: "在浏览器标签打开",
    ...overrides,
  };
}

function renderButton(overrides: Partial<FileOpenButtonProps> = {}) {
  const props: FileOpenButtonProps = {
    path: "Z:\\proj\\src\\a.ts",
    line: 12,
    missing: false,
    html: false,
    relativePath: "src\\a.ts",
    onSaveAs: vi.fn(),
    wrap: true,
    onWrap: vi.fn(),
    actions: actions(),
    onError: vi.fn(),
    ...overrides,
  };
  render(<FileOpenButton {...props} />);
  return props;
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "打开方式" }));
  return screen.findByRole("menu", { name: "打开方式" });
}

function itemLabels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? "");
}

describe("openTarget：左半「打开」的去向", () => {
  it("系统默认程序优先，没有默认时用列表第一项", () => {
    const a = app("app-a", "A");
    const b = app("app-b", "B", { isDefault: true });
    expect(openTarget(list({ apps: [a, b] }))).toEqual({ kind: "app", app: b });
    expect(openTarget(list({ apps: [a] }))).toEqual({ kind: "app", app: a });
  });
  it("脚本类与查询失败交给系统默认程序（脚本由外壳改为在资源管理器中显示），空列表禁用", () => {
    expect(openTarget(list({ launchesCode: true }))).toEqual({ kind: "default" });
    expect(openTarget(FAILED_APP_LIST)).toEqual({ kind: "default" });
    expect(openTarget(list())).toEqual({ kind: "none" });
  });
});

describe("appEntries：应用组", () => {
  it("保持外壳给的顺序（默认在前由外壳排好），没有图标时退回 code 图标", () => {
    const entries = appEntries(
      list({
        apps: [
          app("app-1", "Visual Studio Code", { isDefault: true, iconDataUrl: ICON }),
          app("app-2", "记事本"),
        ],
      }),
      "Z:\\a.ts",
      undefined,
      false,
      actions(),
    );
    expect(entries.map((e) => e.label)).toEqual(["Visual Studio Code", "记事本"]);
    expect(entries[0]?.icon).toEqual({ src: ICON });
    expect(entries[1]?.icon).toEqual({ glyph: "code" });
  });
  it("查询失败：退回检测到的 VS Code / Cursor 加「系统默认程序」", () => {
    const entries = appEntries(
      { ...FAILED_APP_LIST, editorIcons: { vscode: ICON } },
      "Z:\\a.ts",
      3,
      false,
      actions({ editors: { vscode: true, cursor: true } }),
    );
    expect(entries.map((e) => e.label)).toEqual(["VS Code", "Cursor", "系统默认程序"]);
    expect(entries[0]?.icon).toEqual({ src: ICON });
    expect(entries[1]?.icon).toEqual({ glyph: "code" });
  });
  it("脚本类（列表为空、未失败）只剩检测到的编辑器，没有「系统默认程序」", () => {
    const entries = appEntries(
      list({ launchesCode: true }),
      "Z:\\a.ps1",
      undefined,
      false,
      actions(),
    );
    expect(entries.map((e) => e.label)).toEqual(["VS Code"]);
  });
  it("HTML 在系统应用之后加浏览器项", () => {
    const entries = appEntries(
      list({ apps: [app("app-e", "Microsoft Edge", { isDefault: true })] }),
      "Z:\\a.html",
      undefined,
      true,
      actions(),
    );
    expect(entries.map((e) => e.label)).toEqual(["Microsoft Edge", "在浏览器标签打开"]);
    expect(entries[1]?.icon).toEqual({ glyph: "earth" });
  });
});

describe("FileOpenButton", () => {
  it("左半用系统默认程序打开，带上行号", async () => {
    const a = actions({
      listApps: vi.fn(async () =>
        list({ apps: [app("app-x", "X"), app("app-d", "D", { isDefault: true })] }),
      ),
    });
    renderButton({ actions: a });
    const main = screen.getByRole("button", { name: "打开" });
    fireEvent.click(main);
    await waitFor(() => {
      expect(a.openWithApp).toHaveBeenCalledWith("Z:\\proj\\src\\a.ts", "app-d", 12);
    });
    expect(a.openDefault).not.toHaveBeenCalled();
  });

  it("脚本类：左半交给系统默认程序（外壳改为在资源管理器中显示）", async () => {
    const a = actions({ listApps: vi.fn(async () => list({ launchesCode: true })) });
    renderButton({ actions: a, path: "Z:\\proj\\run.ps1", relativePath: "run.ps1" });
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    await waitFor(() => {
      expect(a.openDefault).toHaveBeenCalledWith("Z:\\proj\\run.ps1");
    });
    expect(a.openWithApp).not.toHaveBeenCalled();
  });

  it("查询失败（抛错）：左半走系统默认程序，菜单退回编辑器与「系统默认程序」", async () => {
    const a = actions({
      listApps: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    renderButton({ actions: a });
    const menu = await openMenu();
    expect(itemLabels(menu).slice(0, 2)).toEqual(["VS Code", "系统默认程序"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "VS Code" }));
    await waitFor(() => {
      expect(a.openInEditor).toHaveBeenCalledWith("vscode", "Z:\\proj\\src\\a.ts", 12);
    });
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    await waitFor(() => {
      expect(a.openDefault).toHaveBeenCalledWith("Z:\\proj\\src\\a.ts");
    });
  });

  it("列表为空且不是脚本：左半禁用", async () => {
    renderButton({ actions: actions({ editors: { vscode: false, cursor: false } }) });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "打开" }).hasAttribute("disabled")).toBe(true);
    });
  });

  it("菜单分组：应用、文件、视图，每次打开都重新查询", async () => {
    const listApps = vi.fn(async () =>
      list({ apps: [app("app-c", "Visual Studio Code", { isDefault: true, iconDataUrl: ICON })] }),
    );
    renderButton({ actions: actions({ listApps }) });
    const menu = await openMenu();
    expect(itemLabels(menu)).toEqual([
      "Visual Studio Code",
      "在资源管理器中打开",
      "另存为…",
      "复制绝对路径",
      "复制相对路径",
      "自动换行✓",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(menu.querySelector("img")?.getAttribute("src")).toBe(ICON);
    const calls = listApps.mock.calls.length;
    fireEvent.keyDown(menu, { key: "Escape" });
    await openMenu();
    expect(listApps.mock.calls.length).toBe(calls + 1);
  });

  it("浏览器项只在 HTML 出现；工作区外没有「复制相对路径」；不是文本没有「自动换行」", async () => {
    renderButton({
      path: "D:\\x\\a.html",
      html: true,
      relativePath: undefined,
      wrap: undefined,
    });
    const menu = await openMenu();
    const labels = itemLabels(menu);
    expect(labels).toContain("在浏览器标签打开");
    expect(labels).not.toContain("复制相对路径");
    expect(labels.some((l) => l.startsWith("自动换行"))).toBe(false);
    cleanup();
    renderButton();
    expect(itemLabels(await openMenu())).not.toContain("在浏览器标签打开");
  });

  it("文件已不存在：左半禁用，菜单只剩两个复制项", async () => {
    const listApps = vi.fn(async () => list());
    renderButton({ missing: true, actions: actions({ listApps }) });
    expect(screen.getByRole("button", { name: "打开" }).hasAttribute("disabled")).toBe(true);
    const menu = await openMenu();
    expect(itemLabels(menu)).toEqual(["复制绝对路径", "复制相对路径"]);
    expect(within(menu).queryAllByRole("separator")).toHaveLength(0);
    expect(listApps).not.toHaveBeenCalled();
  });

  it("复制、资源管理器、另存为调用对应函数，参数正确；选完菜单关闭、焦点回箭头", async () => {
    const a = actions();
    const props = renderButton({ actions: a });
    const pickItem = async (name: string) => {
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name }));
      await waitFor(() => {
        expect(screen.queryByRole("menu")).toBeNull();
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开方式" }));
    };
    await pickItem("复制绝对路径");
    await waitFor(() => {
      expect(a.copy).toHaveBeenLastCalledWith("Z:\\proj\\src\\a.ts");
    });
    await pickItem("复制相对路径");
    await waitFor(() => {
      expect(a.copy).toHaveBeenLastCalledWith("src\\a.ts");
    });
    await pickItem("在资源管理器中打开");
    await waitFor(() => {
      expect(a.reveal).toHaveBeenCalledWith("Z:\\proj\\src\\a.ts");
    });
    await pickItem("另存为…");
    await waitFor(() => {
      expect(props.onSaveAs).toHaveBeenCalledTimes(1);
    });
  });

  it("操作失败把消息交给 onError", async () => {
    const onError = vi.fn();
    const a = actions({
      copy: vi.fn(async () => {
        throw new Error("剪贴板不可用");
      }),
    });
    renderButton({ actions: a, onError });
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "复制绝对路径" }));
    await waitFor(() => {
      expect(onError).toHaveBeenLastCalledWith("剪贴板不可用");
    });
  });

  it("「自动换行」是勾选项：显示当前状态，点了交出相反值，不抢初始焦点", async () => {
    const props = renderButton({ wrap: true });
    const menu = await openMenu();
    const wrap = within(menu).getByRole("menuitemcheckbox", { name: /自动换行/ });
    expect(wrap.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    fireEvent.click(wrap);
    await waitFor(() => {
      expect(props.onWrap).toHaveBeenCalledWith(false);
    });
  });

  it("键盘：↓ 移动，Enter 执行，Esc 关闭并把焦点还给箭头", async () => {
    const a = actions();
    renderButton({ actions: a });
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开方式" }));
  });
});
