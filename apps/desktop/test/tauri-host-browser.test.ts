/**
 * 面板浏览器的外壳命令（desktop.md 5.10）：前端只给地址、位置和事件通道，从不指定
 * webview 标签。标签由外壳生成（nct-browser-N），永远不会等于主界面的 main，
 * 所以 capability 不会匹配到浏览器。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((m: unknown) => void) | undefined;
  },
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "browser_create") return 7;
    if (cmd === "browser_capture") return new Uint8Array([1, 2, 3]).buffer;
    return null;
  }),
}));

import { createTauriHost } from "../src/tauri-host";

beforeEach(() => {
  calls.length = 0;
});

describe("浏览器外壳命令", () => {
  it("创建只传地址、位置和通道，不传 webview 标签", async () => {
    const browsers = createTauriHost().browsers;
    expect(browsers).toBeDefined();
    if (browsers === undefined) return;
    const id = await browsers.create("https://example.com/", null, () => undefined);
    expect(id).toBe(7);
    const create = calls.find((c) => c.cmd === "browser_create");
    expect(Object.keys(create?.args ?? {}).sort()).toEqual(["bounds", "channel", "url"]);
    expect(JSON.stringify(calls)).not.toMatch(/"label"|"main"/);
  });

  it("其余命令按 id 调用；截图返回 PNG 字节", async () => {
    const browsers = createTauriHost().browsers;
    if (browsers === undefined) return;
    await browsers.navigate(7, "https://example.org/");
    await browsers.layout(7, { x: 1, y: 2, width: 3, height: 4 });
    await browsers.layout(7, null);
    await browsers.action(7, "devtools");
    expect(await browsers.capture(7)).toEqual(new Uint8Array([1, 2, 3]));
    await browsers.destroy(7);
    expect(calls.map((c) => c.cmd)).toEqual([
      "browser_navigate",
      "browser_layout",
      "browser_layout",
      "browser_action",
      "browser_capture",
      "browser_destroy",
    ]);
    for (const call of calls) expect(call.args?.id).toBe(7);
  });
});
