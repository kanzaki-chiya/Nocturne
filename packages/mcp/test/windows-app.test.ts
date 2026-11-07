import { afterEach, expect, it } from "vitest";
import { createPlatform } from "@nocturne/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";
import { createWindowsAppHelper } from "../src/windows-app.js";

const cleanup = createProcessCleanup();
const platform = cleanup.platform(createPlatform());
afterEach(async () => cleanup.cleanup());

const testWindows = it.skipIf(process.platform !== "win32");
testWindows.each(["本地化软件", "ms-resource:AppName", "ms-resource:Resources/AppName"])(
  "包清单显示名 %s 解析；普通程序空 FileDescription 回退 exe 名",
  async (displayName) => {
    const directory = mkdtempSync(join(tmpdir(), "nocturne-app-name-"));
    const executable = join(directory, "empty.exe");
    writeFileSync(executable, "no version resource");
    const helper = createWindowsAppHelper({
      ...platform,
      process: {
        ...platform.process,
        spawnPipe(command, args, options) {
          const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
          const fixtures = String.raw`
function Get-AppxPackage { [pscustomobject]@{ PackageFamilyName = 'Test.Package_family'; PackageFullName = 'Test.Package_1'; Name = 'Internal.Package'; InstallLocation = 'C:\fixture' } }
function Get-AppxPackageManifest { [xml]'<Package><Identity Name="Test.Package"/><Properties><DisplayName>${displayName}</DisplayName></Properties></Package>' }
function Get-Command { [pscustomobject]@{ Source = '${executable.replaceAll("'", "''")}' } }
`;
          const modified = script
            .replace("$iconCache = @{}", fixtures + "\n$iconCache = @{}")
            .replace(
              "return SHLoadIndirectString(source, output, (uint)output.Capacity, IntPtr.Zero) == 0 ? output.ToString() : null;",
              'return source.Equals("@{Test.Package_1?ms-resource://Test.Package/resources/AppName}", StringComparison.OrdinalIgnoreCase) ? "本地化软件" : null;',
            );
          return platform.process.spawnPipe(
            command,
            [...args.slice(0, -1), Buffer.from(modified, "utf16le").toString("base64")],
            options,
          );
        },
      },
    });
    try {
      const packaged = await helper.resolve({
        identity: "shell:appsFolder\\Test.Package_family!App",
      });
      expect(packaged).toMatchObject({ name: "本地化软件" });
      expect(await helper.resolve({ identity: "empty.exe" })).toMatchObject({ name: "empty" });
    } finally {
      await helper.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
