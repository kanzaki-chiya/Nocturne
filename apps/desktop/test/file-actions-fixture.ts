import { vi } from "vitest";

import type { FileOpenActions } from "../src/FileOpenMenu";
import type { FileAppList } from "../src/host";

/** 「打开」菜单新增的操作（系统应用、默认程序、编辑器、复制）：给只关心别的标签的测试补齐 */
export function fileOpenActionsStub(
  list: FileAppList = { apps: [], launchesCode: false, failed: true, editorIcons: {} },
): Pick<
  FileOpenActions,
  "listApps" | "openWithApp" | "openDefault" | "editors" | "openInEditor" | "copy"
> {
  return {
    listApps: vi.fn(async () => list),
    openWithApp: vi.fn(async () => undefined),
    openDefault: vi.fn(async () => undefined),
    editors: { vscode: false, cursor: false },
    openInEditor: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
  };
}
