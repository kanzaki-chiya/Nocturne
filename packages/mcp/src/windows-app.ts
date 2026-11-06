import type { ApplicationTarget, Platform } from "@nocturne/core";

export interface ApplicationEvidence {
  exePath?: string | undefined;
  packageFamilyName?: string | undefined;
  name?: string | undefined;
  title?: string | undefined;
  icon?: string | undefined;
}

const QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NocturneApplicationQuery {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder value, ref int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr h, ref uint size, StringBuilder value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  public delegate bool Callback(IntPtr hwnd, IntPtr data);
  public static string[] Resolve(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      int size = 32768; var path = new StringBuilder(size);
      if (!QueryFullProcessImageName(h, 0, path, ref size)) return null;
      uint length = 0; GetPackageFamilyName(h, ref length, null);
      var family = new StringBuilder((int)length);
      string package = length > 0 && GetPackageFamilyName(h, ref length, family) == 0 ? family.ToString() : null;
      return new string[] { path.ToString(), package };
    } finally { CloseHandle(h); }
  }
  public static uint WindowPid(long window) { uint pid; GetWindowThreadProcessId(new IntPtr(window), out pid); return pid; }
  public static uint[] HostedPids(uint host, long window) {
    var found = new HashSet<uint>();
    Callback child = (h,d) => { uint p; GetWindowThreadProcessId(h,out p); if(p != 0 && p != host) found.Add(p); return true; };
    if(window != 0) EnumChildWindows(new IntPtr(window), child, IntPtr.Zero);
    else EnumWindows((h,d) => { uint p; GetWindowThreadProcessId(h,out p); if(p == host) EnumChildWindows(h,child,IntPtr.Zero); return true; },IntPtr.Zero);
    var result = new uint[found.Count]; found.CopyTo(result); return result;
  }
}
'@
$query = $env:NOCTURNE_APPLICATION_QUERY | ConvertFrom-Json
$processId = [uint32]$query.pid
$window = [long]$query.windowId
if ($window -ne 0) { $windowProcess = [NocturneApplicationQuery]::WindowPid($window); if ($processId -ne 0 -and $windowProcess -ne $processId) { exit 0 }; $processId = $windowProcess }
if ($processId -eq 0 -and $query.identity) {
  $identity = [string]$query.identity
  if ($identity -like 'shell:appsFolder\*') { $family = ($identity -replace '^shell:appsFolder\\','').Split('!')[0]; $package = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1; if ($package) { @{ packageFamilyName = $family; name = $package.Name } | ConvertTo-Json -Compress }; exit 0 }
  $command = Get-Command -Name $identity -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { @{ exePath = $command.Source; name = [IO.Path]::GetFileNameWithoutExtension($command.Source) } | ConvertTo-Json -Compress }
  exit 0
}
if ($processId -eq 0) { exit 0 }
$identity = [NocturneApplicationQuery]::Resolve($processId)
if (-not $identity) { exit 0 }
if ([IO.Path]::GetFileName($identity[0]) -ieq 'ApplicationFrameHost.exe') {
  $candidates = @([NocturneApplicationQuery]::HostedPids($processId, $window) | ForEach-Object { $resolved = [NocturneApplicationQuery]::Resolve($_); if ($resolved -and $resolved[1]) { ,$resolved } })
  $families = @($candidates | ForEach-Object { $_[1] } | Select-Object -Unique)
  if ($families.Count -ne 1) { exit 0 }
  $identity = $candidates[0]
}
$processInfo = Get-Process -Id $processId -ErrorAction SilentlyContinue
$displayName = [Diagnostics.FileVersionInfo]::GetVersionInfo($identity[0]).FileDescription
if (-not $displayName) { $displayName = [IO.Path]::GetFileNameWithoutExtension($identity[0]) }
$result = @{ exePath = $identity[0]; packageFamilyName = $identity[1]; name = $displayName; title = $processInfo.MainWindowTitle }
try {
  Add-Type -AssemblyName System.Drawing
  $icon = [Drawing.Icon]::ExtractAssociatedIcon($identity[0])
  if ($icon) { $bitmap = $icon.ToBitmap(); $stream = [IO.MemoryStream]::new(); try { $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png); $result.icon = [Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose(); $bitmap.Dispose(); $icon.Dispose() } }
} catch {}
$result | ConvertTo-Json -Compress
`;

export async function resolveWindowsApplication(
  platform: Platform,
  target: ApplicationTarget,
): Promise<ApplicationEvidence | undefined> {
  if (process.platform !== "win32") return undefined;
  const child = platform.process.spawnPipe(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(QUERY, "utf16le").toString("base64"),
    ],
    {
      envMode: "minimal",
      envStrip: ["PSModulePath"],
      env: { NOCTURNE_APPLICATION_QUERY: JSON.stringify(target) },
      timeoutMs: 10_000,
    },
  );
  child.stdin.end();
  const output: Buffer[] = [];
  const read = (async () => {
    for await (const chunk of child.stdoutRaw) output.push(chunk);
  })();
  const errors = (async () => {
    for await (const _chunk of child.stderr) {
      /* 单次身份探测失败由调用方保守处理。 */
    }
  })();
  const [exit] = await Promise.all([child.wait(), read, errors]);
  if (exit.code !== 0) return undefined;
  const text = Buffer.concat(output).toString("utf8").trim();
  if (!text) return undefined;
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  const result: ApplicationEvidence = {};
  for (const key of ["exePath", "packageFamilyName", "name", "title", "icon"] as const)
    if (typeof object[key] === "string") result[key] = object[key];
  return result;
}
