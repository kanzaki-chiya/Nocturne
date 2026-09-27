/**
 * shell 选择（ADR-0022）测试：描述符调用形式、PowerShell 包装、
 * 安装探测（Git Bash 推导 / System32 回避 / 进程内缓存）、
 * NOCTURNE_SHELL 解析与四层优先级解析器。
 * 探测用 ShellProbe 假实现注入，不触碰真实安装环境。
 */
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import {
  createShellResolver,
  detectShells,
  encodePowerShellCommand,
  isShellKind,
  parseShellSpec,
  powershellScript,
  resetShellDetectionCache,
  shellDescriptor,
  shellSwitchNote,
  specFromConfigFields,
  type DetectedShell,
  type ShellProbe,
  type ShellSpec,
} from "./index.js";

const isWin = process.platform === "win32";

/** 假探测面：exists 查文件集合，env 查表 */
function fakeProbe(
  files: readonly string[],
  env: Record<string, string> = {},
): {
  probe: ShellProbe;
  calls: string[];
} {
  const set = new Set(files);
  const calls: string[] = [];
  return {
    calls,
    probe: {
      fs: {
        exists: (p) => {
          calls.push(p);
          return Promise.resolve(set.has(p));
        },
      },
      env: (n) => env[n],
    },
  };
}

const detected = (
  over: Partial<DetectedShell> & { kind: DetectedShell["kind"] },
): DetectedShell => ({
  name: over.kind,
  available: over.executable !== undefined,
  ...over,
});

describe("parseShellSpec（NOCTURNE_SHELL 值解析）", () => {
  it("种类名、auto、空值、大小写不敏感", () => {
    expect(parseShellSpec("pwsh")).toEqual({ kind: "pwsh" });
    expect(parseShellSpec("BASH")).toEqual({ kind: "bash" });
    expect(parseShellSpec("  auto  ")).toEqual({ kind: "auto" });
    expect(parseShellSpec("")).toEqual({ kind: "auto" });
  });

  it("路径/文件名：去目录与 .exe 后按种类名识别；含分隔符记为显式路径", () => {
    expect(parseShellSpec("pwsh.exe")).toEqual({ kind: "pwsh" });
    expect(parseShellSpec("C:\\tools\\bash.exe")).toEqual({
      kind: "bash",
      path: "C:\\tools\\bash.exe",
    });
    expect(parseShellSpec("/opt/pwsh/pwsh")).toEqual({ kind: "pwsh", path: "/opt/pwsh/pwsh" });
  });

  it("无法识别的值返回 invalid 并附说明", () => {
    const r = parseShellSpec("fish");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.reason).toContain("fish");
      expect(r.reason).toContain("auto");
    }
    // 文件名不含已知种类名的路径同样 invalid
    expect(parseShellSpec("C:\\tools\\zsh.exe").kind).toBe("invalid");
  });
});

describe("specFromConfigFields（config/settings 层值 → ShellSpec）", () => {
  it("shell 种类 + shellPath 组合；仅 shellPath 时按文件名推断", () => {
    expect(specFromConfigFields(undefined, undefined)).toBeUndefined();
    expect(specFromConfigFields("bash", undefined)).toEqual({ kind: "bash" });
    expect(specFromConfigFields("pwsh", "D:\\pwsh\\pwsh.exe")).toEqual({
      kind: "pwsh",
      path: "D:\\pwsh\\pwsh.exe",
    });
    expect(specFromConfigFields(undefined, "C:\\Program Files\\Git\\bin\\bash.exe")).toEqual({
      kind: "bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    // shellPath-only 且文件名识别不出种类 → 无有效声明（undefined，
    // 由调用层警告，不静默回退自动选择）
    expect(specFromConfigFields(undefined, "C:\\x\\weird.exe")).toBeUndefined();
    expect(specFromConfigFields("auto", undefined)).toEqual({ kind: "auto" });
    // 无法识别的种类名：该层无有效声明（忽略落下一层，不伪装成 auto 声明）
    expect(specFromConfigFields("nonsense", undefined)).toBeUndefined();
    // 推断出的种类 + 显式路径；文件不存在由 resolver materialize 硬报错
    expect(specFromConfigFields(undefined, "/opt/pwsh/pwsh")).toEqual({
      kind: "pwsh",
      path: "/opt/pwsh/pwsh",
    });
  });
});

describe("PowerShell 调用包装（ADR-0022 第 1 节）", () => {
  it("EncodedCommand 是 UTF-16LE Base64；脚本含 UTF-8 无 BOM 前奏与静默进度", () => {
    const enc = encodePowerShellCommand("Write-Output '你好'");
    const script = Buffer.from(enc, "base64").toString("utf16le");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain("$OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    // 用户命令以 UTF-8 Base64 内嵌，不经过额外引号层
    expect(script).toContain(Buffer.from("Write-Output '你好'", "utf8").toString("base64"));
  });

  it("退出语义：末句为原生命令取 $LASTEXITCODE，非原生按 $? 区分 0/1", () => {
    const script = powershellScript("x");
    expect(script).toContain("exit $global:LASTEXITCODE");
    // $? 只能在脚本块内部紧随用户语句读取（块外会被重置为 $true）：
    // 探针随用户源码一起编译执行
    expect(script).toContain("`$__nc_ok = `$?");
    expect(script).toContain("if ($__nc_ok) { exit 0 } else { exit 1 }");
    expect(script).toContain("catch { exit 1 }");
    // 原生判定走 AST + Get-Command Application
    expect(script).toContain("CommandType -eq 'Application'");
  });

  it("pwsh / powershell 描述符走 -NoLogo -NoProfile -NonInteractive -EncodedCommand", () => {
    for (const kind of ["pwsh", "powershell"] as const) {
      const d = shellDescriptor(kind, "C:\\ps\\pwsh.exe", "win32");
      const inv = d.invoke("ls");
      expect(inv.args.slice(0, 4)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      // 常规 Node 参数转义：verbatim 仅属于 cmd
      expect(inv.verbatimArgs).not.toBe(true);
    }
    expect(shellDescriptor("cmd", "cmd.exe", "win32").invoke("x").verbatimArgs).toBe(true);
    expect(shellDescriptor("bash", "bash.exe", "win32").invoke("x").verbatimArgs).not.toBe(true);
  });
});

describe("shell 探测（ADR-0022 第 2 节；win32）", () => {
  it.runIf(isWin)("Git Bash 由 git.exe 推导 bin/bash.exe，PATH 上裸 bash.exe 不入选", async () => {
    const system32Bash = join("C:\\Windows", "System32", "bash.exe");
    const { probe } = fakeProbe(
      [
        // git.exe 在 <Git>\cmd，bash 由 ../bin 推导
        join("C:\\Tools\\Git", "cmd", "git.exe"),
        join("C:\\Tools\\Git", "bin", "bash.exe"),
        // System32 bash（WSL 入口）真实存在但绝不能被选用
        system32Bash,
        join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        join("C:\\Windows", "System32", "cmd.exe"),
      ],
      {
        PATH: ["C:\\Tools\\Git\\cmd", "C:\\Windows\\System32"].join(";"),
        SystemRoot: "C:\\Windows",
        COMSPEC: join("C:\\Windows", "System32", "cmd.exe"),
      },
    );
    const list = await detectShells(probe);
    const bash = list.find((d) => d.kind === "bash");
    expect(bash?.available).toBe(true);
    expect(bash?.executable).toBe(join("C:\\Tools\\Git", "bin", "bash.exe"));
    expect(bash?.executable).not.toBe(system32Bash);
    // win32：cmd 永远可用，sh 不入选
    expect(list.find((d) => d.kind === "cmd")?.available).toBe(true);
    expect(list.find((d) => d.kind === "sh")?.available).toBe(false);
    // powershell 5.1 按系统目录探测
    expect(list.find((d) => d.kind === "powershell")?.executable).toBe(
      join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
  });

  it.runIf(isWin)("Git 缺失时回退 ProgramFiles 候选；两处都没有则 bash 不可用", async () => {
    const { probe } = fakeProbe([join("C:\\Program Files", "Git", "bin", "bash.exe")], {
      PATH: "",
      ProgramFiles: "C:\\Program Files",
    });
    const list = await detectShells(probe);
    expect(list.find((d) => d.kind === "bash")?.executable).toBe(
      join("C:\\Program Files", "Git", "bin", "bash.exe"),
    );

    const empty = fakeProbe([], { PATH: "", ProgramFiles: "C:\\Program Files" });
    const list2 = await detectShells(empty.probe);
    // System32 bash.exe 存在与否都不参与：探测面里它缺席即不可用
    expect(list2.find((d) => d.kind === "bash")?.available).toBe(false);
  });

  it.runIf(isWin)("pwsh 优先 PATH 命中，其次 ProgramFiles\\PowerShell\\7", async () => {
    const { probe } = fakeProbe([join("C:\\Program Files", "PowerShell", "7", "pwsh.exe")], {
      PATH: "",
      ProgramFiles: "C:\\Program Files",
    });
    const list = await detectShells(probe);
    expect(list.find((d) => d.kind === "pwsh")?.executable).toBe(
      join("C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    );
  });

  it.runIf(isWin)(
    "cmd：COMSPEC 须真实存在，否则回退 System32\\cmd.exe，都没有则不可用",
    async () => {
      // COMSPEC 指向不存在的文件 → 回退已知路径
      const { probe } = fakeProbe([join("C:\\Windows", "System32", "cmd.exe")], {
        PATH: "",
        COMSPEC: "D:\\gone\\cmd.exe",
        SystemRoot: "C:\\Windows",
      });
      const list = await detectShells(probe);
      expect(list.find((d) => d.kind === "cmd")?.executable).toBe(
        join("C:\\Windows", "System32", "cmd.exe"),
      );
      // 两者都不存在 → cmd 不可用（显式选择将走 error 路径）
      const none = fakeProbe([], { PATH: "", COMSPEC: "D:\\gone\\cmd.exe", SystemRoot: "C:\\W" });
      const list2 = await detectShells(none.probe);
      expect(list2.find((d) => d.kind === "cmd")?.available).toBe(false);
    },
  );

  it("探测结果按探测面进程内缓存", async () => {
    const { probe, calls } = fakeProbe([], { PATH: "" });
    const first = await detectShells(probe);
    const count = calls.length;
    const second = await detectShells(probe);
    expect(second).toBe(first);
    expect(calls.length).toBe(count);
    // resetShellDetectionCache 后同一探测面重新探测
    resetShellDetectionCache();
    const third = await detectShells(probe);
    expect(third).not.toBe(first);
    expect(calls.length).toBeGreaterThan(count);
  });
});

describe("createShellResolver（四层优先级）", () => {
  const detectedShells: DetectedShell[] = [
    detected({ kind: "pwsh", executable: "C:\\ps\\pwsh.exe" }),
    detected({ kind: "powershell", executable: "C:\\Windows\\ps51\\powershell.exe" }),
    detected({ kind: "bash", executable: "C:\\Git\\bin\\bash.exe" }),
    detected({ kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" }),
    detected({ kind: "sh" }),
  ];

  const makeResolver = (over?: {
    envValue?: string;
    config?: ShellSpec;
    settings?: () => ShellSpec | undefined;
    onWarning?: (m: string) => void;
    pathExists?: (p: string) => boolean;
  }) =>
    createShellResolver({
      platform: "win32",
      ...(over?.envValue !== undefined ? { envValue: over.envValue } : {}),
      ...(over?.config !== undefined ? { config: over.config } : {}),
      settings: over?.settings ?? (() => undefined),
      detected: detectedShells,
      pathExists: over?.pathExists ?? (() => true),
      ...(over?.onWarning !== undefined ? { onWarning: over.onWarning } : {}),
    });

  it("auto 按平台顺序取第一个可用（win32：pwsh → bash → cmd）", () => {
    const r = makeResolver();
    expect(r.current().selected).toBe("auto");
    expect(r.current().source).toBe("auto");
    expect(r.current().descriptor?.kind).toBe("pwsh");
    expect(r.environmentLine()).toContain("PowerShell 7");
  });

  it("优先级：NOCTURNE_SHELL > config.json > settings.json > auto", () => {
    const settings = vi.fn(() => ({ kind: "powershell" }) as ShellSpec);
    const r = makeResolver({ settings, config: { kind: "bash" }, envValue: "cmd" });
    expect(r.current().descriptor?.kind).toBe("cmd");
    expect(r.current().source).toBe("env");
    const r2 = makeResolver({ settings, config: { kind: "bash" } });
    expect(r2.current().descriptor?.kind).toBe("bash");
    expect(r2.current().source).toBe("config");
    const r3 = makeResolver({ settings });
    expect(r3.current().descriptor?.kind).toBe("powershell");
    expect(r3.current().source).toBe("settings");
  });

  it("settings 层 live 读取：值变化后 current() 立即反映（不在创建时快照）", () => {
    let spec: ShellSpec | undefined = { kind: "bash" };
    const r = makeResolver({ settings: () => spec });
    expect(r.current().descriptor?.kind).toBe("bash");
    spec = { kind: "cmd" };
    expect(r.current().descriptor?.kind).toBe("cmd");
    spec = undefined;
    expect(r.current().descriptor?.kind).toBe("pwsh"); // 回退 auto
  });

  it("生效层为 env/config 即报 overriddenBy（settings 有无值都报）", () => {
    const r = makeResolver({
      settings: () => ({ kind: "powershell" }),
      envValue: "cmd",
    });
    expect(r.current().overriddenBy).toBe("env");
    // settings 尚无值：写入目标被上层覆盖的事实同样要报告（ADR-0022 第 4 节顶部说明）
    expect(makeResolver({ envValue: "cmd" }).current().overriddenBy).toBe("env");
    const r2 = makeResolver({
      settings: () => ({ kind: "powershell" }),
      config: { kind: "bash" },
    });
    expect(r2.current().overriddenBy).toBe("config");
    expect(makeResolver({ config: { kind: "bash" } }).current().overriddenBy).toBe("config");
    // 生效层就是 settings 或 auto 时无覆盖提示
    expect(
      makeResolver({ settings: () => ({ kind: "powershell" }) }).current().overriddenBy,
    ).toBeUndefined();
    expect(makeResolver().current().overriddenBy).toBeUndefined();
  });

  it("probe：可用种类返回 descriptor；未安装/auto 无解时返回含可选项的 error", () => {
    const r = makeResolver();
    expect(r.probe("bash").descriptor?.kind).toBe("bash");
    const miss = r.probe("sh"); // sh 在 win32 探测中未安装
    expect(miss.descriptor).toBeUndefined();
    expect(miss.error).toContain("sh");
    expect(miss.error).toContain("pwsh");
    expect(r.probe("auto").descriptor?.kind).toBe("pwsh");
    // 全部不可用：auto 也无解
    const empty = createShellResolver({
      platform: "linux",
      settings: () => undefined,
      detected: [detected({ kind: "sh" })],
      pathExists: () => false,
    });
    expect(empty.probe("auto").error).toContain("未探测到可用 shell");
    expect(empty.probe("sh").error).toContain("未安装");
  });

  it("非法 NOCTURNE_SHELL：建 resolver 时报一次警告并回退 auto", () => {
    const warnings: string[] = [];
    const r = makeResolver({ envValue: "fish", onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fish");
    expect(r.current().source).toBe("env");
    expect(r.current().descriptor?.kind).toBe("pwsh"); // auto 兜底
  });

  it("显式选择未安装的 shell：error 列出可用项", () => {
    const r = makeResolver({ envValue: "sh" });
    const res = r.current();
    expect(res.descriptor).toBeUndefined();
    expect(res.error).toContain("sh");
    expect(res.error).toContain("pwsh");
    expect(res.error).toContain("bash");
    expect(res.error).toContain("cmd");
  });

  it("显式路径：pathExists 为真才可用，不存在时报错", () => {
    const r = makeResolver({
      config: { kind: "bash", path: "D:\\portable\\bash.exe" },
      pathExists: (p) => p === "D:\\portable\\bash.exe",
    });
    expect(r.current().descriptor?.executable).toBe("D:\\portable\\bash.exe");
    const missing = makeResolver({
      config: { kind: "bash", path: "D:\\gone\\bash.exe" },
      pathExists: () => false,
    });
    expect(missing.current().error).toContain("不存在");
  });

  it("config.json 指定 auto：显式回到自动选择（selected=auto, source=config）", () => {
    const r = makeResolver({ config: { kind: "auto" }, settings: () => ({ kind: "cmd" }) });
    expect(r.current().selected).toBe("auto");
    expect(r.current().source).toBe("config");
    expect(r.current().descriptor?.kind).toBe("pwsh");
    // settings 仍被上层覆盖
    expect(r.current().overriddenBy).toBe("config");
  });

  it("list() 返回全部探测结果（含未安装）", () => {
    const kinds = makeResolver()
      .list()
      .map((d) => d.kind);
    expect(kinds).toEqual(["pwsh", "powershell", "bash", "cmd", "sh"]);
  });
});

describe("shellSwitchNote（历史说明与环境信息同源）", () => {
  it("已知种类：名字 + 路径 + 语法说明；未知种类：回退格式", () => {
    const note = shellSwitchNote("pwsh", "C:\\ps\\pwsh.exe", "win32");
    expect(note).toContain("[Environment change]");
    expect(note).toContain("PowerShell 7 (pwsh)");
    expect(note).toContain("C:\\ps\\pwsh.exe");
    expect(note).toContain("PowerShell syntax");
    expect(shellSwitchNote("weird", "/x", "linux")).toBe(
      "[Environment change] shell is now weird (/x)",
    );
  });
});

describe("ShellDescriptor 元数据（交给 tools/permission 消费）", () => {
  it("分页器名单按种类：cmd/pwsh 含 more；bash/sh 含 more+less；pwsh 另含 flagPagers", () => {
    expect(shellDescriptor("cmd", "cmd.exe", "win32").pagers).toContain("more");
    expect(shellDescriptor("pwsh", "pwsh.exe", "win32").pagers).toContain("more");
    expect(shellDescriptor("pwsh", "pwsh.exe", "win32").pagers).not.toContain("less");
    expect(shellDescriptor("bash", "bash", "linux").pagers).toEqual(
      expect.arrayContaining(["more", "less"]),
    );
    const flagExes = shellDescriptor("pwsh", "pwsh.exe", "win32").flagPagers?.map((f) => f.exe);
    expect(flagExes).toEqual(["out-host", "oh"]);
  });

  it("大小写敏感性与方言：powershell/cmd 内建命令不区分大小写，posix 区分", () => {
    expect(shellDescriptor("pwsh", "pwsh", "win32").caseInsensitiveCommands).toBe(true);
    expect(shellDescriptor("cmd", "cmd.exe", "win32").caseInsensitiveCommands).toBe(true);
    expect(shellDescriptor("bash", "bash", "linux").caseInsensitiveCommands).toBe(false);
    expect(shellDescriptor("powershell", "powershell.exe", "win32").dialect).toBe("powershell");
    expect(shellDescriptor("cmd", "cmd.exe", "win32").dialect).toBe("cmd");
    expect(shellDescriptor("sh", "/bin/sh", "linux").dialect).toBe("posix");
  });

  it("风险元数据按种类集中（ADR-0022 第 1 节）：词表在描述符上、判定留权限层", () => {
    const base = [
      "rm -rf *",
      "rm -fr *",
      "sudo *",
      "git push --force*",
      "git push -f *",
      "git reset --hard*",
    ];
    for (const k of ["pwsh", "powershell", "bash", "cmd", "sh"] as const) {
      const risk = shellDescriptor(k, `${k}-exe`, "win32").risk;
      expect(risk.basePatterns).toEqual(base);
    }
    const ps = shellDescriptor("pwsh", "pwsh.exe", "win32").risk;
    expect(ps.caseInsensitive).toBe(true);
    expect(ps.dualParamVerbs?.verbs).toEqual(
      expect.arrayContaining(["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"]),
    );
    expect(ps.dualParamVerbs?.params).toEqual(["recurse", "force"]);
    expect(ps.alwaysVerbs).toEqual(
      expect.arrayContaining([
        "format-volume",
        "clear-disk",
        "stop-computer",
        "restart-computer",
        "invoke-expression",
        "iex",
      ]),
    );
    const cmd = shellDescriptor("cmd", "cmd.exe", "win32").risk;
    expect(cmd.caseInsensitive).toBe(true);
    expect(cmd.switchVerbs?.verbs).toEqual(["rd", "rmdir", "del", "erase"]);
    expect(cmd.alwaysVerbs).toEqual(["format"]);
    const bash = shellDescriptor("bash", "bash", "linux").risk;
    expect(bash.caseInsensitive).toBe(false);
    expect(bash.switchVerbs).toBeUndefined();
    expect(bash.dualParamVerbs).toBeUndefined();
    expect(bash.alwaysVerbs).toBeUndefined();
  });

  it("isShellKind 边界", () => {
    for (const k of ["pwsh", "powershell", "bash", "cmd", "sh"]) {
      expect(isShellKind(k)).toBe(true);
    }
    expect(isShellKind("auto")).toBe(false);
    expect(isShellKind("fish")).toBe(false);
  });
});
