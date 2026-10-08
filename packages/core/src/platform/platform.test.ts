import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  codepageToEncodingLabel,
  createNodeFileSystem,
  createPathOps,
  createPlatform,
  createProcessRunner,
  defaultShellInvocation,
  resolveRealPath,
  shellDescriptor,
} from "./index.js";
import { createProcessCleanup } from "../../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
afterEach(async () => {
  await processes.cleanup();
});

const isWin = process.platform === "win32";
const pathsSensitive = createPathOps(true);
const pathsInsensitive = createPathOps(false);

describe("shell 描述符与环境提示（ADR-0022）", () => {
  it("Windows cmd 使用 /d /s /c 并说明 cmd 语法", () => {
    const d = shellDescriptor("cmd", "C:\\Windows\\System32\\cmd.exe", "win32");
    expect(d.invoke("dir")).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"dir"'],
      verbatimArgs: true,
    });
    expect(d.description).toBe(
      'Commands run with cmd.exe (C:\\Windows\\System32\\cmd.exe) /d /s /c "<command>": use cmd syntax, not bash or PowerShell. `&` runs commands in sequence, not in the background; run long-running commands directly and raise timeoutMs when needed. findstr patterns use the console code page and cannot match non-ASCII text in UTF-8 output; use ASCII patterns only',
    );
  });

  it("POSIX sh 使用 -c 并说明 sh 语法", () => {
    const d = shellDescriptor("sh", "/bin/sh", "linux");
    expect(d.invoke("pwd")).toEqual({ executable: "/bin/sh", args: ["-c", "pwd"] });
    expect(d.description).toBe(
      'Commands run with POSIX sh (/bin/sh) -c "<command>": use POSIX sh syntax',
    );
    // `&` 顺序执行说明只属于 cmd 分支（POSIX sh 里 & 本来就是后台语义）
    expect(d.description).not.toContain("not in the background");
  });

  it("pwsh / powershell 走 -EncodedCommand（UTF-16LE Base64）", () => {
    for (const kind of ["pwsh", "powershell"] as const) {
      const d = shellDescriptor(kind, "pwsh.exe", "win32");
      const inv = d.invoke("echo 1");
      expect(inv.executable).toBe("pwsh.exe");
      expect(inv.args.slice(0, 4)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      // 负载是 UTF-16LE Base64 的包装脚本，内含 UTF-8 输出前奏与用户命令
      const script = Buffer.from(inv.args[4] ?? "", "base64").toString("utf16le");
      expect(script).toContain("[Console]::OutputEncoding");
      expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
      expect(script).toContain(Buffer.from("echo 1", "utf8").toString("base64"));
    }
  });

  it("Git Bash（win32）使用 -c 且不 verbatim", () => {
    const d = shellDescriptor("bash", "C:\\Program Files\\Git\\bin\\bash.exe", "win32");
    expect(d.name).toBe("Git Bash");
    const inv = d.invoke("echo hi");
    expect(inv.args).toEqual(["-c", "echo hi"]);
    expect(inv.verbatimArgs).toBeUndefined();
    expect(inv.verbatimArgs !== true).toBe(true);
  });

  it("默认调用回退平台默认 shell（win32→cmd，其余→sh）", () => {
    const inv = defaultShellInvocation("echo x");
    if (isWin) {
      expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(inv.verbatimArgs).toBe(true);
    } else {
      expect(inv.args).toEqual(["-c", "echo x"]);
    }
  });
});

describe("PathOps（纯词法）", () => {
  it("resolve 绝对化并消除 ..", () => {
    const p = pathsInsensitive.resolve("C:\\ws\\sub", "..\\other\\file.txt");
    expect(p).toBe(
      isWin ? "C:\\ws\\other\\file.txt" : path.resolve("C:\\ws\\sub", "..\\other\\file.txt"),
    );
  });

  it("canonicalize 在不敏感平台折叠大小写", () => {
    expect(pathsInsensitive.canonicalize("C:\\WS\\Foo.txt")).toBe("c:\\ws\\foo.txt");
    // 敏感平台保留大小写（分隔符按本机平台规范化）
    expect(pathsSensitive.canonicalize("/WS/Foo.txt")).toBe(path.normalize("/WS/Foo.txt"));
  });

  it.runIf(isWin)("equals 按大小写规则比较（Windows 路径）", () => {
    expect(pathsInsensitive.equals("C:\\WS", "c:\\ws\\")).toBe(true);
  });

  it("equals 按大小写规则比较（POSIX 路径）", () => {
    expect(pathsInsensitive.equals("/Home/X", "/home/x/")).toBe(true);
    expect(pathsSensitive.equals("/WS", "/ws")).toBe(false);
  });

  it.runIf(isWin)("isWithin：前缀陷阱 C:\\ws vs C:\\ws2", () => {
    expect(pathsInsensitive.isWithin("C:\\ws", "C:\\ws\\a.txt")).toBe(true);
    expect(pathsInsensitive.isWithin("C:\\ws", "c:\\WS")).toBe(true);
    expect(pathsInsensitive.isWithin("C:\\ws", "C:\\ws2\\a.txt")).toBe(false);
    expect(pathsInsensitive.isWithin("C:\\ws", "C:\\other")).toBe(false);
  });

  it("isWithin：前缀陷阱与 .. 词法回退（POSIX 路径）", () => {
    expect(pathsSensitive.isWithin("/home/x", "/home/x/a.txt")).toBe(true);
    expect(pathsInsensitive.isWithin("/Home/X", "/home/x")).toBe(true);
    expect(pathsSensitive.isWithin("/home/x", "/home/x2/a.txt")).toBe(false);
    // ".." 先经词法规范化：折回区内判在区内，跳出区外判在区外
    expect(pathsSensitive.isWithin("/home/x", "/home/x/../x/f")).toBe(true);
    expect(pathsSensitive.isWithin("/home/x", "/home/x/../y")).toBe(false);
  });

  it("isWithin 处理以分隔符结尾的根", () => {
    const root = isWin ? "C:\\" : "/";
    expect(pathsInsensitive.isWithin(root, isWin ? "C:\\x" : "/x")).toBe(true);
  });

  it("canonicalize 去掉 Windows 扩展前缀", () => {
    expect(pathsInsensitive.canonicalize("\\\\?\\C:\\WS\\a.txt")).toBe("c:\\ws\\a.txt");
  });
});

describe("FileSystem", () => {
  let dir: string;
  const nfs = createNodeFileSystem();

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-platform-"));
    await fs.writeFile(path.join(dir, "hello.txt"), "hi\nthere\n", "utf8");
    await fs.mkdir(path.join(dir, "sub"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("探测临时目录互不覆盖，递归清理不跟随外部链接", async () => {
    const first = await nfs.mkdtemp(path.join(dir, "probe-"));
    const second = await nfs.mkdtemp(path.join(dir, "probe-"));
    const outside = path.join(second, "keep.txt");
    await nfs.writeFile(outside, "must survive");
    await nfs.mkdir(path.join(first, "nested"));
    await nfs.writeFile(path.join(first, "nested", "agent.txt"), "temporary");
    await fs.symlink(second, path.join(first, "outside"), isWin ? "junction" : "dir");
    await nfs.rm(first, { recursive: true, force: true });
    expect(await nfs.exists(first)).toBe(false);
    expect(await nfs.readTextFile(outside)).toBe("must survive");
    await nfs.rm(second, { recursive: true, force: true });
    expect(await nfs.exists(second)).toBe(false);
  });

  it("readTextFile / stat / lstat / exists", async () => {
    expect(await nfs.readTextFile(path.join(dir, "hello.txt"))).toBe("hi\nthere\n");
    const st = await nfs.stat(path.join(dir, "hello.txt"));
    expect(st.type).toBe("file");
    expect(st.size).toBeGreaterThan(0);
    expect((await nfs.lstat(path.join(dir, "sub"))).type).toBe("directory");
    expect(await nfs.exists(path.join(dir, "nope"))).toBe(false);
    expect(await nfs.exists(path.join(dir, "hello.txt"))).toBe(true);
  });

  it("readdir 返回带类型的条目", async () => {
    const entries = await nfs.readdir(dir);
    const byName = new Map(entries.map((e) => [e.name, e.type]));
    expect(byName.get("hello.txt")).toBe("file");
    expect(byName.get("sub")).toBe("directory");
  });

  it("writeFile / appendFile / rename / unlink / fsync", async () => {
    const p = path.join(dir, "w.txt");
    await nfs.writeFile(p, "a");
    await nfs.appendFile(p, "b");
    expect(await nfs.readTextFile(p)).toBe("ab");
    const p2 = path.join(dir, "w2.txt");
    await nfs.rename(p, p2);
    expect(await nfs.exists(p)).toBe(false);
    await nfs.fsync(p2);
    await nfs.unlink(p2);
    expect(await nfs.exists(p2)).toBe(false);
  });
});

describe("resolveRealPath", () => {
  let root: string;
  let outside: string;
  const nfs = createNodeFileSystem();
  const platform = createPlatform();

  beforeAll(async () => {
    // realpath 化 tmpdir（Windows 上 temp 路径可能含 8.3 短名）
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-rp-ws-")));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-rp-out-")));
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "f.txt"), "x", "utf8");
    await fs.writeFile(path.join(outside, "secret.txt"), "s", "utf8");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("已存在文件解析为自身真实路径", async () => {
    const target = path.join(root, "sub", "f.txt");
    const resolved = await platform.resolveReal(target);
    expect(platform.paths.equals(resolved, await fs.realpath(target))).toBe(true);
  });

  it("不存在的尾巴：拼到最近已存在祖先的真实路径后", async () => {
    const target = path.join(root, "sub", "newdir", "new.txt");
    const resolved = await platform.resolveReal(target);
    const expected = path.join(await fs.realpath(path.join(root, "sub")), "newdir", "new.txt");
    expect(platform.paths.equals(resolved, expected)).toBe(true);
  });

  it("输入含 .. 时先做词法规范化再解析", async () => {
    const target = path.join(root, "sub", "..", "sub", "f.txt");
    const resolved = await platform.resolveReal(target);
    expect(
      platform.paths.equals(resolved, await fs.realpath(path.join(root, "sub", "f.txt"))),
    ).toBe(true);
  });

  it("链接指向工作区外 → 解析到区外真实路径", async () => {
    const link = path.join(root, "link-out");
    // Windows：junction 不需要特权；POSIX：目录符号链接
    await fs.symlink(outside, link, isWin ? "junction" : "dir");
    const resolved = await platform.resolveReal(path.join(link, "secret.txt"));
    expect(platform.paths.equals(resolved, path.join(outside, "secret.txt"))).toBe(true);
    // 入口在工作区内，解析后却在区外——权限层将据此拒绝
    expect(platform.paths.isWithin(root, resolved)).toBe(false);
    expect(platform.paths.isWithin(root, link)).toBe(true);
  });

  it("junction/symlink 解析到区内目标时仍在区内", async () => {
    const link = path.join(root, "link-in");
    await fs.symlink(path.join(root, "sub"), link, isWin ? "junction" : "dir");
    const resolved = await platform.resolveReal(path.join(link, "f.txt"));
    expect(platform.paths.equals(resolved, path.join(root, "sub", "f.txt"))).toBe(true);
    expect(platform.paths.isWithin(root, resolved)).toBe(true);
  });

  it("readdir 把链接报告为 symlink（枚举不跟随）", async () => {
    const entries = await nfs.readdir(root);
    const linkOut = entries.find((e) => e.name === "link-out");
    expect(linkOut?.type).toBe("symlink");
  });

  it("resolveRealPath 直接调用（platform 门面之外也可用）", async () => {
    const resolved = await resolveRealPath(nfs, platform.paths, path.join(root, "sub", "f.txt"));
    expect(platform.paths.isWithin(root, resolved)).toBe(true);
  });
});

describe("ProcessRunner 输出解码", () => {
  const ENV_KEY = "NOCTURNE_CONSOLE_ENCODING";
  const saved = process.env[ENV_KEY];

  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, ENV_KEY);
    else process.env[ENV_KEY] = saved;
  });

  async function collect(stream: AsyncIterable<string>): Promise<string> {
    let text = "";
    for await (const chunk of stream) text += chunk;
    return text;
  }

  it("codepageToEncodingLabel：已知代码页映射，未知回退 utf-8", () => {
    expect(codepageToEncodingLabel(936)).toBe("gbk");
    expect(codepageToEncodingLabel(65001)).toBe("utf-8");
    expect(codepageToEncodingLabel(437)).toBe("utf-8"); // 未映射的 OEM 页回退
  });

  it("NOCTURNE_CONSOLE_ENCODING=gbk 时按 GBK 解码", async () => {
    process.env[ENV_KEY] = "gbk";
    const runner = processes.wrap(createProcessRunner());
    // "中文" 的 GBK 字节序列
    const proc = runner.spawn(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from([0xD6,0xD0,0xCE,0xC4]))",
    ]);
    expect(await collect(proc.stdout)).toBe("中文");
    await proc.wait();
  });

  it("utf-8 时按 UTF-8 解码", async () => {
    process.env[ENV_KEY] = "utf-8";
    const runner = processes.wrap(createProcessRunner());
    const proc = runner.spawn(process.execPath, ["-e", 'process.stdout.write("中文")']);
    expect(await collect(proc.stdout)).toBe("中文");
    await proc.wait();
  });

  // 端到端：真实 chcp 探测 + cmd echo（仅在控制台能表示中文的代码页下断言内容）
  it.runIf(isWin)("cmd 输出按探测到的控制台代码页解码", async () => {
    const runner = processes.wrap(createProcessRunner());
    const chcp = runner.spawnShell("chcp");
    const cpText = await collect(chcp.stdout);
    await chcp.wait();
    const cp = Number(/(\d+)/.exec(cpText)?.[1]);
    expect(Number.isInteger(cp)).toBe(true);
    // 437/850 等代码页无法表示中文，cmd 端已降级为 "?"，不在此断言
    if (![936, 950, 932, 949, 65001].includes(cp)) return;
    const proc = runner.spawnShell("echo 中文测试");
    expect(await collect(proc.stdout)).toContain("中文测试");
    await proc.wait();
  });
});
