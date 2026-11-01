import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, renderChangelog } from "../build-site.mjs";
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
  it("uses the shared masthead navigation and download anchor", () => {
    const [zh, en] = pages;
    const nav = (html) => /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect(nav(zh)).toContain('href="docs/"');
    expect(nav(zh)).toContain('href="changelog/"');
    expect(nav(en)).toMatch(/href="\.\.\/docs\/"[^>]*hreflang="zh-CN"/);
    expect(nav(en)).toContain('href="../changelog/"');
    for (const html of pages) {
      expect(html).toContain('id="download"');
      expect(html).toContain('href="#download"');
      expect(html).not.toMatch(/#three|id="three"|#one|#two/);
      expect(html).toMatch(/<link rel="stylesheet" href="(?:\.\.\/)?assets\/base\.css"/);
    }
  });
  it("offers a light variant for every themed screenshot", () => {
    for (const html of pages) {
      const pictures = html.match(/<picture>[\s\S]*?<\/picture>/g) ?? [];
      expect(pictures.length).toBeGreaterThanOrEqual(5);
      for (const picture of pictures) {
        expect(picture).toMatch(
          /<source\s+media="\(prefers-color-scheme: light\)"\s+srcset="[^"]+\.webp"/,
        );
        expect(picture).toMatch(/<img\s[^>]*src="[^"]+\.webp"[^>]*width="\d+"[^>]*height="\d+"/);
      }
    }
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
            ? /(?:href|src|srcset)="([^"]+)"/g
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
