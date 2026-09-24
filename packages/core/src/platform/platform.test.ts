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
  resolveRealPath,
} from "./index.js";

const isWin = process.platform === "win32";
const pathsSensitive = createPathOps(true);
const pathsInsensitive = createPathOps(false);

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

  it("equals 按大小写规则比较", () => {
    expect(pathsInsensitive.equals("C:\\WS", "c:\\ws\\")).toBe(true);
    expect(pathsSensitive.equals("/WS", "/ws")).toBe(false);
  });

  it("isWithin：前缀陷阱 C:\\ws vs C:\\ws2", () => {
    expect(pathsInsensitive.isWithin("C:\\ws", "C:\\ws\\a.txt")).toBe(true);
    expect(pathsInsensitive.isWithin("C:\\ws", "c:\\WS")).toBe(true);
    expect(pathsInsensitive.isWithin("C:\\ws", "C:\\ws2\\a.txt")).toBe(false);
    expect(pathsInsensitive.isWithin("C:\\ws", "C:\\other")).toBe(false);
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
    const runner = createProcessRunner();
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
    const runner = createProcessRunner();
    const proc = runner.spawn(process.execPath, ["-e", 'process.stdout.write("中文")']);
    expect(await collect(proc.stdout)).toBe("中文");
    await proc.wait();
  });

  // 端到端：真实 chcp 探测 + cmd echo（仅在控制台能表示中文的代码页下断言内容）
  it.runIf(isWin)("cmd 输出按探测到的控制台代码页解码", async () => {
    const runner = createProcessRunner();
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
