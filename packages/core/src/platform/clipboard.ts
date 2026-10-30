/** 读取系统剪贴板图片；Windows PowerShell 5.1 在 STA 中导出 PNG。 */
import { execFile as nodeExecFile } from "node:child_process";

const SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 0 }
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { exit 0 }
$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
  $stream.Dispose()
  $image.Dispose()
}`;

const FILES_SCRIPT = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Clipboard]::ContainsFileDropList()) { exit 0 }
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
[Console]::Out.Write((ConvertTo-Json -InputObject @($files | ForEach-Object { [string]$_ }) -Compress))`;

export interface Clipboard {
  readImage(): Promise<{ data: Uint8Array; mimeType: "image/png" } | undefined>;
  /** Windows CF_HDROP, preserving Explorer selection order. Empty on other platforms. */
  readFiles(): Promise<string[]>;
}

export function createClipboard(
  platform: NodeJS.Platform = process.platform,
  execFile: typeof nodeExecFile = nodeExecFile,
): Clipboard {
  return {
    readFiles() {
      if (platform !== "win32") return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-EncodedCommand",
            Buffer.from(FILES_SCRIPT, "utf16le").toString("base64"),
          ],
          { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
          (error, stdout) => {
            if (error !== null) {
              reject(error instanceof Error ? error : new Error("剪贴板读取失败"));
              return;
            }
            try {
              const files: unknown = stdout.trim() ? JSON.parse(stdout) : [];
              if (!Array.isArray(files) || !files.every((file) => typeof file === "string"))
                throw new Error("无效的剪贴板文件列表");
              resolve(files);
            } catch (e) {
              reject(e instanceof Error ? e : new Error("无效的剪贴板文件列表"));
            }
          },
        );
      });
    },
    readImage() {
      if (platform !== "win32") return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-EncodedCommand",
            Buffer.from(SCRIPT, "utf16le").toString("base64"),
          ],
          { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (error, stdout) => {
            if (error !== null) {
              reject(error instanceof Error ? error : new Error("剪贴板读取失败"));
              return;
            }
            const encoded = stdout.trim();
            resolve(
              encoded === ""
                ? undefined
                : { data: Buffer.from(encoded, "base64"), mimeType: "image/png" },
            );
          },
        );
      });
    },
  };
}
