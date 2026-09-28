import type { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { createClipboard } from "./clipboard.js";

describe("clipboard.readImage", () => {
  it("非 Windows 不启动命令", async () => {
    const run = vi.fn();
    expect(
      await createClipboard("linux", run as unknown as typeof execFile).readImage(),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("STA 编码脚本、隐藏进程、5 秒超时；空结果与 PNG 字节", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const run = vi.fn((_bin, _args, _opts, callback: (e: Error | null, s: string) => void) => {
      callback(null, Buffer.from(png).toString("base64"));
    });
    const clipboard = createClipboard("win32", run as unknown as typeof execFile);
    expect(await clipboard.readImage()).toEqual({ data: Buffer.from(png), mimeType: "image/png" });
    const [bin, args, opts] = run.mock.calls[0] ?? [];
    expect(bin).toBe("powershell.exe");
    expect(args).toContain("-STA");
    expect(args).toContain("-EncodedCommand");
    expect(args).not.toContain("-WindowStyle");
    expect(opts).toMatchObject({ timeout: 5000, windowsHide: true });
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString(
      "utf16le",
    );
    expect(script).toContain("[System.Windows.Forms.Clipboard]::GetImage()");
    expect(script).toContain("[System.Drawing.Imaging.ImageFormat]::Png");
    run.mockImplementation((_bin, _args, _opts, callback) => callback(null, ""));
    expect(await clipboard.readImage()).toBeUndefined();
    run.mockImplementation((_bin, _args, _opts, callback) => callback(new Error("ETIMEDOUT"), ""));
    await expect(clipboard.readImage()).rejects.toThrow("ETIMEDOUT");
  });
});
