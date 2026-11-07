import type { ApplicationTarget, Platform } from "@nocturne/core";
import type { PipeProcess } from "@nocturne/core";

export interface ApplicationEvidence {
  exePath?: string | undefined;
  packageFamilyName?: string | undefined;
  name?: string | undefined;
  title?: string | undefined;
  icon?: string | undefined;
  creationTime?: string | undefined;
}

export interface ResolveApplicationOptions {
  includeIcon?: boolean | undefined;
}

const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NocturneApplicationQuery {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] static extern int SHLoadIndirectString(string source, StringBuilder output, uint size, IntPtr reserved);
  public static string Localize(string source) {
    var output = new StringBuilder(4096);
    return SHLoadIndirectString(source, output, (uint)output.Capacity, IntPtr.Zero) == 0 ? output.ToString() : null;
  }
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder value, ref int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr h, ref uint size, StringBuilder value);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  public delegate bool Callback(IntPtr hwnd, IntPtr data);
  public static string GetCreationTime(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      long creation, exit, kernel, user;
      return GetProcessTimes(h, out creation, out exit, out kernel, out user) ? creation.ToString() : null;
    } finally { CloseHandle(h); }
  }
  public static string[] Resolve(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      int size = 32768; var path = new StringBuilder(size);
      if (!QueryFullProcessImageName(h, 0, path, ref size)) return null;
      uint length = 0; GetPackageFamilyName(h, ref length, null);
      var family = new StringBuilder((int)length);
      string package = length > 0 && GetPackageFamilyName(h, ref length, family) == 0 ? family.ToString() : null;
      long creation = 0, exit = 0, kernel = 0, user = 0;
      string ctime = GetProcessTimes(h, out creation, out exit, out kernel, out user) ? creation.ToString() : null;
      return new string[] { path.ToString(), package, ctime };
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
$iconCache = @{}
$nameCache = @{}
function Get-ApplicationName([string]$exePath, [string]$family) {
  $key = if ($family) { $family.ToLowerInvariant() } else { [IO.Path]::GetFileName($exePath).ToLowerInvariant() }
  if ($nameCache.ContainsKey($key)) { return $nameCache[$key] }
  $displayName = $null
  if ($family) {
    try {
      $package = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
      if ($package) {
        $manifest = Get-AppxPackageManifest -Package $package
        $displayName = [string]$manifest.Package.Properties.DisplayName
        if ($displayName -like 'ms-resource:*') {
          $resource = $displayName.Substring(12)
          $packageName = [string]$manifest.Package.Identity.Name
          $uris = if ($resource.StartsWith('//')) { @('ms-resource:' + $resource) }
            elseif ($resource.StartsWith('/')) { @('ms-resource://' + $packageName + $resource) }
            else { @(('ms-resource://' + $packageName + '/resources/' + $resource), ('ms-resource://' + $packageName + '/' + $resource)) }
          $displayName = $null
          foreach ($uri in $uris) {
            $displayName = [NocturneApplicationQuery]::Localize('@{' + $package.PackageFullName + '?' + $uri + '}')
            if ($displayName) { break }
          }
        }
      }
    } catch {}
    if (-not $displayName) { return $null }
  } else {
    try { $displayName = [Diagnostics.FileVersionInfo]::GetVersionInfo($exePath).FileDescription } catch {}
    if (-not $displayName) { $displayName = [IO.Path]::GetFileNameWithoutExtension($exePath) }
    if ($displayName -match '\.exe$') { $displayName = $displayName.Substring(0, $displayName.Length - 4) }
  }
  $nameCache[$key] = $displayName
  return $displayName
}
$drawingLoaded = $false
function Get-IconBase64([string]$exePath) {
  if (-not $exePath) { return $null }
  $key = $exePath.ToLowerInvariant()
  if ($iconCache.ContainsKey($key)) { return $iconCache[$key] }
  try {
    if (-not $script:drawingLoaded) { Add-Type -AssemblyName System.Drawing; $script:drawingLoaded = $true }
    $icon = [Drawing.Icon]::ExtractAssociatedIcon($exePath)
    if ($icon) {
      $bitmap = $icon.ToBitmap()
      $stream = [IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $b64 = [Convert]::ToBase64String($stream.ToArray())
        $iconCache[$key] = $b64
        return $b64
      } finally {
        $stream.Dispose()
        $bitmap.Dispose()
        $icon.Dispose()
      }
    }
  } catch {}
  return $null
}
function Send-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $reqId = 0
  try {
    $query = $line | ConvertFrom-Json
    $reqId = $query.id
    if ($query.op -eq 'ping') {
      Send-Json @{ id = $reqId; ok = $true }
      continue
    }
    if ($query.op -eq 'time') {
      $ctime = [NocturneApplicationQuery]::GetCreationTime([uint32]$query.pid)
      Send-Json @{ id = $reqId; creationTime = $ctime }
      continue
    }
    $processId = if ($null -ne $query.pid) { [uint32]$query.pid } else { [uint32]0 }
    $window = if ($null -ne $query.windowId) { [long]$query.windowId } else { [long]0 }
    if ($window -ne 0) {
      $windowProcess = [NocturneApplicationQuery]::WindowPid($window)
      if ($processId -ne 0 -and $windowProcess -ne $processId) {
        Send-Json @{ id = $reqId }
        continue
      }
      $processId = $windowProcess
    }
    if ($processId -eq 0 -and $query.identity) {
      $identity = [string]$query.identity
      if ($identity -like 'shell:appsFolder\*') {
        $family = ($identity -replace '^shell:appsFolder\\','').Split('!')[0]
        $package = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
        if ($package) { Send-Json @{ id = $reqId; packageFamilyName = $family; name = (Get-ApplicationName '' $family) } }
        else { Send-Json @{ id = $reqId } }
        continue
      }
      $command = Get-Command -Name $identity -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($command) {
        $res = @{ id = $reqId; exePath = $command.Source; name = (Get-ApplicationName $command.Source '') }
        if ($query.includeIcon -eq $true) { $res.icon = Get-IconBase64 $command.Source }
        Send-Json $res
      } else {
        Send-Json @{ id = $reqId }
      }
      continue
    }
    if ($processId -eq 0) {
      Send-Json @{ id = $reqId }
      continue
    }
    $resolved = [NocturneApplicationQuery]::Resolve($processId)
    if (-not $resolved) {
      Send-Json @{ id = $reqId }
      continue
    }
    $hostCreationTime = $resolved[2]
    $exePath = $resolved[0]
    $packageFamily = $resolved[1]
    if ([IO.Path]::GetFileName($exePath) -ieq 'ApplicationFrameHost.exe') {
      $candidates = @([NocturneApplicationQuery]::HostedPids($processId, $window) | ForEach-Object {
        $r = [NocturneApplicationQuery]::Resolve($_)
        if ($r -and $r[1]) { ,$r }
      })
      $families = @($candidates | ForEach-Object { $_[1] } | Select-Object -Unique)
      if ($families.Count -ne 1) {
        Send-Json @{ id = $reqId }
        continue
      }
      $packageFamily = $candidates[0][1]
      $childExe = $candidates[0][0]
      $displayName = Get-ApplicationName $childExe $packageFamily
      $res = @{ id = $reqId; exePath = $exePath; packageFamilyName = $packageFamily; name = $displayName; creationTime = $hostCreationTime }
      if ($query.includeIcon -eq $true) { $res.icon = Get-IconBase64 $childExe }
      Send-Json $res
      continue
    }
    $displayName = Get-ApplicationName $exePath $packageFamily
    $res = @{ id = $reqId; exePath = $exePath; packageFamilyName = $packageFamily; name = $displayName; creationTime = $hostCreationTime }
    if ($query.includeIcon -eq $true) { $res.icon = Get-IconBase64 $exePath }
    Send-Json $res
  } catch {
    Send-Json @{ id = $reqId }
  }
}
`;

export interface WindowsAppHelper {
  warmup(): Promise<void>;
  getCreationTime(pid: number): Promise<string | undefined>;
  resolve(
    target: ApplicationTarget,
    options?: ResolveApplicationOptions,
  ): Promise<ApplicationEvidence | undefined>;
  close(): Promise<void>;
}

export function createWindowsAppHelper(platform: Platform): WindowsAppHelper {
  let child: PipeProcess | undefined;
  let nextId = 0;
  const pending = new Map<number, (value: Record<string, unknown> | undefined) => void>();

  function failAll() {
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  }

  function ensureProcess(): PipeProcess | undefined {
    if (process.platform !== "win32") return undefined;
    if (child) return child;
    const proc = platform.process.spawnPipe(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        envMode: "minimal",
        envStrip: ["PSModulePath"],
      },
    );
    if (proc.pid <= 0) return undefined;
    child = proc;
    void (async () => {
      let buffer = "";
      try {
        for await (const chunk of proc.stdoutRaw) {
          buffer += chunk.toString("utf8");
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              const id = typeof parsed.id === "number" ? parsed.id : undefined;
              if (id !== undefined) {
                const handler = pending.get(id);
                if (handler) {
                  pending.delete(id);
                  handler(parsed);
                }
              }
            } catch {
              /* 忽略非 JSON 输出行 */
            }
          }
        }
      } finally {
        if (child === proc) child = undefined;
        failAll();
      }
    })();
    void (async () => {
      for await (const _chunk of proc.stderr) {
        /* 消费 stderr 防止管道阻塞 */
      }
    })();
    return proc;
  }

  async function request(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const proc = ensureProcess();
    if (!proc) return undefined;
    const id = ++nextId;
    return new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(undefined);
      }, 10_000);
      timer.unref();
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      try {
        proc.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
      } catch {
        if (pending.delete(id)) {
          clearTimeout(timer);
          resolve(undefined);
        }
      }
    });
  }

  return {
    async warmup() {
      await request({ op: "ping" });
    },
    async getCreationTime(pid) {
      const res = await request({ op: "time", pid });
      return typeof res?.creationTime === "string" && res.creationTime.length > 0
        ? res.creationTime
        : undefined;
    },
    async resolve(target, options) {
      const res = await request({
        op: "resolve",
        pid: target.pid,
        windowId: target.windowId,
        identity: target.identity,
        includeIcon: options?.includeIcon === true,
      });
      if (!res) return undefined;
      const result: ApplicationEvidence = {};
      for (const key of [
        "exePath",
        "packageFamilyName",
        "name",
        "title",
        "icon",
        "creationTime",
      ] as const) {
        if (typeof res[key] === "string" && res[key].length > 0) result[key] = res[key];
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
    async close() {
      const proc = child;
      child = undefined;
      failAll();
      if (!proc) return;
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      const exited = await Promise.race([
        proc
          .exited()
          .then(() => true)
          .catch(() => true),
        new Promise<boolean>((r) => {
          setTimeout(() => {
            r(false);
          }, 300);
        }),
      ]);
      if (!exited) {
        await proc.kill().catch(() => undefined);
      }
      proc.detachOutput();
    },
  };
}

export async function resolveWindowsApplication(
  platform: Platform,
  target: ApplicationTarget,
  options?: ResolveApplicationOptions,
): Promise<ApplicationEvidence | undefined> {
  const helper = createWindowsAppHelper(platform);
  try {
    return await helper.resolve(target, options);
  } finally {
    await helper.close();
  }
}
