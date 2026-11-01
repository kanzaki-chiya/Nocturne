import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, renderChangelog, renderDocMarkdown, slugifyHeading } from "../build-site.mjs";
import { headingCharacters } from "../subset-site-font.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let out;
let pages;
let version;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "nocturne-site-test-"));
  ({ version } = await buildSite(ROOT, out));
  pages = await Promise.all(
    ["index.html", "en/index.html"].map((file) => readFile(join(out, file), "utf8")),
  );
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("static homepage", () => {
  it("replaces every placeholder with the root package version", async () => {
    expect(version).toBe(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version);
    for (const html of pages) {
      expect(html).not.toContain("{{");
      expect(html).toContain(`/v${version}/Nocturne_${version}_x64-setup.exe`);
      expect(html).toContain(`npm install -g ./nctrn-${version}.tgz`);
      expect(html).toContain(`v${version}`);
      expect(html).not.toMatch(/<script\b|fonts\.googleapis|fonts\.gstatic/i);
    }
  });
  it("links the two languages to each other", () => {
    expect(pages[0]).toMatch(/href="en\/"[^>]*hreflang="en"/);
    expect(pages[1]).toMatch(/href="\.\.\/"[^>]*hreflang="zh-CN"/);
  });
  it("resolves all HTML and CSS local references, including anchors", async () => {
    async function checkReference(file, ref) {
      if (/^(?:https?:|mailto:|data:|\/\/)/.test(ref)) return;
      const [pathname, hash] = ref.split("#");
      let target = pathname ? resolve(dirname(file), pathname) : file;
      if ((await stat(target)).isDirectory()) target = join(target, "index.html");
      await access(target);
      if (hash && target.endsWith(".html"))
        expect(await readFile(target, "utf8")).toContain(`id="${hash}"`);
    }
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (/\.(html|css)$/.test(file)) {
          const text = await readFile(file, "utf8");
          const pattern = file.endsWith(".html")
            ? /(?:href|src)="([^"]+)"/g
            : /url\(["']?([^\s)"']+)["']?\)/g;
          for (const match of text.matchAll(pattern)) await checkReference(file, match[1]);
        }
      }
    }
    await walk(out);
  });
  it("renders the changelog page from CHANGELOG.md", async () => {
    const html = await readFile(join(out, "changelog/index.html"), "utf8");
    const source = await readFile(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(html).not.toContain("{{changelog");
    expect(html).toContain(`id="v${version}"`);
    expect(html.match(/class="release"/g)).toHaveLength(source.match(/^## /gm).length);
    expect(html.match(/<ul>/g)?.length).toBe(html.match(/<\/ul>/g)?.length);
    expect(html).not.toMatch(/<script\b/i);
    expect(pages[0]).toContain('href="changelog/"');
    expect(pages[1]).toContain('href="../changelog/"');
  });
  it("converts changelog markdown and escapes HTML", () => {
    const { index, body } = renderChangelog(
      [
        "# 更新日志",
        "",
        "## 1.0.0",
        "",
        "### 分组",
        "",
        "- **修复**：`<a>` & <b>",
        "  - 子项",
        "- 见 [说明](docs/a.md)",
        "",
        "段落",
      ].join("\n"),
    );
    expect(index).toBe('<a href="#v1.0.0">1.0.0</a>');
    expect(body).toContain("<strong>修复</strong>：<code>&lt;a&gt;</code> &amp; &lt;b&gt;");
    expect(body).toContain("<ul>\n<li>子项");
    expect(body).toContain("/blob/main/docs/a.md");
    expect(body.match(/<ul>/g)).toHaveLength(2);
    expect(body.match(/<\/ul>/g)).toHaveLength(2);
    expect(body).toContain("<p>段落</p>");
  });
  it("copies the custom domain", async () => {
    expect(await readFile(join(out, "CNAME"), "utf8")).toBe("nocturne.koxia.cn\n");
  });
  it("keeps the committed font subset in sync with the headings", async () => {
    expect((await readFile(join(out, "assets/fonts/characters.txt"), "utf8")).trim()).toBe(
      (await headingCharacters()).trim(),
    );
  });
});

describe("user docs", () => {
  it("renders every page in nav.json with matching h1, active nav, valid TOC anchors, and no scripts or placeholders", async () => {
    const nav = JSON.parse(await readFile(join(ROOT, "site-docs/nav.json"), "utf8"));
    const flat = nav.flatMap((group) => group.pages);
    expect(flat.length).toBeGreaterThan(0);

    for (const page of flat) {
      const htmlPath =
        page.slug === ""
          ? join(out, "docs/index.html")
          : join(out, "docs", page.slug, "index.html");
      const html = await readFile(htmlPath, "utf8");
      expect(html).not.toContain("{{");
      expect(html).not.toMatch(/<script\b/i);
      expect(html).toContain(`<h1>${page.title}</h1>`);

      // Top site nav highlights "文档" and sidebar nav highlights the current page
      const currentLinks = [
        ...html.matchAll(/<a\s+href="([^"]+)"\s+aria-current="page">([^<]+)<\/a>/g),
      ];
      expect(currentLinks.some((m) => m[2] === "文档")).toBe(true);
      expect(currentLinks.some((m) => m[2] === page.title)).toBe(true);

      // Every TOC anchor exists in the rendered article
      const tocSection = /<aside class="docs-toc"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? "";
      for (const match of tocSection.matchAll(/href="#([^"]+)"/g)) {
        expect(html).toContain(`id="${match[1]}"`);
      }
    }
  });

  it("rewrites internal .md links to relative site paths and deduplicates Chinese heading ids", () => {
    const knownFiles = new Set(["index.md", "providers.md", "config.md"]);
    const fromRoot = renderDocMarkdown(
      [
        "# 安装",
        "",
        "## 配置",
        "",
        "### 配置",
        "",
        "见 [连接服务商](providers.md) 与 [配置字段](./config.md#常用字段) 和 [安装](index.md#配置)。",
      ].join("\n"),
      { fromSlug: "", knownFiles },
    );
    expect(fromRoot.body).toContain('id="配置"');
    expect(fromRoot.body).toContain('id="配置-2"');
    expect(fromRoot.body).toContain('href="providers/"');
    expect(fromRoot.body).toContain('href="config/#常用字段"');
    expect(fromRoot.body).toContain('href="#配置"');

    const fromSub = renderDocMarkdown(
      ["# 连接服务商", "", "返回 [安装](index.md) 或去 [配置](config.md#分层)。"].join("\n"),
      { fromSlug: "providers", knownFiles },
    );
    expect(fromSub.body).toContain('href="../"');
    expect(fromSub.body).toContain('href="../config/#分层"');

    const seen = new Map();
    expect(slugifyHeading("常见问题", seen)).toBe("常见问题");
    expect(slugifyHeading("常见问题", seen)).toBe("常见问题-2");
    expect(slugifyHeading("常见问题", seen)).toBe("常见问题-3");
  });

  it("fails the build on raw HTML in Markdown or nav.json mismatch", async () => {
    expect(() =>
      renderDocMarkdown("# 标题\n\n<div>raw</div>\n", {
        fromSlug: "",
        knownFiles: new Set(["index.md"]),
      }),
    ).toThrow(/Raw HTML is not allowed/);

    expect(() =>
      renderDocMarkdown("# 标题\n\n段落含 <span>内联标签</span>。\n", {
        fromSlug: "",
        knownFiles: new Set(["index.md"]),
      }),
    ).toThrow(/Raw HTML is not allowed/);

    const tempRoot = await mkdtemp(join(tmpdir(), "nocturne-docs-fail-"));
    const tempOut = join(tempRoot, "dist");
    try {
      await cp(join(ROOT, "package.json"), join(tempRoot, "package.json"));
      await cp(join(ROOT, "CHANGELOG.md"), join(tempRoot, "CHANGELOG.md"));
      await cp(join(ROOT, "site"), join(tempRoot, "site"), { recursive: true });
      await cp(join(ROOT, "site-docs"), join(tempRoot, "site-docs"), { recursive: true });

      // Extra unlisted .md file should fail buildSite
      await writeFile(join(tempRoot, "site-docs/orphan.md"), "# 孤儿页\n");
      await expect(buildSite(tempRoot, tempOut)).rejects.toThrow(
        /not listed in site-docs\/nav\.json/,
      );
      await rm(join(tempRoot, "site-docs/orphan.md"));

      // Missing .md file referenced by nav.json should fail buildSite
      await writeFile(
        join(tempRoot, "site-docs/nav.json"),
        JSON.stringify([
          {
            group: "上手",
            pages: [
              { slug: "", title: "安装" },
              { slug: "missing-page", title: "缺失" },
            ],
          },
        ]),
      );
      await expect(buildSite(tempRoot, tempOut)).rejects.toThrow(/references missing file/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
